/**
 * 上线演练：对某个版本**冻结的映射快照**真实请求随项目启动的本地站点，
 * 判定“如果按这个版本上线，当前站点行为是否仍与逐跳证据一致”。
 *
 * 关键：演练用的是版本快照里的映射，而不是当前 url_mappings ——
 * 因此回退后演练 v1，检查的就是 v1 当时的映射；故障注入（faults.js）
 * 只允许在白名单内制造异常，用于模拟“激活后发现异常”。
 */
import { pool } from './db.js';
import { crawl, checkTrackers } from './verifier.js';
import { normalize } from './normalize.js';
import { GOOD_VERDICTS } from './verify-runner.js';
import { setFaults, clearFaults, getFaults, validateFault } from './faults.js';

function expectedTarget(m) {
  if (m.mapping_type === 'deleted') return null;
  const t = normalize(m.target_raw);
  return t.ok ? t.normKey : null;
}

/** 用与 verifier.judge 相同的标准，对快照映射重新裁决一次 */
async function drillMapping(m) {
  const r = await crawl(m.source_raw);
  const issues = [];
  let verdict;

  if (r.blocked) {
    verdict = 'fetch_error';
    for (const h of r.hops) if (h.note) issues.push(h.note);
    for (const x of r.issues ?? []) issues.push(x);
  } else if (r.loop) {
    verdict = 'redirect_loop';
    issues.push(`重定向环：${r.loop} 在链中重复`);
  } else if (r.chainTooLong) {
    verdict = 'chain_too_long';
    issues.push('跳转链超过上限仍未终结');
  } else if (r.finalStatus == null) {
    verdict = 'fetch_error';
    issues.push('未能取得最终状态码（连接错误/超时）');
  } else if (m.mapping_type === 'deleted') {
    verdict = (r.finalStatus === 410 || r.finalStatus === 404)
      ? 'deleted_gone_ok' : 'deleted_not_gone';
    if (verdict === 'deleted_not_gone') {
      issues.push(`已删除栏目最终状态为 ${r.finalStatus}，期望 410/404`);
    }
  } else {
    const targetNorm = expectedTarget(m);
    const tracker = checkTrackers(r.finalRaw, r.sourceTrackers ?? []);
    if (!(r.finalStatus >= 200 && r.finalStatus < 300)) {
      verdict = 'final_status_bad';
      issues.push(`最终页面状态 ${r.finalStatus} 非 2xx（演练发现异常）`);
    } else if (targetNorm && r.finalNorm !== targetNorm) {
      verdict = 'final_status_bad';
      issues.push(`最终落点 ${r.finalNorm} 与版本快照目标 ${targetNorm} 不一致`);
    } else if (!tracker.ok) {
      verdict = 'final_status_bad';
      issues.push(tracker.detail);
    } else {
      verdict = 'ok';
    }
  }

  return {
    source_norm: m.source_norm,
    source_raw: m.source_raw,
    expected_norm: expectedTarget(m),
    verdict,
    issues,
    final_status: r.finalStatus ?? null,
    final_url_raw: r.finalRaw ?? null,
    hops: (r.hops ?? []).map((h) => ({
      hop_index: h.index, url_norm: h.url_norm, status: h.status ?? null,
      location_raw: h.location_raw ?? null, note: h.note ?? null,
      fetch_error: h.fetch_error ?? null,
    })),
  };
}

/** 执行演练：默认演练当前 active 版本；也可指定版本（回退后验证 v1） */
export async function runDrill({ releaseId = null } = {}) {
  const client = await pool.connect();
  let relId = releaseId;
  try {
    let release;
    if (relId) {
      const { rows } = await client.query(
        'SELECT * FROM release_versions WHERE id=$1', [relId]);
      if (!rows.length) throw httpError(404, '版本不存在');
      release = rows[0];
    } else {
      const { rows } = await client.query(
        `SELECT * FROM release_versions WHERE status='active'`);
      if (!rows.length) throw httpError(409, '当前没有 active 版本，无法演练');
      release = rows[0];
      relId = release.id;
    }
    if (release.status !== 'active') {
      throw httpError(409, `只能演练 active 版本（该版本状态：${release.status}）`);
    }

    const snapshot = typeof release.mappings_snapshot === 'string'
      ? JSON.parse(release.mappings_snapshot) : release.mappings_snapshot;
    const activeMappings = snapshot.mappings.filter((m) => m.status === 'active');

    const results = [];
    for (const m of activeMappings) {
      results.push(await drillMapping(m));
    }
    const anomalies = results.filter((r) => !GOOD_VERDICTS.has(r.verdict));
    const faults = getFaults();
    const { rows } = await client.query(
      `INSERT INTO drill_runs
         (release_id, release_name, mappings_fingerprint, verdict, results, faults, ran_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
      [release.id, release.name, release.mappings_fingerprint,
       anomalies.length ? 'anomaly' : 'pass',
       JSON.stringify(results), JSON.stringify(faults)]);
    return {
      drill: serialize(rows[0]),
      anomalies: anomalies.length,
      total: results.length,
    };
  } finally {
    client.release();
  }
}

export async function listDrills({ releaseId = null, limit = 20 } = {}) {
  const q = releaseId
    ? 'SELECT * FROM drill_runs WHERE release_id=$1 ORDER BY id DESC LIMIT $2'
    : 'SELECT * FROM drill_runs ORDER BY id DESC LIMIT $1';
  const { rows } = await pool.query(q, releaseId ? [releaseId, limit] : [limit]);
  return rows.map(serialize);
}

export function applyFaults(list) {
  if (!Array.isArray(list)) throw httpError(400, 'faults 必须是数组');
  const applied = setFaults(list.map((f) => validateFault(f)));
  return { active_faults: applied };
}

export function currentFaults() {
  return { active_faults: getFaults() };
}

export function removeFaults() {
  clearFaults();
  return { active_faults: [] };
}

function serialize(d) {
  return {
    ...d,
    results: typeof d.results === 'string' ? JSON.parse(d.results) : d.results,
    faults: typeof d.faults === 'string' ? JSON.parse(d.faults) : d.faults,
    ran_at: d.ran_at instanceof Date ? d.ran_at.toISOString() : d.ran_at,
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}
