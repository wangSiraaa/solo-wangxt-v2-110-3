/** REST API：映射录入、规范化试算、验证、迁移方案、发布版本账本与演练。 */
import { pool } from './db.js';
import { normalize, carryTrackers, splitQuery } from './normalize.js';
import { recomputeMappings } from './mappings-service.js';
import { runVerification, VERDICT_LABEL } from './verify-runner.js';
import { config } from './config.js';
import {
  EDITABLE_RULE_KEYS, rulesSnapshot,
  updateRules, policyVersion,
} from './policy.js';
import * as releases from './releases-service.js';
import * as drill from './drill-service.js';

export default async function api(app) {
  app.get('/api/health', async () => ({ ok: true, fixture: `127.0.0.1:${config.fixture.port}` }));

  app.get('/api/rules', async () => ({
    ...rulesSnapshot(),
    editableKeys: EDITABLE_RULE_KEYS,
    policyVersion: policyVersion(),
    allowlistReadonly: true,
  }));

  // 运行时微调规则（不触及白名单/SSRF 边界）；改动会使所有 prepared 版本过期
  app.put('/api/rules', async (req, reply) => {
    try {
      const result = await updateRules(req.body ?? {});
      return result;
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // 规范化试算（不写库）：展示大小写/编码/尾斜杠/查询参数如何处理
  app.post('/api/normalize', async (req) => {
    const { urls } = req.body ?? {};
    if (!Array.isArray(urls)) {
      return app.httpErrors?.badRequest?.('urls[] required') ?? { error: 'urls[] required' };
    }
    return urls.map((u) => {
      const r = normalize(String(u));
      if (!r.ok) return { input: u, ok: false, error: r.error };
      const { trackers } = splitQuery(new URL(u).search);
      return {
        input: u, ok: true,
        norm_key: r.normKey,
        pathname: r.pathname,
        identity_query: r.identityQuery,
        tracker_params: [...trackers.keys()],
      };
    });
  });

  // 全量材料：原始输入 + 生效映射 + 最新裁决
  app.get('/api/mappings', async () => {
    const { rows: inputs } = await pool.query(
      `SELECT i.*, v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at
         FROM mapping_inputs i
         LEFT JOIN verification_verdicts v ON v.source_norm = i.source_norm
        ORDER BY i.id`);
    const { rows: mappings } = await pool.query('SELECT * FROM url_mappings ORDER BY id');
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    return { inputs, mappings, ambiguities, verdictLabel: VERDICT_LABEL };
  });

  // 录入一条原始映射：只进 mapping_inputs；随后重算 url_mappings 状态
  app.post('/api/mappings', async (req, reply) => {
    const { source_raw, target_raw, mapping_type = 'manual', note } = req.body ?? {};
    const s = normalize(String(source_raw ?? ''));
    const t = normalize(String(target_raw ?? ''));
    if (!s.ok) return reply.code(400).send({ error: `source: ${s.error}` });
    if (!t.ok) return reply.code(400).send({ error: `target: ${t.error}` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [source_raw, s.normKey, target_raw, t.normKey, mapping_type, note ?? null]);
      await recomputeMappings(client);
      await client.query('COMMIT');
      return { ok: true, source_norm: s.normKey, target_norm: t.normKey };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/api/verify', async (req) => {
    const onlyKey = req.body?.source_norm ?? null;
    return runVerification({ onlyKey, recordRun: false });
  });

  // 撤回一条原始录入（业务裁决/改版时剔除），随后重算生效映射。
  // 已冻结在发布版本快照中的该录入不受影响、永不删除。
  app.delete('/api/mappings/inputs/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM mapping_inputs WHERE id=$1 FOR UPDATE', [id]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: '录入不存在' });
      }
      await client.query('DELETE FROM mapping_inputs WHERE id=$1', [id]);
      await recomputeMappings(client);
      await client.query('COMMIT');
      return { ok: true, deleted: id };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.get('/api/crawl/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const { rows } = await pool.query(
      'SELECT * FROM crawl_results WHERE source_norm=$1 ORDER BY hop_index', [key]);
    if (!rows.length) return reply.code(404).send({ error: 'no crawl evidence; run verification first' });
    return rows;
  });

  // ---- 迁移方案 -------------------------------------------------------

  app.get('/api/plans', async () => {
    const { rows } = await pool.query(
      `SELECT p.*,
              count(pi.id) AS items,
              count(pi.id) FILTER (WHERE pi.item_status='verified') AS verified,
              count(pi.id) FILTER (WHERE pi.item_status='blocked')  AS blocked,
              count(pi.id) FILTER (WHERE pi.item_status='pending')  AS pending
         FROM migration_plans p
         LEFT JOIN migration_plan_items pi ON pi.plan_id=p.id
        GROUP BY p.id ORDER BY p.id`);
    return rows;
  });

  app.post('/api/plans', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO migration_plans (name) VALUES ($1)
         RETURNING *`, [name]);
      return rows[0];
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'plan name exists' });
      throw e;
    }
  });

  // 把全部 active 映射纳入方案，并按最新裁决设置条目状态
  app.post('/api/plans/:id/build', async (req, reply) => {
    const planId = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: plan } = await client.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
      if (!plan.length) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'plan not found' }); }
      if (plan[0].status === 'published') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: '已发布方案不可改' });
      }
      await client.query('DELETE FROM migration_plan_items WHERE plan_id=$1', [planId]);

      const { rows: ms } = await client.query(
        `SELECT m.*, v.verdict, v.issues, v.final_status, v.final_url_raw,
                v.final_url_norm, v.hops, v.tracker_preserved
           FROM url_mappings m
           LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
          WHERE m.status='active' ORDER BY m.id`);
      for (const m of ms) {
        const good = m.verdict === 'ok' || m.verdict === 'deleted_gone_ok';
        // 计划中的最终跳转 URL：携带追踪参数的示例（取首次输入的参数）
        const { rows: ins } = await client.query(
          'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 ORDER BY id LIMIT 1',
          [m.source_norm]);
        const proposed = m.mapping_type === 'deleted'
          ? null
          : carryTrackers(ins[0].source_raw, m.target_raw);
        await client.query(
          `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
           VALUES ($1,$2,$3,$4)`,
          [planId, m.id,
           good ? 'verified' : m.verdict ? 'blocked' : 'pending',
           JSON.stringify({
             verdict: m.verdict ?? null,
             issues: m.issues ?? [],
             final_status: m.final_status ?? null,
             final_url: m.final_url_raw ?? null,
             hops: m.hops ?? 0,
             tracker_preserved: m.tracker_preserved ?? null,
             proposed_redirect_url: proposed,
           })]);
      }
      await client.query('COMMIT');
      return { built: ms.length };
    } finally {
      client.release();
    }
  });

  app.get('/api/plans/:id', async (req, reply) => {
    const { rows: plans } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [req.params.id]);
    if (!plans.length) return reply.code(404).send({ error: 'not found' });
    const { rows: items } = await pool.query(
      `SELECT pi.*, m.source_raw, m.source_norm, m.target_raw, m.target_norm,
              m.mapping_type, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 ORDER BY pi.id`, [req.params.id]);
    return { plan: plans[0], items };
  });

  /**
   * 发布闸门：
   *  - 不存在 blocked/pending 条目（每条都必须有成功验证的证据）；
   *  - 不存在未纳入方案的 active 映射；
   *  - 不存在 conflicted 映射；
   *  - 验证证据必须是最近一次（verified_at 晚于映射/输入更新）——这里以
   *    每条 evidence.verdict 为 ok/deleted_gone_ok 为准。
   * 任何一条不满足都拒绝发布并列出受影响链接。
   */
  app.post('/api/plans/:id/publish', async (req, reply) => {
    const planId = Number(req.params.id);
    const blockers = [];

    const { rows: plan } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
    if (!plan.length) return reply.code(404).send({ error: 'not found' });
    if (plan[0].status === 'published') {
      return { alreadyPublished: true, plan: plan[0] };
    }

    const { rows: badItems } = await pool.query(
      `SELECT m.source_raw, pi.item_status, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
    for (const b of badItems) {
      blockers.push({
        source: b.source_raw,
        reason: b.item_status === 'pending'
          ? '只有映射表条目，没有验证证据（填表不等于迁移完成）'
          : `验证未通过：${(b.evidence?.issues ?? []).join('；') || b.evidence?.verdict}`,
      });
    }

    const { rows: missing } = await pool.query(
      `SELECT m.source_raw FROM url_mappings m
        WHERE m.status='active'
          AND NOT EXISTS (SELECT 1 FROM migration_plan_items pi
                           WHERE pi.mapping_id=m.id AND pi.plan_id=$1)`,
      [planId]);
    missing.forEach((m) => blockers.push({ source: m.source_raw, reason: '生效映射未纳入方案' }));

    const { rows: conflicts } = await pool.query('SELECT source_raw FROM url_mappings WHERE status=$1', ['conflicted']);
    conflicts.forEach((m) => blockers.push({ source: m.source_raw, reason: '归一化歧义未裁决' }));

    if (blockers.length) {
      return reply.code(409).send({ published: false, blockers });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans SET status='published', published_at=now()
        WHERE id=$1 RETURNING *`, [planId]);
    return { published: true, plan: rows[0] };
  });

  // =======================================================================
  // 本地发布版本账本 / 回退 / 演练
  // =======================================================================

  // 版本总览：状态、回退目标、prepared 版本是否仍新鲜
  app.get('/api/releases', async () => releases.listReleases());

  // 当前 active 版本 + 现场是否仍等于冻结映射快照 + 最近演练
  app.get('/api/releases/active', async () => releases.getActiveRelease());

  // 不可变审计账本
  app.get('/api/releases/audit', async () => ({ audit: await releases.getAuditTrail() }));

  // 版本详情（含绑定的逐跳证据、相关审计、演练记录）
  app.get('/api/releases/:id', async (req, reply) => {
    try {
      return await releases.getRelease(Number(req.params.id));
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // 与当前 active 的映射/规则差异
  app.get('/api/releases/:id/diff', async (req, reply) => {
    try {
      return await releases.releaseDiff(Number(req.params.id));
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // 准备：冻结映射/规则/完整验证运行/方案四样证据
  app.post('/api/releases/prepare', async (req, reply) => {
    try {
      return await releases.prepareRelease({
        name: req.body?.name,
        note: req.body?.note ?? null,
        planId: req.body?.plan_id ?? null,
      });
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({
        error: e.message, blockers: e.blockers ?? undefined,
        run: e.run ?? undefined,
      });
    }
  });

  // 激活：原子切换；漂移则 409 + 过期证据明细 + 版本置 failed
  app.post('/api/releases/:id/activate', async (req, reply) => {
    try {
      return await releases.activateRelease(Number(req.params.id));
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({
        error: e.message, stale: e.stale ?? undefined,
        idempotent: e.idempotent ?? undefined,
      });
    }
  });

  // 回退：原子回到上一 active 版本；重复调用幂等，不产生重复审计
  app.post('/api/releases/:id/rollback', async (req, reply) => {
    try {
      return await releases.rollbackRelease(
        Number(req.params.id), req.body?.to_version_id ?? null);
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({
        error: e.message, idempotent: e.idempotent ?? undefined,
      });
    }
  });

  // ---- 本地站点演练（故障注入只作用于白名单本地站点，且不持久化）---------

  app.post('/api/drill/run', async (req, reply) => {
    try {
      return await drill.runDrill({ releaseId: req.body?.release_id ?? null });
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get('/api/drill/runs', async (req) =>
    ({ runs: await drill.listDrills({ releaseId: req.query?.release_id ?? null }) }));

  app.get('/api/drill/faults', async () => drill.currentFaults());

  app.post('/api/drill/faults', async (req, reply) => {
    try {
      return drill.applyFaults(req.body?.faults ?? []);
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.delete('/api/drill/faults', async () => drill.removeFaults());
}
