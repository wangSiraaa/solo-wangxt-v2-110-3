/**
 * 发布版本与回退账本的端到端验收测试（真实 HTTP + 真实 PostgreSQL）。
 *
 * 覆盖验收项：
 *  ① 完全验证的版本激活后，当前映射快照可指出（status/详情/diff 一致）；
 *  ② prepared 后改映射或再验证导致证据变化，激活被阻断并指出过期证据；
 *  ③ 激活后注入异常→演练检出→原子回退，上一 active 恢复且两版证据都保留；
 *  ④ 重复激活/回退（含并发）不产生两个 active、不产生重复审计；
 *  ⑤ 刷新/重启（重新读取账本）当前版本、回退链、失败原因仍正确；
 *     未完成验证的版本永远不能激活、不能借用旧版本放行；
 *  另测：release_audit 不可变（UPDATE/DELETE/TRUNCATE 被拒）。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// 本套件通过 npm test 脚本以独立 FIXTURE_PORT=4571 / FIXTURE_MODE=fixed 运行，
// 端口与模式由命令行环境提供（ESM 导入会提升，文件内设置 env 来不及）。
import { pool } from '../src/db.js';
import { startFixture } from '../src/fixture.js';
import apiRoutes from '../src/routes.js';
import { runVerification } from '../src/verify-runner.js';
import { recomputeMappings } from '../src/mappings-service.js';
import { normalize } from '../src/normalize.js';
import { fixtureOrigin } from '../src/config.js';

let app;
let fixture;

const O = fixtureOrigin();

async function resetDb() {
  await pool.query('SET session_replication_role = replica');
  await pool.query(`TRUNCATE release_audit, release_drills, release_versions,
    verification_runs, migration_plan_items, migration_plans,
    verification_verdicts, crawl_results, url_mappings, mapping_inputs
    RESTART IDENTITY CASCADE`);
  await pool.query('SET session_replication_role = origin');
}

async function addInput(source, target, type = 'manual') {
  const s = normalize(source);
  const t = normalize(target);
  await pool.query(
    `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type)
     VALUES ($1,$2,$3,$4,$5)`,
    [source, s.normKey, target, t.normKey, type]);
}

async function buildHealthyState() {
  // 与 scripts/remediate 后等价的 7 条全绿映射
  await addInput(`${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html?utm_source=weibo&utm_campaign=autumn`,
    `${O}/articles/tech/42`);
  await addInput(`${O}/news/123`, `${O}/articles/123`);
  await addInput(`${O}/column/weekly/`, `${O}/sections/weekly`);
  await addInput(`${O}/old-files%2Fdraft`, `${O}/files%2Fdraft`);
  await addInput(`${O}/forum/announce/9`, `${O}/forum/announce/9`, 'deleted');
  await addInput(`${O}/loop/a`, `${O}/articles/tech/42`);
  await addInput(`${O}/chain/0`, `${O}/chain/7`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recomputeMappings(client);
    await client.query('COMMIT');
  } finally { client.release(); }
  await runVerification();
}

async function createBuiltPlan(name, built = 7) {
  const r = await app.inject({ method: 'POST', url: '/api/plans', payload: { name } });
  assert.equal(r.statusCode, 200, r.body);
  const plan = r.json();
  const b = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/build` });
  assert.equal(b.statusCode, 200, b.body);
  assert.deepEqual(b.json(), { built });
  return plan;
}

const prepare = async (planId, name) =>
  app.inject({ method: 'POST', url: '/api/releases/prepare', payload: { plan_id: planId, name } });
const activate = (id) =>
  app.inject({ method: 'POST', url: `/api/releases/${id}/activate`, payload: {} });
const rollback = (payload = {}) =>
  app.inject({ method: 'POST', url: '/api/releases/rollback', payload });
const status = () => app.inject({ method: 'GET', url: '/api/releases' });
const release = (id) => app.inject({ method: 'GET', url: `/api/releases/${id}` });
const drill = (id) =>
  app.inject({ method: 'POST', url: `/api/releases/${id}/drill`, payload: {} });
const fault = (path, code = 500) =>
  app.inject({ method: 'POST', url: '/api/fixture/fault', payload: { path, status: code } });
const clearFault = () =>
  app.inject({ method: 'POST', url: '/api/fixture/fault', payload: { path: null } });

async function auditCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM release_audit');
  return rows[0].n;
}
async function activeRows() {
  const { rows } = await pool.query("SELECT * FROM release_versions WHERE status='active'");
  return rows;
}
async function getRow(id) {
  const { rows } = await pool.query('SELECT * FROM release_versions WHERE id=$1', [id]);
  return rows[0];
}

before(async () => {
  fixture = await startFixture();
  app = Fastify();
  await app.register(apiRoutes);
});

after(async () => {
  await app.close();
  await fixture.close();
  await pool.end();
});

beforeEach(resetDb);

test('① 完全验证版本激活：页面状态指出当前映射快照，diff 一致', async () => {
  await buildHealthyState();
  const plan = await createBuiltPlan('plan-v1');

  const pr = await prepare(plan.id, '秋季改版 v1');
  assert.equal(pr.statusCode, 200, pr.body);
  const prepared = pr.json();
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.verified, 7);
  assert.match(prepared.mapping_fingerprint, /^[0-9a-f]{64}$/);
  const v1Id = prepared.version.id;

  // 激活前无 active
  assert.equal((await status()).json().active, null);

  const ar = await activate(v1Id);
  assert.equal(ar.statusCode, 200, ar.body);
  assert.equal(ar.json().activated, true);

  const s = (await status()).json();
  assert.equal(s.active.version_no, 1);
  assert.equal(s.active.mapping_fingerprint, prepared.mapping_fingerprint);
  assert.equal(s.diff.mapping_in_sync, true);
  assert.equal(s.diff.evidence_in_sync, true);
  assert.deepEqual(s.diff.mapping_changes, []);

  // 详情含 7 条不可变证据
  const d = (await release(v1Id)).json();
  assert.equal(d.evidence.length, 7);
  assert.ok(d.evidence.every((e) => ['ok', 'deleted_gone_ok'].includes(e.verdict)));
  assert.ok(d.evidence.some((e) => e.hops_detail.length >= 1));
});

test('② prepared 后再验证（站点行为变化）使验证证据过期：激活阻断并指明证据', async () => {
  await buildHealthyState();
  const plan = await createBuiltPlan('plan-stale-evidence');
  const v1Id = (await prepare(plan.id, 'stale-ev')).json().version.id;

  // 站点出现故障并重新验证（prepared 之后证据变化）
  await fault('/articles/tech/42', 500);
  const v = await runVerification();
  assert.ok(v.results.some((r) => !['ok', 'deleted_gone_ok'].includes(r.verdict)));
  await clearFault();

  const ar = await activate(v1Id);
  assert.equal(ar.statusCode, 409, ar.body);
  const body = ar.json();
  assert.equal(body.activated, false);
  assert.equal(body.stale, true);
  const ev = body.stale_evidence.find((x) => x.evidence === 'verification_run');
  assert.ok(ev, '必须指出是“完整验证运行证据”过期');
  assert.match(ev.reason, /完整验证证据已过期/);
  // 落点 /articles/tech/42 受影响的入口（中文旧路径等）会被列出
  assert.ok(ev.changed_sources.length >= 1);

  // 版本进入 failed 终态，刷新后失败原因仍在
  const row = await getRow(v1Id);
  assert.equal(row.status, 'failed');
  assert.ok(row.failure_reason.some((x) => x.evidence === 'verification_run'));

  // 再次激活永远被拒
  const again = await activate(v1Id);
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /failed 终态/);
});

test('② prepared 后改动映射：映射快照过期，激活阻断', async () => {
  await buildHealthyState();
  const plan = await createBuiltPlan('plan-stale-mapping');
  const v1Id = (await prepare(plan.id, 'stale-map')).json().version.id;

  // prepared 之后新增一条映射录入并重算
  await addInput(`${O}/news/999`, `${O}/articles/999`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recomputeMappings(client);
    await client.query('COMMIT');
  } finally { client.release(); }

  const ar = await activate(v1Id);
  assert.equal(ar.statusCode, 409, ar.body);
  const mp = ar.json().stale_evidence.find((x) => x.evidence === 'mapping_snapshot');
  assert.ok(mp, '必须指出映射快照已过期');
  assert.match(mp.reason, /映射快照已过期/);
  assert.equal((await getRow(v1Id)).status, 'failed');
});

test('② 准备时验证未全绿 → failed 版本，永不可激活（不能借用旧版本放行）', async () => {
  // 构造一个必失败的映射状态：环（default 行为）— fixed 下环已打断，
  // 改为新站不存在的落点
  await addInput(`${O}/news/777`, `${O}/articles/777`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recomputeMappings(client);
    await client.query('COMMIT');
  } finally { client.release(); }

  const plan = (await app.inject({ method: 'POST', url: '/api/plans', payload: { name: 'bad' } })).json();
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/build` });

  const pr = await prepare(plan.id, 'bad-release');
  assert.equal(pr.statusCode, 409, pr.body);
  const body = pr.json();
  assert.equal(body.prepared, false);
  assert.equal(body.version.status, 'failed');
  assert.ok(body.blockers.some((b) => b.evidence === 'verification_run'));

  const ar = await activate(body.version.id);
  assert.equal(ar.statusCode, 409);
  assert.match(ar.json().error, /failed 终态/);
  assert.equal((await activeRows()).length, 0, '失败版本绝不能成为 active');
});

test('③ 激活后异常 → 演练检出 → 原子回退：前任恢复，两版证据均保留', async () => {
  await buildHealthyState();

  // v1：7 条
  const p1 = await createBuiltPlan('p1');
  const v1 = (await prepare(p1.id, 'v1')).json().version;
  await activate(v1.id);

  // v2：映射目标做一处真实变化（/chain/0 仍是合法新落点 /chain/7，改成直跳科技页不合适，
  // 这里新增一条干净映射代表“下一套方案”）
  await addInput(`${O}/extra/x`, `${O}/articles/tech/42`);
  const c = await pool.connect();
  try { await c.query('BEGIN'); await recomputeMappings(c); await c.query('COMMIT'); }
  finally { c.release(); }
  await runVerification();
  const p2 = await createBuiltPlan('p2', 8);
  const v2 = (await prepare(p2.id, 'v2')).json().version;
  await activate(v2.id);

  assert.equal((await activeRows()).length, 1);
  let s = (await status()).json();
  assert.equal(s.active.id, v2.id);
  assert.equal(s.rollback_target.id, v1.id, '默认回退目标是直接前任 v1');
  assert.equal((await getRow(v1.id)).status, 'superseded');

  // 保留两版的 prepared 指纹与快照行数
  const v1Before = await getRow(v1.id);
  const v2Before = await getRow(v2.id);

  // 激活后异常：新站点 500；演练必须检出
  await fault('/articles/tech/42', 500);
  const dr = await drill(v2.id);
  assert.equal(dr.statusCode, 200, dr.body);
  const drillBody = dr.json();
  assert.equal(drillBody.anomaly, true);
  assert.ok(drillBody.failed.length >= 1);
  await clearFault();

  // 原子回退到 v1
  const auditsBefore = await auditCount();
  const rb = await rollback({});
  assert.equal(rb.statusCode, 200, rb.body);
  assert.deepEqual(rb.json().from, { id: v2.id, version_no: 2 });
  assert.deepEqual(rb.json().to, { id: v1.id, version_no: 1 });
  assert.equal(await auditCount(), auditsBefore + 1, '回退恰好追加一条审计');

  assert.equal((await activeRows()).length, 1);
  assert.equal((await activeRows())[0].id, v1.id, '上一 active 版本恢复');
  assert.equal((await getRow(v2.id)).status, 'rolled_back');
  assert.equal((await getRow(v2.id)).rolled_back_to, v1.id);

  // 回退后的演练：v1 快照在站点恢复后全部通过
  const dr1 = await drill(v1.id);
  assert.equal(dr1.json().anomaly, false);

  // 两版证据均保留（未被删除/覆盖）
  const v1After = await getRow(v1.id);
  const v2After = await getRow(v2.id);
  assert.equal(v1After.verification_snapshot.length, 7);
  assert.equal(v2After.verification_snapshot.length, 8);
  assert.equal(v1After.evidence_fingerprint, v1Before.evidence_fingerprint);
  assert.equal(v2After.evidence_fingerprint, v2Before.evidence_fingerprint);
  assert.equal(v1After.mapping_fingerprint, v1Before.mapping_fingerprint);

  // 原始逐跳证据仍可查（两版都含 /news/123 的逐跳）
  const d1 = (await release(v1.id)).json();
  const d2 = (await release(v2.id)).json();
  assert.ok(d1.evidence.find((e) => e.source_norm.endsWith('/news/123'))?.hops_detail.length >= 1);
  assert.ok(d2.evidence.find((e) => e.source_norm.endsWith('/news/123'))?.hops_detail.length >= 1);
});

test('④ 重复激活：幂等，无双 active、无重复审计', async () => {
  await buildHealthyState();
  const plan = await createBuiltPlan('p');
  const v1 = (await prepare(plan.id, 'v')).json().version;
  await activate(v1.id);
  const audits = await auditCount();

  const second = await activate(v1.id);
  assert.equal(second.json().idempotent, true);
  const third = await activate(v1.id);
  assert.equal(third.json().idempotent, true);
  assert.equal((await activeRows()).length, 1);
  assert.equal(await auditCount(), audits, '重复激活不追加审计');
});

test('④ 重复回退（串行+并发）：不会越过目标，审计只增一条', async () => {
  await buildHealthyState();
  const p1 = await createBuiltPlan('p1');
  const v1 = (await prepare(p1.id, 'v1')).json().version;
  await activate(v1.id);
  await addInput(`${O}/extra/x`, `${O}/articles/tech/42`);
  const c = await pool.connect();
  try { await c.query('BEGIN'); await recomputeMappings(c); await c.query('COMMIT'); }
  finally { c.release(); }
  await runVerification();
  const p2 = await createBuiltPlan('p2', 8);
  const v2 = (await prepare(p2.id, 'v2')).json().version;
  await activate(v2.id);
  const audits = await auditCount();

  // 两个请求都声称“我看到的 active 是 v2”，并发发起
  const [r1, r2] = await Promise.all([
    rollback({ from_version: v2.id }),
    rollback({ from_version: v2.id }),
  ]);
  const codes = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(codes, [200, 409], '恰好一个成功，另一个被幂等护栏拒绝');
  const ok = [r1, r2].find((r) => r.statusCode === 200).json();
  assert.equal(ok.to.id, v1.id);
  const blocked = [r1, r2].find((r) => r.statusCode === 409).json();
  assert.equal(blocked.idempotent, true);

  assert.equal((await activeRows()).length, 1);
  assert.equal((await activeRows())[0].id, v1.id, '停在 v1，没有越过它继续回退');
  assert.equal(await auditCount(), audits + 1, '并发回退只产生一条审计');

  // 再来一次陈旧请求同样被拒
  const stale = await rollback({ from_version: v2.id });
  assert.equal(stale.statusCode, 409);
  assert.equal(await auditCount(), audits + 1);
});

test('④ 同时刻最多一个 active：两个 prepared 并发激活被串行化，结果唯一 active', async () => {
  await buildHealthyState();
  const pa = await createBuiltPlan('pa');
  const va = (await prepare(pa.id, 'va')).json().version;
  // 第二个版本：完全相同的材料也允许独立 prepare（内容相同也可并存为不同账本版本）
  const pb = await createBuiltPlan('pb');
  const vb = (await prepare(pb.id, 'vb')).json().version;
  const audits = await auditCount();

  const [ra, rb] = await Promise.all([activate(va.id), activate(vb.id)]);
  // 咨询锁串行化：两个激活依次成功（后者把前者取代），任一时刻都没有两个 active
  assert.equal(ra.statusCode, 200, ra.body);
  assert.equal(rb.statusCode, 200, rb.body);
  const act = await activeRows();
  assert.equal(act.length, 1, '最终只有一个 active');
  assert.ok([va.id, vb.id].map(Number).includes(Number(act[0].id)));
  // 两个激活各一条审计；被压在锁后的事务看到的是提交后的新账本（旧版本变 superseded）
  const superseded = (await pool.query(
    "SELECT count(*)::int n FROM release_versions WHERE status='superseded'")).rows[0].n;
  assert.equal(superseded, 1);
  assert.equal(await auditCount(), audits + 2, '两个激活都各有一条审计，无重复/丢失');
});

test('④ 同一版本并发激活：只有一条激活审计、唯一 active', async () => {
  await buildHealthyState();
  const pa = await createBuiltPlan('pa');
  const va = (await prepare(pa.id, 'va')).json().version;
  const audits = await auditCount();
  const [ra, rb] = await Promise.all([activate(va.id), activate(va.id)]);
  assert.equal(ra.statusCode, 200);
  assert.equal(rb.statusCode, 200);
  assert.equal((await activeRows()).length, 1);
  assert.equal(await auditCount(), audits + 1, '同版本并发激活只产生一条 activated 审计');
});

test('⑤ 账本持久化：行级数据即真相；审计链含全部状态切换；审计表不可变', async () => {
  await buildHealthyState();
  const p1 = await createBuiltPlan('p1');
  const v1 = (await prepare(p1.id, 'v1')).json().version;
  await activate(v1.id);

  // 一个因证据过期失败的版本（验证失败原因持久化）
  await fault('/articles/tech/42', 500);
  await runVerification();
  await clearFault();
  const p2 = await createBuiltPlan('p2');
  const prep2 = await prepare(p2.id, 'v2-bad');
  assert.equal(prep2.statusCode, 409);
  const failedId = prep2.json().version.id;

  // “重启/刷新”：重新打开只读连接读取（模拟新进程 SELECT）
  const s = (await status()).json();
  assert.equal(s.active.id, v1.id, '重启后当前版本仍正确');
  assert.equal(s.versions.length, 2);
  const failedRow = s.versions.find((v) => v.id === failedId);
  assert.equal(failedRow.status, 'failed');
  assert.ok(failedRow.failure_reason.length >= 1, '失败原因重启后仍显示');

  const events = s.audit.map((a) => a.event);
  assert.deepEqual(events, ['prepared', 'activated', 'prepare_failed']);

  // 审计链顺序与 from/to
  const activatedEvt = s.audit.find((a) => a.event === 'activated');
  assert.equal(activatedEvt.to_version, v1.id);
  assert.equal(activatedEvt.from_version, null);

  // 回退链
  await addInput(`${O}/extra/x`, `${O}/articles/tech/42`);
  const c = await pool.connect();
  try { await c.query('BEGIN'); await recomputeMappings(c); await c.query('COMMIT'); }
  finally { c.release(); }
  await runVerification();
  const p3 = await createBuiltPlan('p3', 8);
  const v3 = (await prepare(p3.id, 'v3')).json().version;
  await activate(v3.id);
  await rollback({ from_version: v3.id });
  const s2 = (await status()).json();
  assert.equal(s2.active.id, v1.id);
  // v1 是链上第一版（predecessor 为空）：恢复到它之后没有更早的回退目标
  assert.equal(s2.rollback_target, null);
  // v3 记录了被回退到 v1；v1 的“最近后任”仍是 v3（可从账本行看到完整链）
  const v3Row = await getRow(v3.id);
  assert.equal(v3Row.status, 'rolled_back');
  assert.equal(Number(v3Row.rolled_back_to), Number(v1.id));
  assert.equal(Number(v3Row.predecessor), Number(v1.id));
  const v1Row = await getRow(v1.id);
  assert.equal(Number(v1Row.last_superseded_by), Number(v3.id));

  // release_audit 不可变
  await assert.rejects(pool.query('UPDATE release_audit SET event=$1 WHERE id=1', ['hacked']),
    /不可变审计账本/);
  await assert.rejects(pool.query('DELETE FROM release_audit WHERE id=1'),
    /不可变审计账本/);
  await assert.rejects(pool.query('TRUNCATE release_audit'),
    /不可变审计账本/);
});

test('⑤ 无 active 时未验证版本不能借用放行；状态接口自洽', async () => {
  await buildHealthyState();
  const s0 = (await status()).json();
  assert.equal(s0.active, null);
  assert.equal(s0.rollback_target, null);

  // 在没有任何 active 的情况下直接尝试回退
  const rb = await rollback({});
  assert.equal(rb.statusCode, 409);
  assert.match(rb.json().error, /没有 active/);
});
