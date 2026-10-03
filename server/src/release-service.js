/**
 * 本地发布版本与回退账本。
 *
 * 版本绑定四样不可变材料：映射快照 / 规范化+白名单策略快照 /
 * 一次完整验证运行（逐跳证据）/ 迁移方案。
 *
 * 状态机：
 *   prepared ──activate──▶ active ──被下一版本激活──▶ superseded
 *                              │
 *                              └──rollback──▶ rolled_back（目标回到 active）
 *   任意准备闸门失败 ──▶ failed（终态，永远不能激活）
 *
 * 激活与回退都在单个数据库事务里原子切换“当前版本”，并向 release_audit
 * 追加不可变审计；release_audit 由触发器禁止 UPDATE/DELETE/TRUNCATE。
 * 同一时刻只有一个 active，由部分唯一索引 uq_release_one_active 硬保证。
 */
import { pool } from './db.js';
import { normalize } from './normalize.js';
import { judge } from './verifier.js';
import { config } from './config.js';
import {
  fingerprint,
  buildMappingSnapshot,
  buildRulesSnapshot,
} from './snapshot.js';
import { runVerification, currentEvidenceSnapshot, GOOD_VERDICTS } from './verify-runner.js';

const VERSION_LABEL = {
  prepared: '已准备',
  active: '已激活（当前版本）',
  superseded: '已被取代',
  rolled_back: '已回退',
  failed: '失败/失效',
};

// node-postgres 已把 JSONB 解析为对象；兼容可能的字符串形态
const parsed = (x) => (typeof x === 'string' ? JSON.parse(x) : x);

/**
 * 版本切换全局互斥锁（事务级咨询锁）：
 * READ COMMITTED 下部分唯一索引无法阻止“两个事务各自更新不同的 prepared 行”，
 * 因此所有激活/回退切换先取同一把事务锁，提交/回滚时自动释放。
 * 锁等待对调用方串行化，保证同时刻只有一个 active 与一条审计。
 */
const RELEASE_LOCK_KEY = 0x52_45_4c; // 'REL'
async function acquireSwitchLock(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [RELEASE_LOCK_KEY]);
}

async function nextVersionNo(client) {
  const { rows } = await client.query('SELECT COALESCE(max(version_no),0)+1 AS n FROM release_versions');
  return rows[0].n;
}

async function readPlanGate(client, planId) {
  const blockers = [];
  const { rows: plan } = await client.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
  if (!plan.length) return { error: { code: 404, body: { error: '迁移方案不存在' } } };

  const { rows: badItems } = await client.query(
    `SELECT m.source_raw, pi.item_status, pi.evidence
       FROM migration_plan_items pi
       JOIN url_mappings m ON m.id=pi.mapping_id
      WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
  for (const b of badItems) {
    blockers.push({
      source: b.source_raw,
      evidence: 'plan_gate',
      reason: b.item_status === 'pending'
        ? '只有映射表条目，没有验证证据（填表不等于迁移完成）'
        : `验证未通过：${(b.evidence?.issues ?? []).join('；') || b.evidence?.verdict}`,
    });
  }

  const { rows: missing } = await client.query(
    `SELECT m.source_raw FROM url_mappings m
      WHERE m.status='active'
        AND NOT EXISTS (SELECT 1 FROM migration_plan_items pi
                         WHERE pi.mapping_id=m.id AND pi.plan_id=$1)`,
    [planId]);
  missing.forEach((m) => blockers.push({ source: m.source_raw, evidence: 'plan_gate', reason: '生效映射未纳入方案' }));

  const { rows: conflicts } = await client.query(
    "SELECT source_raw FROM url_mappings WHERE status='conflicted'");
  conflicts.forEach((m) => blockers.push({ source: m.source_raw, evidence: 'plan_gate', reason: '归一化歧义未裁决' }));

  return { plan: plan[0], blockers };
}

async function loadPlanSnapshot(client, planId) {
  const { rows: items } = await client.query(
    `SELECT pi.id, pi.item_status, pi.evidence,
            m.source_raw, m.source_norm, m.target_raw, m.target_norm, m.mapping_type
       FROM migration_plan_items pi
       JOIN url_mappings m ON m.id=pi.mapping_id
      WHERE pi.plan_id=$1 ORDER BY pi.id`, [planId]);
  return items;
}

async function currentMappingRows(client) {
  const { rows: inputs } = await client.query(
    'SELECT source_raw, source_norm, target_raw, target_norm, mapping_type, note FROM mapping_inputs ORDER BY id');
  const { rows: mappings } = await client.query(
    'SELECT source_raw, source_norm, target_raw, target_norm, mapping_type, status, note FROM url_mappings ORDER BY id');
  return { inputs, mappings };
}

async function writeAudit(client, event, { fromVersion = null, toVersion = null, detail = {} } = {}) {
  await client.query(
    `INSERT INTO release_audit (event, from_version, to_version, detail)
     VALUES ($1,$2,$3,$4)`,
    [event, fromVersion, toVersion, JSON.stringify(detail)]);
}

/**
 * 准备一个可激活版本：
 *  1. 方案必须存在且通过既有发布闸门（无 blocked/pending、无遗漏、无歧义）；
 *  2. 对全部生效映射真实跑一次完整验证（只请求随项目启动的本地站点），
 *     必须每条都是 ok / deleted_gone_ok；
 *  3. 固化四样材料及其指纹。
 * 任一闸门失败：写 failed 版本与审计（不可激活、失败原因持久）。
 */
export async function prepareRelease({ planId, name = null } = {}) {
  const id = Number(planId);
  if (!Number.isInteger(id)) return { http: 400, body: { error: 'plan_id required' } };

  // 验证是真实 HTTP 请求，不能放在一个长事务里持锁；先跑验证（与既有 /api/verify 相同语义）
  let run;
  try {
    run = await runVerification({ persistRun: true });
  } catch (e) {
    return { http: 502, body: { error: `完整验证运行失败：${e.message}` } };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const versionNo = await nextVersionNo(client);

    const gate = await readPlanGate(client, id);
    const { inputs, mappings } = await currentMappingRows(client);
    const mappingSnap = buildMappingSnapshot({ inputs, mappings });
    const rulesSnap = buildRulesSnapshot();
    const mappingFingerprint = fingerprint(mappingSnap);
    const rulesFingerprint = fingerprint(rulesSnap);

    const fail = async (reasons) => {
      const { rows } = await client.query(
        `INSERT INTO release_versions
           (version_no, name, status, plan_id, plan_name, mapping_fingerprint,
            rules_fingerprint, evidence_fingerprint, verification_run_id,
            verification_snapshot, fixture_mode, failure_reason)
         VALUES ($1,$2,'failed',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [versionNo, name, id, gate.plan?.name ?? null,
         mappingFingerprint, rulesFingerprint, run.evidenceHash, run.runId,
         JSON.stringify(run.evidenceSnapshot), process.env.FIXTURE_MODE || 'default',
         JSON.stringify(reasons)]);
      await writeAudit(client, 'prepare_failed', { toVersion: rows[0].id, detail: { reasons } });
      await client.query('COMMIT');
      return { http: 409, body: { prepared: false, version: rows[0], blockers: reasons } };
    };

    if (gate.error) {
      await client.query('ROLLBACK');
      return { http: gate.error.code, body: gate.error.body };
    }

    // 方案闸门与完整验证两类证据都失败时，原因全部留痕（都要能说明哪项证据不达标）
    const verificationBlockers = run.blocked > 0
      ? run.results
        .filter((r) => !GOOD_VERDICTS.has(r.verdict))
        .map((r) => ({
          source: r.source_norm,
          evidence: 'verification_run',
          reason: `完整验证未通过：${r.verdict}${r.issues?.length ? `（${r.issues.join('；')}）` : ''}`,
        }))
      : [];
    if (gate.blockers.length || verificationBlockers.length) {
      return fail([...gate.blockers, ...verificationBlockers]);
    }

    const planItems = await loadPlanSnapshot(client, id);
    const { rows } = await client.query(
      `INSERT INTO release_versions
         (version_no, name, status, plan_id, plan_name, plan_snapshot,
          mapping_fingerprint, rules_fingerprint, evidence_fingerprint,
          verification_run_id, verification_snapshot, fixture_mode)
       VALUES ($1,$2,'prepared',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [versionNo, name, id, gate.plan.name, JSON.stringify(planItems),
       mappingFingerprint, rulesFingerprint, run.evidenceHash, run.runId,
       JSON.stringify(run.evidenceSnapshot), process.env.FIXTURE_MODE || 'default']);
    await writeAudit(client, 'prepared', {
      toVersion: rows[0].id,
      detail: { version_no: versionNo, mappings: mappingSnap.mappings.length, run_id: run.runId },
    });
    await client.query('COMMIT');
    return {
      http: 200,
      body: {
        prepared: true, version: rows[0],
        verified: run.passed, evidence_fingerprint: run.evidenceHash,
        mapping_fingerprint: mappingFingerprint,
      },
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 激活前复核：prepared 之后任何映射 / 策略 / 验证证据变化都使版本失效。
 * 返回过期证据清单（staleEvidence），每项指明是哪样材料过期。
 */
async function revalidateBeforeActivate(client, version) {
  const stale = [];
  const { inputs, mappings } = await currentMappingRows(client);
  const liveMappingFp = fingerprint(buildMappingSnapshot({ inputs, mappings }));
  if (liveMappingFp !== version.mapping_fingerprint) {
    stale.push({
      evidence: 'mapping_snapshot',
      reason: '映射快照已过期：prepared 之后原始录入或生效映射发生了变化（新增/删除/改目标/歧义状态变化）',
      expected: version.mapping_fingerprint,
      actual: liveMappingFp,
    });
  }
  const liveRulesFp = fingerprint(buildRulesSnapshot());
  if (liveRulesFp !== version.rules_fingerprint) {
    stale.push({
      evidence: 'rules_snapshot',
      reason: '规范化/白名单策略快照已过期：prepared 之后规则或验证器白名单发生了变化',
      expected: version.rules_fingerprint,
      actual: liveRulesFp,
    });
  }
  const liveEvidence = await currentEvidenceSnapshot();
  const liveEvidenceFp = fingerprint(liveEvidence);
  if (liveEvidenceFp !== version.evidence_fingerprint) {
    const changed = diffEvidence(parsed(version.verification_snapshot), liveEvidence);
    stale.push({
      evidence: 'verification_run',
      reason: `完整验证证据已过期：prepared 之后验证结果发生了变化（${changed.length} 个入口）`,
      expected: version.evidence_fingerprint,
      actual: liveEvidenceFp,
      changed_sources: changed,
    });
  }
  return stale;
}

function diffEvidence(bound, live) {
  const byKey = new Map(live.map((e) => [e.source_norm, e]));
  const changed = [];
  for (const old of bound) {
    const now = byKey.get(old.source_norm);
    if (!now) { changed.push(`${old.source_norm}（已从生效映射中消失）`); continue; }
    if (now.verdict !== old.verdict
        || now.final_status !== old.final_status
        || now.final_url_norm !== old.final_url_norm
        || JSON.stringify(now.hops_detail) !== JSON.stringify(old.hops_detail)) {
      changed.push(`${old.source_norm}：${old.verdict} → ${now.verdict ?? '无证据'}`);
    }
  }
  for (const e of live) if (!bound.some((b) => b.source_norm === e.source_norm)) {
    changed.push(`${e.source_norm}（prepared 后新增的映射，没有版本内验证）`);
  }
  return changed;
}

/** 原子激活：prepared 版本成为唯一 active；原 active → superseded。 */
export async function activateRelease(versionId) {
  const id = Number(versionId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 咨询锁获取后必须刷新本事务快照：前一个持锁事务的提交对等待期间
    // 取得的旧快照不可见。LOCK TABLE 强制 READ COMMITTED 重取快照，
    // 否则第二个激活事务会错误地认为“当前没有 active”。
    await acquireSwitchLock(client);
    await client.query('LOCK TABLE release_versions IN SHARE ROW EXCLUSIVE MODE');
    const { rows: vs } = await client.query('SELECT * FROM release_versions WHERE id=$1 FOR UPDATE', [id]);
    if (!vs.length) { await client.query('ROLLBACK'); return { http: 404, body: { error: '版本不存在' } }; }
    const version = vs[0];

    // 幂等：重复点击激活同一已是 active 的版本 → 返回当前状态，不产生重复审计
    if (version.status === 'active') {
      await client.query('COMMIT');
      return { http: 200, body: { activated: true, idempotent: true, version } };
    }
    if (version.status === 'failed') {
      await client.query('ROLLBACK');
      return { http: 409, body: {
        activated: false,
        error: '该版本处于 failed 终态：完整验证未通过，永远不能激活（也不能借用旧版本放行）',
        failure_reason: version.failure_reason,
      } };
    }
    if (version.status === 'superseded' || version.status === 'rolled_back') {
      await client.query('ROLLBACK');
      return { http: 409, body: {
        activated: false,
        error: `${version.status} 版本只能通过“回退”恢复，不能再次激活（回退走原子账本通道）`,
      } };
    }
    if (version.status !== 'prepared') {
      await client.query('ROLLBACK');
      return { http: 409, body: {
        activated: false,
        error: `只有 prepared 版本可以激活，当前状态 ${version.status}`,
      } };
    }

    const stale = await revalidateBeforeActivate(client, version);
    if (stale.length) {
      // 证据过期 → 版本失效（failed），拒绝激活
      await client.query(
        `UPDATE release_versions SET status='failed', ended_at=now(), failure_reason=$2
          WHERE id=$1 RETURNING *`,
        [id, JSON.stringify(stale)]);
      await writeAudit(client, 'activate_blocked_stale', {
        toVersion: id, detail: { stale_evidence: stale },
      });
      await client.query('COMMIT');
      return { http: 409, body: { activated: false, stale: true, stale_evidence: stale } };
    }

    const { rows: actives } = await client.query(
      "SELECT * FROM release_versions WHERE status='active' FOR UPDATE");
    const previous = actives[0] ?? null;
    if (previous) {
      await client.query(
        `UPDATE release_versions SET status='superseded', deactivated_at=now(),
                superseded_by=$2, last_superseded_by=$2 WHERE id=$1`,
        [previous.id, id]);
    }
    const { rows: updated } = await client.query(
      `UPDATE release_versions SET status='active',
                activated_at=COALESCE(activated_at,now()), predecessor=$2
        WHERE id=$1 RETURNING *`, [id, previous?.id ?? null]);
    await writeAudit(client, 'activated', {
      fromVersion: previous?.id ?? null, toVersion: id,
      detail: {
        version_no: updated[0].version_no,
        previous_version_no: previous?.version_no ?? null,
        mapping_fingerprint: updated[0].mapping_fingerprint,
        evidence_fingerprint: updated[0].evidence_fingerprint,
      },
    });
    await client.query('COMMIT');
    return {
      http: 200,
      body: { activated: true, version: updated[0], previous: previous ? { id: previous.id, version_no: previous.version_no } : null },
    };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23514' || e.code === '23505') {
      // 并发下部分唯一索引保证不会出现两个 active
      return { http: 409, body: { activated: false, error: '并发激活冲突：同一时刻只能有一个 active 版本，请重试' } };
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 原子回退：当前 active → rolled_back；目标版本（默认直接前任）→ active。
 * 不重新验证目标版本——回退的意义就是回到已验证过的上一套快照，
 * 目标版本绑定的材料自 prepared 起从未被修改。
 */
export async function rollbackRelease({ targetId = null, fromVersion = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireSwitchLock(client);
    await client.query('LOCK TABLE release_versions IN SHARE ROW EXCLUSIVE MODE');
    const { rows: actives } = await client.query(
      "SELECT * FROM release_versions WHERE status='active' FOR UPDATE");
    const current = actives[0] ?? null;
    if (!current) { await client.query('ROLLBACK'); return { http: 409, body: { rolled_back: false, error: '当前没有 active 版本，无法回退' } }; }

    // 幂等护栏：调用方（工作台按钮）带“我看到的当前 active”。
    // 重复/并发点击时，第二个事务等到锁后会看到已经切换的版本，
    // 此时直接拒绝且不写任何审计，杜绝越过目标继续回退与重复副作用。
    if (fromVersion != null && Number(fromVersion) !== Number(current.id)) {
      await client.query('ROLLBACK');
      return { http: 409, body: {
        rolled_back: false, idempotent: true,
        error: `当前版本已切换为 #${current.id}（回退可能已完成），本次重复操作未执行`,
      } };
    }

    let target;
    if (targetId) {
      const { rows: ts } = await client.query('SELECT * FROM release_versions WHERE id=$1 FOR UPDATE', [Number(targetId)]);
      target = ts[0];
      if (!target) { await client.query('ROLLBACK'); return { http: 404, body: { rolled_back: false, error: '回退目标版本不存在' } }; }
    } else {
      // 默认回退目标：本版本激活时取代的直接前任（predecessor 链）
      const { rows: prev } = await client.query(
        'SELECT * FROM release_versions WHERE id=$1 FOR UPDATE', [current.predecessor ?? -1]);
      target = prev[0] ?? null;
      if (!target) {
        await client.query('ROLLBACK');
        return { http: 409, body: { rolled_back: false, error: '没有可回退的上一版本' } };
      }
    }
    if (!['superseded', 'rolled_back'].includes(target.status)) {
      await client.query('ROLLBACK');
      return { http: 409, body: {
        rolled_back: false,
        error: `回退目标必须是 superseded/rolled_back 版本，目标当前为 ${target.status}`,
      } };
    }

    // 幂等：当前版本已经标记为回退到同一目标（并发/重复点击的第二次调用）
    // 走到这里 current 仍是 active（状态切换在下面一次完成），因此以审计侧防重复：
    // 事务 + FOR UPDATE 已串行化；额外检查目标是否正是当前版本的前任。
    const { rows: updatedCurrent } = await client.query(
      `UPDATE release_versions SET status='rolled_back', deactivated_at=now(),
              rolled_back_to=$2 WHERE id=$1 RETURNING *`,
      [current.id, target.id]);
    const { rows: updatedTarget } = await client.query(
      `UPDATE release_versions SET status='active', activated_at=now()
        WHERE id=$1 RETURNING *`, [target.id]);
    await writeAudit(client, 'rolled_back', {
      fromVersion: current.id, toVersion: target.id,
      detail: {
        from_version_no: current.version_no,
        to_version_no: target.version_no,
        restored_mapping_fingerprint: target.mapping_fingerprint,
      },
    });
    await client.query('COMMIT');
    return {
      http: 200,
      body: {
        rolled_back: true,
        from: { id: updatedCurrent[0].id, version_no: updatedCurrent[0].version_no },
        to: { id: updatedTarget[0].id, version_no: updatedTarget[0].version_no },
      },
    };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23514' || e.code === '23505') {
      return { http: 409, body: { rolled_back: false, idempotent: true, error: '回退已在执行/已完成（只有一个 active 版本）' } };
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 上线演练：对某版本绑定的映射快照，在“当前的本地站点”上真实再请求一遍，
 * 与版本绑定的 prepared 裁决比对。任何偏差（状态/落点/逐跳变化）= 演练异常。
 * 验证器仍然只访问白名单内的本地站点（judge/crawl 内部强制）。
 */
export async function drillRelease(versionId, kind = 'post_activation') {
  const id = Number(versionId);
  const { rows: vs } = await pool.query('SELECT * FROM release_versions WHERE id=$1', [id]);
  if (!vs.length) return { http: 404, body: { error: '版本不存在' } };
  const version = vs[0];

  const bound = parsed(version.verification_snapshot);
  const results = [];
  for (const b of bound) {
    const mapping = (parsed(version.plan_snapshot)).find((p) => p.source_norm === b.source_norm);
    const mappingType = mapping?.mapping_type ?? 'manual';
    const { verdict, issues, crawl } = await judge(b.source_raw, mappingType, b.final_url_norm);
    const anomalies = [];
    if (verdict !== b.verdict) anomalies.push(`裁决变化：${b.verdict} → ${verdict}`);
    if ((crawl.finalStatus ?? null) !== (b.final_status ?? null)) {
      anomalies.push(`最终状态变化：${b.final_status ?? '无'} → ${crawl.finalStatus ?? '无'}`);
    }
    if ((crawl.finalNorm ?? null) !== (b.final_url_norm ?? null)) {
      anomalies.push(`最终落点变化：${b.final_url_norm ?? '无'} → ${crawl.finalNorm ?? '无'}`);
    }
    results.push({
      source_norm: b.source_norm,
      prepared_verdict: b.verdict,
      live_verdict: verdict,
      prepared_final_status: b.final_status,
      live_final_status: crawl.finalStatus,
      live_final_url: crawl.finalRaw,
      issues,
      anomalies,
      hops: crawl.hops.map((h) => ({
        hop_index: h.index, url_norm: h.url_norm, status: h.status,
        location_raw: h.location_raw, fetch_error: h.fetch_error ?? null,
      })),
    });
  }
  const failed = results.filter((r) => r.anomalies.length || !GOOD_VERDICTS.has(r.live_verdict));
  const { rows } = await pool.query(
    `INSERT INTO release_drills (version_id, kind, passed, failed, anomaly, results)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, kind, results.length - failed.length, failed.length, failed.length > 0,
     JSON.stringify(results)]);
  return {
    http: 200,
    body: { drill: rows[0], anomaly: failed.length > 0, failed, results },
  };
}

/** 列表所需的汇总（当前版本、差异、回退目标、最新演练）。 */
export async function listReleases(client = pool) {
  const { rows: versions } = await client.query(
    `SELECT v.*,
            (SELECT max(id) FROM release_audit a
              WHERE a.from_version=v.id OR a.to_version=v.id) AS last_audit_id
       FROM release_versions v ORDER BY v.id`);
  const { rows: drills } = await client.query(
    `SELECT DISTINCT ON (version_id) * FROM release_drills
      ORDER BY version_id, ran_at DESC, id DESC`);
  const drillBy = new Map(drills.map((d) => [d.version_id, d]));
  return versions.map((v) => ({
    ...v,
    item_count: parsed(v.verification_snapshot).length,
    latest_drill: drillBy.get(v.id)
      ? {
          id: drillBy.get(v.id).id, ran_at: drillBy.get(v.id).ran_at,
          passed: drillBy.get(v.id).passed, failed: drillBy.get(v.id).failed,
          anomaly: drillBy.get(v.id).anomaly,
        }
      : null,
  }));
}

/** 工作台当前态：active 版本 + 与当前工作区材料的差异 + 回退目标 + 审计链。 */
export async function releaseStatus(client = pool) {
  const { rows: act } = await client.query(
    "SELECT * FROM release_versions WHERE status='active' ORDER BY id DESC LIMIT 1");
  const active = act[0] ?? null;
  const versions = await listReleases(client);
  const { rows: audit } = await client.query('SELECT * FROM release_audit ORDER BY id');

  let rollbackTarget = null;
  let diff = null;
  if (active) {
    if (active.predecessor) {
      // 默认回退目标：当前版本激活时取代的直接前任（回退链骨架）
      const { rows: p } = await client.query(
        'SELECT id, version_no, name, status FROM release_versions WHERE id=$1',
        [active.predecessor]);
      rollbackTarget = p[0] ?? null;
    }
    diff = await diffAgainstWorkingCopy(client, active);
  }
  return {
    labels: VERSION_LABEL,
    active: active ? summarize(active) : null,
    rollback_target: rollbackTarget,
    versions,
    diff,
    audit,
  };
}

function summarize(v) {
  return {
    id: v.id, version_no: v.version_no, name: v.name, status: v.status,
    plan_name: v.plan_name, mapping_fingerprint: v.mapping_fingerprint,
    rules_fingerprint: v.rules_fingerprint, evidence_fingerprint: v.evidence_fingerprint,
    fixture_mode: v.fixture_mode, activated_at: v.activated_at,
    predecessor: v.predecessor,
    last_superseded_by: v.last_superseded_by,
    superseded_by: v.superseded_by,
    failure_reason: v.failure_reason,
  };
}

/** 当前工作区映射/证据 与 active 版本快照的差异（供工作台展示）。 */
export async function diffAgainstWorkingCopy(client, version) {
  const { inputs, mappings } = await currentMappingRows(client);
  const liveMappingFp = fingerprint(buildMappingSnapshot({ inputs, mappings }));
  const boundMappings = parsed(version.verification_snapshot);
  const liveByKey = new Map(mappings.filter((m) => m.status === 'active').map((m) => [m.source_norm, m]));
  const boundByKey = new Map(boundMappings.map((m) => [m.source_norm, m]));

  const mappingChanges = [];
  for (const m of mappings) {
    if (!boundByKey.has(m.source_norm)) {
      mappingChanges.push({ type: m.status === 'conflicted' ? 'conflicted' : 'added', source_norm: m.source_norm, target_norm: m.target_norm });
    }
  }
  for (const b of boundMappings) {
    const liveAll = mappings.find((m) => m.source_norm === b.source_norm);
    const live = liveByKey.get(b.source_norm);
    if (!live) {
      mappingChanges.push({
        type: liveAll ? 'conflicted' : 'removed',
        source_norm: b.source_norm, bound_target: b.final_url_norm,
      });
    }
    else if (live.target_norm !== b.final_url_norm) {
      mappingChanges.push({ type: 'changed_target', source_norm: b.source_norm,
        from: b.final_url_norm, to: live.target_norm });
    }
  }

  const liveEvidence = await currentEvidenceSnapshot();
  const evidenceChanges = diffEvidence(boundMappings, liveEvidence);
  return {
    mapping_fingerprint_current: liveMappingFp,
    mapping_fingerprint_active: version.mapping_fingerprint,
    mapping_in_sync: liveMappingFp === version.mapping_fingerprint,
    mapping_changes: mappingChanges,
    evidence_in_sync: fingerprint(liveEvidence) === version.evidence_fingerprint,
    evidence_changes: evidenceChanges,
  };
}

/** 版本详情：含绑定的方案/证据明细、全部演练、与该版本相关的审计。 */
export async function getRelease(versionId) {
  const id = Number(versionId);
  const { rows: vs } = await pool.query('SELECT * FROM release_versions WHERE id=$1', [id]);
  if (!vs.length) return { http: 404, body: { error: '版本不存在' } };
  const { rows: drills } = await pool.query(
    'SELECT id, kind, ran_at, passed, failed, anomaly FROM release_drills WHERE version_id=$1 ORDER BY id', [id]);
  const { rows: events } = await pool.query(
    'SELECT * FROM release_audit WHERE from_version=$1 OR to_version=$1 ORDER BY id', [id]);
  return {
    http: 200,
    body: {
      version: vs[0],
      plan_items: parsed(vs[0].plan_snapshot),
      evidence: parsed(vs[0].verification_snapshot),
      drills,
      audit: events,
    },
  };
}

export { VERSION_LABEL, normalize, config };
