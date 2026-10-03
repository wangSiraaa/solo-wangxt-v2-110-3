/**
 * 本地发布版本与回退账本服务。
 *
 * 状态机：prepared ──activate──▶ active ──被下一版本取代──▶ superseded
 *             │                      │
 *             └─漂移/非法激活─▶ failed └─rollback─▶ rolled_back
 *                                    （同时目标 superseded ─▶ active/reactivated）
 *
 * 原子性：activate/rollback 的全部状态切换 + release_audit 写入在同一个
 * 事务里提交；同一时刻至多一个 active 由数据库部分唯一索引兜底，
 * 重复点击/并发请求只会有一次生效，其余幂等返回，不产生重复审计。
 */
import { pool } from './db.js';
import { normalize, carryTrackers } from './normalize.js';
import { rulesSnapshot } from './policy.js';
import { fingerprint } from './fingerprint.js';
import {
  runVerification, verificationFingerprint, summarize, GOOD_VERDICTS,
} from './verify-runner.js';

// ---- 快照构建 ----------------------------------------------------------

function iso(v) {
  return v instanceof Date ? v.toISOString() : v ?? null;
}

function plainInput(r) {
  return {
    id: r.id, source_raw: r.source_raw, source_norm: r.source_norm,
    target_raw: r.target_raw, target_norm: r.target_norm,
    mapping_type: r.mapping_type, note: r.note ?? null,
    received_at: iso(r.received_at),
  };
}

function plainMapping(r) {
  return {
    id: r.id, source_raw: r.source_raw, source_norm: r.source_norm,
    target_raw: r.target_raw, target_norm: r.target_norm,
    mapping_type: r.mapping_type, status: r.status, note: r.note ?? null,
    created_at: iso(r.created_at),
  };
}

function plainAmbiguity(r) {
  return {
    source_norm: r.source_norm,
    input_count: Number(r.input_count),
    target_variants: Number(r.target_variants),
    source_forms: r.source_forms,
    targets: r.targets,
  };
}

export async function gatherMappingsSnapshot(client = pool) {
  const { rows: inputs } = await client.query(
    'SELECT * FROM mapping_inputs ORDER BY id');
  const { rows: mappings } = await client.query(
    'SELECT * FROM url_mappings ORDER BY id');
  const { rows: ambiguities } = await client.query(
    'SELECT * FROM mapping_ambiguities ORDER BY source_norm');
  const snapshot = {
    taken_at: new Date().toISOString(),
    inputs: inputs.map(plainInput),
    mappings: mappings.map(plainMapping),
    ambiguities: ambiguities.map(plainAmbiguity),
  };
  // 指纹只覆盖实际内容，不含 taken_at（否则每次重建都“漂移”）
  const hash = fingerprint('mappings', {
    inputs: snapshot.inputs, mappings: snapshot.mappings,
    ambiguities: snapshot.ambiguities,
  });
  return { snapshot, hash };
}

export function currentRulesSnapshot() {
  const snapshot = rulesSnapshot();
  return { snapshot, hash: fingerprint('rules', snapshot) };
}

async function buildPlanItems(client, planId) {
  const { rows: ms } = await client.query(
    `SELECT m.*, v.verdict, v.issues, v.final_status, v.final_url_raw,
            v.final_url_norm, v.hops, v.tracker_preserved
       FROM url_mappings m
       LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
      WHERE m.status='active' ORDER BY m.id`);
  const items = [];
  for (const m of ms) {
    const good = m.verdict === 'ok' || m.verdict === 'deleted_gone_ok';
    const { rows: ins } = await client.query(
      'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 ORDER BY id LIMIT 1',
      [m.source_norm]);
    const proposed = m.mapping_type === 'deleted'
      ? null
      : carryTrackers(ins[0].source_raw, m.target_raw);
    const evidence = {
      verdict: m.verdict ?? null,
      issues: m.issues ?? [],
      final_status: m.final_status ?? null,
      final_url: m.final_url_raw ?? null,
      hops: m.hops ?? 0,
      tracker_preserved: m.tracker_preserved ?? null,
      proposed_redirect_url: proposed,
    };
    const { rows } = await client.query(
      `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [planId, m.id,
       good ? 'verified' : m.verdict ? 'blocked' : 'pending',
       JSON.stringify(evidence)]);
    items.push({
      id: rows[0].id, mapping_id: m.id,
      source_raw: m.source_raw, source_norm: m.source_norm,
      target_raw: m.target_raw, target_norm: m.target_norm,
      mapping_type: m.mapping_type,
      item_status: good ? 'verified' : m.verdict ? 'blocked' : 'pending',
      evidence,
    });
  }
  return items;
}

async function planSnapshot(client, planId, items) {
  const { rows } = await client.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
  return {
    plan: {
      id: rows[0].id, name: rows[0].name, status: rows[0].status,
      created_at: iso(rows[0].created_at),
    },
    items,
  };
}

// ---- 漂移检测 ----------------------------------------------------------

/**
 * 用当前数据库实况重建三类指纹，与 prepared 时冻结的对比。
 * 返回 stale 明细：任何一项非空都意味着版本必须拒绝激活。
 */
export async function checkFreshness(client, release) {
  const { snapshot: liveMappings, hash: liveMappingsHash } =
    await gatherMappingsSnapshot(client);
  const { hash: liveRulesHash } = currentRulesSnapshot();

  // 验证结果漂移：以冻结版本的每条源键，取当前 live 裁决重建 items，
  // 与运行指纹同形比较。没有裁决（映射被删/未验证）也算过期。
  const frozenKeys = release.mappings_snapshot.mappings.map((m) => m.source_norm);
  const liveVerdictItems = [];
  if (liveMappingsHash === release.mappings_fingerprint) {
    // 映射完全一致时才有比较意义；不一致本身已构成过期
    const { rows } = await client.query(
      'SELECT * FROM verification_verdicts ORDER BY source_norm');
    const byKey = new Map(rows.map((r) => [r.source_norm, r]));
    for (const key of frozenKeys) {
      const v = byKey.get(key);
      if (!v) {
        liveVerdictItems.push({ source_norm: key, missing: true });
        continue;
      }
      liveVerdictItems.push({
        source_norm: v.source_norm,
        source_raw: v.source_raw,
        final_url_raw: v.final_url_raw,
        final_url_norm: v.final_url_norm,
        final_status: v.final_status,
        hops: v.hops,
        tracker_preserved: v.tracker_preserved,
        verdict: v.verdict,
        issues: v.issues,
      });
    }
  }
  const liveVerificationHash = fingerprint('verification-run', {
    runId: release.verification_run_id,
    items: liveVerdictItems
      .map((i) => ({ ...i }))
      .sort((a, b) => (a.source_norm < b.source_norm ? -1 : 1)),
  });

  const stale = { mappings: [], rules: false, verification: [] };

  if (liveMappingsHash !== release.mappings_fingerprint) {
    stale.mappings = diffMappings(release.mappings_snapshot, liveMappings);
  }
  if (liveRulesHash !== release.rules_fingerprint) stale.rules = true;
  if (liveMappingsHash === release.mappings_fingerprint &&
      liveVerificationHash !== release.verification_fingerprint) {
    const frozen = new Map(
      (await runItems(client, release.verification_run_id)).map((i) => [i.source_norm, i]));
    for (const cur of liveVerdictItems) {
      const old = frozen.get(cur.source_norm);
      if (!old || old.verdict !== cur.verdict ||
          JSON.stringify(old.issues ?? []) !== JSON.stringify(cur.issues ?? []) ||
          old.final_status !== cur.final_status ||
          old.final_url_norm !== cur.final_url_norm ||
          old.hops !== cur.hops ||
          cur.missing) {
        stale.verification.push({
          source_norm: cur.source_norm,
          reason: cur.missing
            ? '准备时绑定的验证结论已不存在（未重新完整验证）'
            : `验证结果已变化：${old ? old.verdict : '—'} → ${cur.verdict ?? '无结论'}`,
        });
      }
    }
  }
  return {
    fresh: stale.mappings.length === 0 && !stale.rules && stale.verification.length === 0,
    stale,
  };
}

/** 比较两次映射快照，返回人类可读的差异条目 */
export function diffMappings(before, after) {
  const out = [];
  const bInputs = new Map(before.inputs.map((i) => [i.id, i]));
  const aInputs = new Map(after.inputs.map((i) => [i.id, i]));
  for (const [id, i] of bInputs) {
    if (!aInputs.has(id)) {
      out.push({ kind: 'input_removed', source: i.source_raw, detail: '准备后该条原始录入被删除' });
    } else if (fingerprint('input', aInputs.get(id)) !== fingerprint('input', i)) {
      out.push({ kind: 'input_changed', source: i.source_raw, detail: '准备后该条录入内容被修改' });
    }
  }
  for (const [id, i] of aInputs) {
    if (!bInputs.has(id)) {
      out.push({ kind: 'input_added', source: i.source_raw, detail: '准备后新增了录入，未纳入本版本' });
    }
  }
  const bMap = new Map(before.mappings.map((m) => [m.source_norm, m]));
  const aMap = new Map(after.mappings.map((m) => [m.source_norm, m]));
  for (const [key, m] of bMap) {
    const now = aMap.get(key);
    if (!now) {
      out.push({ kind: 'mapping_removed', source: m.source_raw, detail: '准备后该生效映射已不存在' });
    } else if (now.target_norm !== m.target_norm ||
      now.mapping_type !== m.mapping_type || now.status !== m.status) {
      out.push({
        kind: 'mapping_changed', source: m.source_raw,
        detail: `准备后映射变化：${m.target_norm} [${m.status}] → ${now.target_norm} [${now.status}]`,
      });
    }
  }
  for (const [key, m] of aMap) {
    if (!bMap.has(key)) {
      out.push({ kind: 'mapping_added', source: m.source_raw, detail: '准备后出现新生效映射，未纳入本版本' });
    }
  }
  if (!out.length) {
    out.push({ kind: 'unknown', source: null, detail: '映射快照指纹不一致（内容有字节级变化）' });
  }
  return out;
}

async function runItems(client, runId) {
  const { rows } = await client.query(
    'SELECT summary FROM verification_runs WHERE id=$1', [runId]);
  return rows[0]?.summary?.items ?? [];
}

// ---- 闸门（发布必须满足的条件）-----------------------------------------

async function collectGateBlockers(client, runItemsList, mappingsSnapshot) {
  const blockers = [];
  const byKey = new Map(runItemsList.map((i) => [i.source_norm, i]));
  for (const m of mappingsSnapshot.mappings) {
    if (m.status === 'conflicted') {
      blockers.push({ source: m.source_raw, reason: '归一化歧义未裁决' });
      continue;
    }
    const v = byKey.get(m.source_norm);
    if (!v) {
      blockers.push({ source: m.source_raw, reason: '本次完整验证未覆盖该映射' });
    } else if (!GOOD_VERDICTS.has(v.verdict)) {
      blockers.push({
        source: m.source_raw,
        reason: `验证未通过：${(v.issues ?? []).join('；') || v.verdict}`,
      });
    }
  }
  return blockers;
}

// ---- prepare / activate / rollback ------------------------------------

/**
 * 准备一个可激活版本：
 * 自动（重新）构建方案条目 → 执行一次全量真实验证（产生新 run）→
 * 全部门禁通过才冻结四样证据并写入 prepared 版本 + 审计。
 */
export async function prepareRelease({ name, note = null, planId = null }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw httpError(400, '版本名称必填');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { snapshot: mappingsSnapshot, hash: mappingsHash } =
      await gatherMappingsSnapshot(client);
    const { snapshot: rulesSnap, hash: rulesHash } = currentRulesSnapshot();

    // 歧义在验证前就直接阻断（连请求都不应该开始）
    const preConflicts = mappingsSnapshot.mappings
      .filter((m) => m.status === 'conflicted');

    // 方案：显式指定则用之（published 方案不可再改），否则自动创建
    let planRow;
    if (planId) {
      const { rows } = await client.query(
        'SELECT * FROM migration_plans WHERE id=$1 FOR UPDATE', [planId]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        throw httpError(404, '迁移方案不存在');
      }
      if (rows[0].status === 'published') {
        await client.query('ROLLBACK');
        throw httpError(409, '已发布方案不可再用于新版本');
      }
      planRow = rows[0];
    } else {
      // 每个版本自带独立方案（闸门失败的准备也可能已写入方案），名称必须唯一
      const planName = `${trimmed} · 迁移方案 · ${new Date().toISOString()}`;
      const { rows } = await client.query(
        `INSERT INTO migration_plans (name) VALUES ($1) RETURNING *`,
        [planName]);
      planRow = rows[0];
    }

    // 完整验证运行（真实 HTTP，仅白名单本地站点）
    const run = await runVerification({ client });
    // 按本次运行结果重建方案条目（旧条目清空，避免借用历史状态）
    await client.query(
      'DELETE FROM migration_plan_items WHERE plan_id=$1', [planRow.id]);
    const items = await buildPlanItems(client, planRow.id);
    const pSnapshot = await planSnapshot(client, planRow.id, items);

    const blockersMap = new Map();
    for (const m of preConflicts) {
      blockersMap.set(m.source_raw, { source: m.source_raw, reason: '归一化歧义未裁决' });
    }
    for (const b of await collectGateBlockers(client, run.items, mappingsSnapshot)) {
      if (!blockersMap.has(b.source)) blockersMap.set(b.source, b);
    }
    const blockers = [...blockersMap.values()];

    if (blockers.length) {
      await client.query('ROLLBACK');
      const err = httpError(409, '版本未通过发布闸门，未创建（请整改后重新准备）');
      err.blockers = blockers;
      err.run = { id: null, summary: run.summary };
      throw err;
    }

    const vHash = await verificationFingerprint(run.runId, client);
    const { rows } = await client.query(
      `INSERT INTO release_versions
         (name, status, note, plan_id, mappings_snapshot, mappings_fingerprint,
          rules_snapshot, rules_fingerprint, plan_snapshot,
          verification_run_id, verification_fingerprint, prepared_at)
       VALUES ($1,'prepared',$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       RETURNING *`,
      [trimmed, note, planRow.id,
       JSON.stringify(mappingsSnapshot), mappingsHash,
       JSON.stringify(rulesSnap), rulesHash,
       JSON.stringify(pSnapshot), run.runId, vHash]);
    const release = rows[0];
    await client.query(
      `INSERT INTO release_audit (release_id, action, detail)
       VALUES ($1,'prepared',$2)`,
      [release.id, JSON.stringify({
        name: trimmed, plan_id: planRow.id, verification_run_id: run.runId,
        mappings: mappingsSnapshot.mappings.length, passed: run.summary.passed,
      })]);

    await client.query('COMMIT');
    return { release: serialize(release), blockers: [], run_id: run.runId };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* txn may already be aborted */ }
    if (e.code === '23505' && /release_versions_name_key/.test(String(e.constraint ?? ''))) {
      throw httpError(409, '同名版本已存在');
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 激活一个 prepared 版本：原子切换当前 active；漂移则置 failed 并拒绝。
 */
export async function activateRelease(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: targetRows } = await client.query(
      'SELECT * FROM release_versions WHERE id=$1 FOR UPDATE', [id]);
    if (!targetRows.length) {
      await client.query('ROLLBACK');
      throw httpError(404, '版本不存在');
    }
    const target = targetRows[0];

    // 幂等：已经是 active（重复点击/重试）→ 直接返回，不写审计
    if (target.status === 'active') {
      await client.query('COMMIT');
      return { idempotent: true, release: serialize(target) };
    }
    if (target.status !== 'prepared') {
      await client.query('ROLLBACK');
      throw httpError(409, `只有 prepared 版本可以激活，当前状态：${target.status}`);
    }

    // 冻结后漂移检测
    const { fresh, stale } = await checkFreshness(client, target);
    if (!fresh) {
      const reason = staleReason(stale);
      const { rows } = await client.query(
        `UPDATE release_versions SET status='failed', failure_reason=$2
          WHERE id=$1 RETURNING *`, [id, JSON.stringify(reason)]);
      await client.query(
        `INSERT INTO release_audit (release_id, action, detail)
         VALUES ($1,'failed',$2)`,
        [id, JSON.stringify({ at: 'activate', ...reason })]);
      await client.query('COMMIT');
      const err = httpError(409, '版本证据已过期，激活被阻断，版本已标记 failed');
      err.stale = reason;
      err.release = serialize(rows[0]);
      throw err;
    }

    // 原子切换：当前 active → superseded，目标 → active
    const { rows: currentRows } = await client.query(
      `SELECT * FROM release_versions WHERE status='active' FOR UPDATE`);
    const current = currentRows[0] ?? null;
    if (current) {
      await client.query(
        `UPDATE release_versions SET status='superseded' WHERE id=$1`, [current.id]);
      await client.query(
        `INSERT INTO release_audit (release_id, action, detail)
         VALUES ($1,'superseded',$2)`,
        [current.id, JSON.stringify({ by: id })]);
    }
    const { rows } = await client.query(
      `UPDATE release_versions
          SET status='active', activated_at=COALESCE(activated_at, now()),
              replaces_version_id=$2
        WHERE id=$1 RETURNING *`,
      [id, current?.id ?? null]);
    await client.query(
      `INSERT INTO release_audit (release_id, action, detail)
       VALUES ($1,'activated',$2)`,
      [id, JSON.stringify({ replaces: current?.id ?? null })]);

    await client.query('COMMIT');
    return { activated: true, release: serialize(rows[0]), replaced: current?.id ?? null };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* txn may be gone */ }
    if (e.code === '23505') {
      // 并发激活：部分唯一索引 ux_release_one_active 兜底
      throw httpError(409, '已有另一个版本处于 active，本次激活未生效');
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 回退：把异常的 active 版本（:id）原子切回它取代的上一版本。
 * 重复调用（版本已是 rolled_back 且目标一致）幂等返回，不写审计。
 */
export async function rollbackRelease(id, toVersionId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: badRows } = await client.query(
      'SELECT * FROM release_versions WHERE id=$1 FOR UPDATE', [id]);
    if (!badRows.length) {
      await client.query('ROLLBACK');
      throw httpError(404, '版本不存在');
    }
    const bad = badRows[0];

    // 回退目标：上一 active（replaces_version_id）。回退链由账本保证，
    // 不允许跳到任意版本。
    const targetId = toVersionId ? Number(toVersionId) : bad.replaces_version_id;
    if (targetId !== bad.replaces_version_id) {
      await client.query('ROLLBACK');
      throw httpError(409, '只能回退到该版本所取代的上一 active 版本');
    }

    // 幂等：重复点击回退
    if (bad.status === 'rolled_back' && bad.rolled_back_to === targetId) {
      await client.query('COMMIT');
      return { idempotent: true, rolled_back: id, to: targetId };
    }
    if (bad.status !== 'active') {
      await client.query('ROLLBACK');
      throw httpError(409, `只有 active 版本可以回退，当前状态：${bad.status}`);
    }
    if (targetId == null) {
      await client.query('ROLLBACK');
      throw httpError(409, '该版本没有上一 active 版本，无回退目标');
    }

    const { rows: targetRows } = await client.query(
      'SELECT * FROM release_versions WHERE id=$1 FOR UPDATE', [targetId]);
    const target = targetRows[0];
    if (!target || target.status !== 'superseded') {
      await client.query('ROLLBACK');
      throw httpError(409, '回退目标不是 superseded 状态，账本链不一致');
    }

    await client.query(
      `UPDATE release_versions
          SET status='rolled_back', rolled_back_at=now(), rolled_back_to=$2
        WHERE id=$1`, [id, targetId]);
    await client.query(
      `INSERT INTO release_audit (release_id, action, detail)
       VALUES ($1,'rolled_back',$2)`,
      [id, JSON.stringify({ to: targetId })]);

    const { rows } = await client.query(
      `UPDATE release_versions SET status='active', reactivated_at=now()
        WHERE id=$1 RETURNING *`, [targetId]);
    await client.query(
      `INSERT INTO release_audit (release_id, action, detail)
       VALUES ($1,'reactivated',$2)`,
      [targetId, JSON.stringify({ from: id })]);

    await client.query('COMMIT');
    return { rolled_back: id, active: serialize(rows[0]) };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (e.code === '23505') {
      throw httpError(409, '并发回退冲突：账本中仍存在 active 版本，请刷新后重试');
    }
    throw e;
  } finally {
    client.release();
  }
}

// ---- 查询 --------------------------------------------------------------

export function serialize(r) {
  return {
    ...r,
    mappings_snapshot: typeof r.mappings_snapshot === 'string'
      ? JSON.parse(r.mappings_snapshot) : r.mappings_snapshot,
    rules_snapshot: typeof r.rules_snapshot === 'string'
      ? JSON.parse(r.rules_snapshot) : r.rules_snapshot,
    plan_snapshot: typeof r.plan_snapshot === 'string'
      ? JSON.parse(r.plan_snapshot) : r.plan_snapshot,
    failure_reason: typeof r.failure_reason === 'string'
      ? JSON.parse(r.failure_reason) : r.failure_reason ?? null,
  };
}

export async function listReleases() {
  const { rows } = await pool.query(
    'SELECT * FROM release_versions ORDER BY id');
  const releases = rows.map(serialize);
  const active = releases.find((r) => r.status === 'active') ?? null;
  for (const r of releases) {
    r.rollback_target_id = r.status === 'active'
      ? (releases.find((x) => x.id === r.replaces_version_id && x.status === 'superseded')?.id ?? null)
      : null;
    if (r.status === 'prepared') {
      const { fresh, stale } = await checkFreshness(pool, r);
      r.fresh = fresh;
      r.stale = fresh ? null : staleReason(stale);
    }
  }
  return { releases, active_id: active?.id ?? null };
}

export async function getRelease(id) {
  const { rows } = await pool.query(
    'SELECT * FROM release_versions WHERE id=$1', [id]);
  if (!rows.length) throw httpError(404, '版本不存在');
  const release = serialize(rows[0]);
  const { rows: hopsRows } = await pool.query(
    `SELECT source_norm, hop_index, hop FROM verification_run_hops
      WHERE run_id=$1 ORDER BY source_norm, hop_index`,
    [release.verification_run_id]);
  const hopsByKey = {};
  for (const h of hopsRows) {
    (hopsByKey[h.source_norm] ??= []).push(h.hop);
  }
  const { rows: audits } = await pool.query(
    'SELECT * FROM release_audit ORDER BY id');
  const chain = audits
    .filter((a) => a.release_id === release.id ||
      a.detail?.replaces === release.id || a.detail?.by === release.id ||
      a.detail?.to === release.id || a.detail?.from === release.id)
    .map((a) => ({
      id: a.id, release_id: a.release_id, action: a.action,
      detail: a.detail, occurred_at: iso(a.occurred_at),
    }));
  const { rows: drills } = await pool.query(
    'SELECT * FROM drill_runs WHERE release_id=$1 ORDER BY id DESC LIMIT 10', [id]);
  return { release, hops: hopsByKey, audits: chain, drills: drills.map(serializeDrill) };
}

function serializeDrill(d) {
  return {
    ...d,
    results: typeof d.results === 'string' ? JSON.parse(d.results) : d.results,
    faults: typeof d.faults === 'string' ? JSON.parse(d.faults) : d.faults,
    ran_at: iso(d.ran_at),
  };
}

export async function getAuditTrail() {
  const { rows } = await pool.query(
    `SELECT a.*, r.name AS release_name
       FROM release_audit a JOIN release_versions r ON r.id=a.release_id
      ORDER BY a.id`);
  return rows.map((a) => ({
    id: a.id, release_id: a.release_id, release_name: a.release_name,
    action: a.action, detail: a.detail, occurred_at: iso(a.occurred_at),
  }));
}

export async function releaseDiff(id) {
  const { rows } = await pool.query(
    'SELECT * FROM release_versions WHERE id=$1', [id]);
  if (!rows.length) throw httpError(404, '版本不存在');
  const target = serialize(rows[0]);
  const { rows: actRows } = await pool.query(
    `SELECT * FROM release_versions WHERE status='active'`);
  const active = actRows.find((r) => r.id !== Number(id));
  if (!active) return { compared_to: null, mappings: [], rules_changed: false };
  const a = serialize(active);
  return {
    compared_to: { id: a.id, name: a.name },
    mappings: diffMappings(a.mappings_snapshot, target.mappings_snapshot),
    rules_changed: target.rules_fingerprint !== a.rules_fingerprint,
  };
}

export async function getActiveRelease() {
  const { rows } = await pool.query(
    `SELECT * FROM release_versions WHERE status='active'`);
  if (!rows.length) return null;
  const r = serialize(rows[0]);
  const { snapshot, hash } = await gatherMappingsSnapshot(pool);
  const { rows: drillRows } = await pool.query(
    'SELECT * FROM drill_runs WHERE release_id=$1 ORDER BY id DESC LIMIT 1', [r.id]);
  return {
    release: r,
    live_matches_snapshot: hash === r.mappings_fingerprint,
    live_fingerprint: hash,
    latest_drill: drillRows[0] ? serializeDrill(drillRows[0]) : null,
    mapping_count: snapshot.mappings.length,
  };
}

// ---- helpers -----------------------------------------------------------

function staleReason(stale) {
  const expired_evidence = [];
  for (const m of stale.mappings) {
    expired_evidence.push({ type: 'mapping', source: m.source, detail: m.detail, kind: m.kind });
  }
  if (stale.rules) expired_evidence.push({ type: 'rules', source: null, detail: '规范化/爬取规则在准备后被修改（策略快照过期）' });
  for (const v of stale.verification) {
    expired_evidence.push({ type: 'verification', source: v.source_norm, detail: v.reason });
  }
  return {
    message: '准备时冻结的证据已过期',
    expired_evidence,
    summary: expired_evidence.map((e) =>
      `[${e.type}] ${e.source ? `${e.source} — ` : ''}${e.detail}`),
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

export { normalize };
