/**
 * 验证流水线：对每条生效映射真实请求本地站点，
 * 保存每一跳证据（crawl_results）与最终裁决（verification_verdicts）。
 * 冲突键不请求，直接判 ambiguity —— 连请求都不应该开始。
 *
 * 发布版本必须绑定一次“完整验证运行”（verification_runs + 逐跳快照
 * verification_run_hops）：运行一旦完成不可更改；之后重验会产生新运行，
 * 老版本指纹与最新裁决不一致即判证据过期，绝不借用旧放行结论。
 */
import { pool } from './db.js';
import { normalize } from './normalize.js';
import { judge } from './verifier.js';
import { rulesSnapshot } from './policy.js';
import { fingerprint } from './fingerprint.js';

const VERDICT_LABEL = {
  ok: '通过',
  redirect_loop: '重定向环',
  chain_too_long: '跳转链过长',
  fetch_error: '请求被拒/失败',
  deleted_gone_ok: '已删除-状态正确',
  deleted_not_gone: '已删除但未消亡',
  ambiguity: '归一化歧义',
  final_status_bad: '最终页状态异常',
};

export const GOOD_VERDICTS = new Set(['ok', 'deleted_gone_ok']);

/**
 * 对一条生效映射做一次真实验证，并写 live 证据表。
 * 返回 { item, hops }：item 为裁决明细，hops 为逐跳 JSON（供运行快照）。
 */
async function verifyOne(m, { trx = pool } = {}) {
  // 1) 歧义键：阻断，不发请求
  if (m.status === 'conflicted') {
    const { rows: amb } = await trx.query(
      `SELECT source_forms, targets FROM mapping_ambiguities WHERE source_norm = $1`,
      [m.source_norm],
    );
    const issues = [
      `同归一化键 ${m.source_norm} 有多个不同目标`,
      ...(amb[0]?.targets ?? []).map((t) => `候选目标: ${t}`),
    ];
    const item = {
      source_norm: m.source_norm, source_raw: m.source_raw,
      final_url_raw: null, final_url_norm: null, final_status: null,
      hops: 0, tracker_preserved: null,
      verdict: 'ambiguity', issues,
    };
    await saveVerdict(trx, item);
    return { item, hops: [] };
  }

  // 2) 目标自身解析校验（deleted 类型 target 即自身）
  const t = normalize(m.target_raw);
  const { verdict, issues, crawl, tracker } =
    await judge(m.source_raw, m.mapping_type, t.ok ? t.normKey : null);

  await trx.query('DELETE FROM crawl_results WHERE source_norm = $1', [m.source_norm]);
  const hopRows = crawl.hops.map((h) => ({
    hop_index: h.index,
    url_raw: h.url_raw,
    url_norm: h.url_norm,
    status_code: h.status ?? null,
    location_raw: h.location_raw ?? null,
    location_norm: h.location_norm ?? null,
    is_redirect: h.is_redirect,
    fetch_error: h.fetch_error ?? (h.note ?? null),
  }));
  for (const h of hopRows) {
    await trx.query(
      `INSERT INTO crawl_results
         (source_norm, hop_index, url_raw, url_norm, status_code,
          location_raw, location_norm, is_redirect, fetch_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.source_norm, h.hop_index, h.url_raw, h.url_norm, h.status_code,
       h.location_raw, h.location_norm, h.is_redirect, h.fetch_error],
    );
  }
  const item = {
    source_norm: m.source_norm,
    source_raw: m.source_raw,
    final_url_raw: crawl.finalRaw ?? null,
    final_url_norm: crawl.finalNorm ?? null,
    final_status: crawl.finalStatus ?? null,
    hops: hopRows.length,
    tracker_preserved: tracker ? tracker.ok : null,
    verdict,
    issues,
  };
  await saveVerdict(trx, item);
  return { item, hops: hopRows };
}

async function saveVerdict(trx, item) {
  await trx.query(
    `INSERT INTO verification_verdicts
       (source_norm, source_raw, final_url_raw, final_url_norm, final_status,
        hops, tracker_preserved, verdict, issues, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (source_norm) DO UPDATE SET
       source_raw=EXCLUDED.source_raw, final_url_raw=EXCLUDED.final_url_raw,
       final_url_norm=EXCLUDED.final_url_norm, final_status=EXCLUDED.final_status,
       hops=EXCLUDED.hops, tracker_preserved=EXCLUDED.tracker_preserved,
       verdict=EXCLUDED.verdict, issues=EXCLUDED.issues, verified_at=now()`,
    [item.source_norm, item.source_raw, item.final_url_raw, item.final_url_norm,
     item.final_status, item.hops, item.tracker_preserved,
     item.verdict, JSON.stringify(item.issues)],
  );
}

/**
 * 执行一次验证。
 * @param {object} opts
 * @param {null|string} opts.onlyKey null=全量；指定键=单条
 * @param {boolean} opts.recordRun 是否登记 verification_runs（全量默认登记）
 * @param {string} opts.scope 'full' | 'single'
 * @param {import('pg').PoolClient} [opts.client] 调用方事务连接（prepare 用）
 */
export async function runVerification({
  onlyKey = null,
  recordRun = !onlyKey,
  scope = onlyKey ? 'single' : 'full',
  client = null,
} = {}) {
  const trx = client ?? pool;
  if (!onlyKey) {
    // 清理已不在 url_mappings 中的旧裁决与爬取证据（映射被剔除后不得残留结论）。
    // 注意：历史 verification_runs/verification_run_hops 永不清理——
    // 已发布版本绑定的逐跳证据必须保留。
    await trx.query(
      `DELETE FROM verification_verdicts v
        WHERE NOT EXISTS (SELECT 1 FROM url_mappings m WHERE m.source_norm = v.source_norm)`);
    await trx.query(
      `DELETE FROM crawl_results c
        WHERE NOT EXISTS (SELECT 1 FROM url_mappings m WHERE m.source_norm = c.source_norm)`);
  }
  const { rows: mappings } = await trx.query(
    `SELECT m.*,
            (SELECT count(*) FROM mapping_inputs i WHERE i.source_norm = m.source_norm) AS input_count
       FROM url_mappings m ${onlyKey ? 'WHERE m.source_norm = $1' : ''}
       ORDER BY m.id`,
    onlyKey ? [onlyKey] : [],
  );

  let runId = null;
  const snap = rulesSnapshot();
  if (recordRun) {
    const { rows } = await trx.query(
      `INSERT INTO verification_runs
         (scope, source_norm, status, fixture_origin, fixture_mode,
          rules_snapshot, summary, started_at)
       VALUES ($1,$2,'running',$3,$4,$5,'{}'::jsonb, now())
       RETURNING id`,
      [scope, onlyKey, snap.allowlist.origin, process.env.FIXTURE_MODE ?? 'default',
       JSON.stringify(snap)]);
    runId = rows[0].id;
  }

  const items = [];
  const hopSnapshots = [];
  for (const m of mappings) {
    const { item, hops } = await verifyOne(m, { trx });
    items.push(item);
    for (const h of hops) hopSnapshots.push({ source_norm: m.source_norm, ...h });
  }

  if (runId) {
    for (const h of hopSnapshots) {
      await trx.query(
        `INSERT INTO verification_run_hops (run_id, source_norm, hop_index, hop)
         VALUES ($1,$2,$3,$4)`,
        [runId, h.source_norm, h.hop_index, JSON.stringify(h)]);
    }
  }

  const summary = summarize(items);
  if (runId) {
    await trx.query(
      `UPDATE verification_runs
          SET status='completed', summary=$2::jsonb, finished_at=now()
        WHERE id=$1`,
      [runId, JSON.stringify({ ...summary, count: items.length, items })]);
  }
  return {
    count: items.length,
    runId,
    results: items.map((it) => ({
      source_norm: it.source_norm, verdict: it.verdict,
      issues: it.issues, hops: it.hops,
    })),
    items,
    summary,
    label: VERDICT_LABEL,
  };
}

export function summarize(items) {
  const passed = items.filter((i) => GOOD_VERDICTS.has(i.verdict)).length;
  const byVerdict = {};
  for (const i of items) byVerdict[i.verdict] = (byVerdict[i.verdict] ?? 0) + 1;
  return {
    total: items.length,
    passed,
    blocked: items.length - passed,
    allPassed: items.length > 0 && passed === items.length,
    byVerdict,
  };
}

/** 一次完整验证运行的裁决指纹：以运行登记的 items 为准（不依赖 live 表），
 * 任一条裁决/证据变化都会变。 */
export async function verificationFingerprint(runId, trx = pool) {
  const { rows } = await trx.query(
    'SELECT summary FROM verification_runs WHERE id=$1', [runId]);
  const items = (rows[0]?.summary?.items ?? [])
    .map((i) => ({ ...i }))
    .sort((a, b) => (a.source_norm < b.source_norm ? -1 : 1));
  return fingerprint('verification-run', { runId, items });
}

export { VERDICT_LABEL };
