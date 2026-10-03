/**
 * 发布版本账本端到端测试（真实本地站点 + PostgreSQL，与其它测试文件分进程）。
 *
 * 覆盖验收点：
 *  ① 完全验证的版本激活；当前版本与本地演练都指向冻结映射快照
 *  ② prepared 后改映射/改规则 → 激活 409 且说明哪项证据过期，版本 failed
 *  ③ 激活后注入异常 → 演练发现 anomaly → 回退恢复上一 active；两版本证据都保留
 *  ④ 重复激活/回退幂等：始终只有一个 active，审计不重复
 *  ⑤ 账本持久化（独立进程重新读取仍正确）；未通过完整验证的版本不能借用旧放行
 *
 * 必须在 import 业务模块前设置环境（独立数据库 + fixed 站点模式）。
 */
process.env.PGDATABASE = 'url_migration_ledger_test';
process.env.FIXTURE_MODE = 'fixed';
// 与 verifier.test.js 使用不同的本地站点端口，避免 node --test 并发跑文件时抢端口
process.env.FIXTURE_PORT = '4571';

const { default: assert } = await import('node:assert/strict');
const { test, before, beforeEach, after } = await import('node:test');
const { execFileSync } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const { ensureDatabase, pool } = await import('../src/db.js');
const { startFixture } = await import('../src/fixture.js');
const { normalize } = await import('../src/normalize.js');
const { recomputeMappings } = await import('../src/mappings-service.js');
const { loadPolicy, resetRules, updateRules } = await import('../src/policy.js');
const { runVerification } = await import('../src/verify-runner.js');
const releases = await import('../src/releases-service.js');
const drill = await import('../src/drill-service.js');
const faults = await import('../src/faults.js');
const { fixtureOrigin } = await import('../src/config.js');

const O = fixtureOrigin();
let fixture;

async function resetDb() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL app.ledger_reset = 'on'");
    await c.query(
      `TRUNCATE drill_runs, release_audit, release_versions,
               verification_run_hops, verification_runs, policy_overrides,
               migration_plan_items, migration_plans, verification_verdicts,
               crawl_results, url_mappings, mapping_inputs
       RESTART IDENTITY CASCADE`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  await resetRules();
  faults.clearFaults();
}

async function insertInputs(rows) {
  for (const r of rows) {
    const s = normalize(r.source_raw);
    const t = normalize(r.target_raw);
    await pool.query(
      `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.source_raw, s.normKey, r.target_raw, t.normKey, r.mapping_type, r.note ?? null]);
  }
  return recomputeMappings(pool);
}

const BASE_INPUTS = [
  { source_raw: `${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html?utm_source=weibo&utm_campaign=autumn`,
    target_raw: `${O}/articles/tech/42`, mapping_type: 'manual' },
  { source_raw: `${O}/news/123`, target_raw: `${O}/articles/123`, mapping_type: 'manual' },
  { source_raw: `${O}/column/weekly/`, target_raw: `${O}/sections/weekly`, mapping_type: 'manual' },
  { source_raw: `${O}/forum/announce/9`, target_raw: `${O}/forum/announce/9`, mapping_type: 'deleted' },
  { source_raw: `${O}/loop/a`, target_raw: `${O}/articles/tech/42`, mapping_type: 'manual' },
];

const countActive = async () =>
  (await pool.query(`SELECT count(*)::int AS n FROM release_versions WHERE status='active'`)).rows[0].n;

before(async () => {
  await ensureDatabase();
  await loadPolicy();
  fixture = await startFixture();
});

beforeEach(resetDb);

after(async () => {
  await fixture.close();
  await pool.end();
});

// -----------------------------------------------------------------------

test('① 完全验证的版本可激活；active 与演练都指向冻结的映射快照', async () => {
  await insertInputs(BASE_INPUTS);
  const { release: v1 } = await releases.prepareRelease({ name: 'v1.0' });
  assert.equal(v1.status, 'prepared');

  const act = await releases.activateRelease(v1.id);
  assert.equal(act.activated, true);

  const active = await releases.getActiveRelease();
  assert.equal(active.release.id, v1.id);
  assert.equal(active.live_matches_snapshot, true, '当前映射必须等于版本冻结快照');
  const sources = active.release.mappings_snapshot.mappings.map((m) => m.source_norm).sort();
  assert.equal(sources.length, 5);

  // 本地站点演练：逐跳请求白名单本地站点，全部与快照一致
  const d = await drill.runDrill({});
  assert.equal(d.total, 5);
  assert.equal(d.anomalies, 0);
  assert.equal(d.drill.verdict, 'pass');
  assert.equal(d.drill.mappings_fingerprint, active.release.mappings_fingerprint,
    '演练必须基于版本快照指纹，而不是临时的 live 表');
});

test('②a prepared 后改动映射：激活被阻断并指出过期证据，版本置 failed', async () => {
  await insertInputs(BASE_INPUTS);
  const { release: v } = await releases.prepareRelease({ name: 'v-stale-map' });

  // 准备后：把 /news/123 的目标改成 v2 页面
  const newsKey = normalize(`${O}/news/123`).normKey;
  await pool.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [newsKey]);
  await insertInputs([{ source_raw: `${O}/news/123`, target_raw: `${O}/articles/123-v2`, mapping_type: 'manual' }]);

  await assert.rejects(
    () => releases.activateRelease(v.id),
    (e) => {
      assert.equal(e.statusCode, 409);
      const kinds = e.stale.expired_evidence.map((x) => x.type);
      assert.ok(kinds.includes('mapping'), '必须指出是映射证据过期');
      assert.ok(e.stale.summary.join(' ').includes('/news/123'), '必须指出哪条链接');
      return true;
    });

  const { releases: list } = await releases.listReleases();
  assert.equal(list.find((r) => r.id === v.id).status, 'failed');
  // failed 版本不能再次激活
  await assert.rejects(() => releases.activateRelease(v.id), /prepared/);
});

test('②b prepared 后改动规则（追踪参数名单）：规则快照过期，激活阻断', async () => {
  await insertInputs(BASE_INPUTS);
  const { release: v } = await releases.prepareRelease({ name: 'v-stale-rules' });
  await updateRules({ trackerParams: [...v.rules_snapshot.rules.trackerParams, 'x_chg'] });
  await assert.rejects(
    () => releases.activateRelease(v.id),
    (e) => {
      assert.equal(e.statusCode, 409);
      assert.ok(e.stale.expired_evidence.some((x) => x.type === 'rules'),
        '必须指出规则证据过期');
      return true;
    });
  // 白名单不可通过规则接口修改
  await assert.rejects(
    () => updateRules({ allowlist: { host: '10.0.0.1' } }),
    (e) => e.statusCode === 403);
});

test('②c prepared 后映射/规则没变，但验证结果被后续重验推翻：验证证据过期', async () => {
  await insertInputs(BASE_INPUTS);
  const { release: v } = await releases.prepareRelease({ name: 'v-stale-verify' });

  // 准备通过后，站点出现新异常（最终页 500），再跑一次 live 验证
  faults.setFaults([{ kind: 'final_status', path: '/articles/123', value: 500 }]);
  await runVerification({});
  faults.clearFaults();

  await assert.rejects(
    () => releases.activateRelease(v.id),
    (e) => {
      assert.equal(e.statusCode, 409);
      assert.ok(e.stale.expired_evidence.some((x) => x.type === 'verification'),
        '必须指出验证结果证据过期');
      assert.ok(e.stale.expired_evidence.some((x) =>
        String(x.source).includes('/news/123')),
        '必须指出是哪条链接的结论变了');
      return true;
    });
});

test('未通过完整验证的版本在 prepare 闸门处就被拒绝，且不产生版本行（不能借旧放行）', async () => {
  // 含一条旧站不存在的错误大小写映射（fixed 站点下 /News/123 为 404）
  await insertInputs([
    ...BASE_INPUTS,
    { source_raw: `${O}/News/123`, target_raw: `${O}/articles/123`, mapping_type: 'manual' },
  ]);
  await assert.rejects(
    () => releases.prepareRelease({ name: 'v-bad' }),
    (e) => {
      assert.equal(e.statusCode, 409);
      assert.ok(e.blockers.some((b) => b.source.includes('/News/123')));
      return true;
    });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM release_versions');
  assert.equal(rows[0].n, 0, '闸门失败不得留下 prepared 版本');
});

test('③④ 激活→异常演练→回退恢复上一版本；两版本证据保留；重复操作幂等', async () => {
  await insertInputs(BASE_INPUTS);
  const { release: v1 } = await releases.prepareRelease({ name: 'v1.0' });
  await releases.activateRelease(v1.id);
  const drillV1 = await drill.runDrill({});
  assert.equal(drillV1.anomalies, 0);
  const auditAfterV1 = (await releases.getAuditTrail()).length;

  // --- 准备 v2：/news/123 改指改版页 -v2，站点侧加对应直跳（本地白名单内）---
  const newsKey = normalize(`${O}/news/123`).normKey;
  await pool.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [newsKey]);
  await insertInputs([{
    source_raw: `${O}/news/123`, target_raw: `${O}/articles/123-v2`, mapping_type: 'manual',
  }]);
  faults.setFaults([{ kind: 'redirect', path: '/news/123', value: '/articles/123-v2' }]);
  const { release: v2 } = await releases.prepareRelease({ name: 'v2.0' });

  // v2 与 v1 的差异必须可查
  const diff = await releases.releaseDiff(v2.id);
  assert.equal(diff.compared_to.id, v1.id);
  assert.ok(diff.mappings.some((d2) => d2.kind === 'mapping_changed' && d2.source.includes('/news/123')));

  await releases.activateRelease(v2.id);
  assert.equal(await countActive(), 1, '激活后只能有一个 active');
  const { releases: list1 } = await releases.listReleases();
  assert.equal(list1.find((r) => r.id === v1.id).status, 'superseded');

  // --- 模拟激活后异常：改版页返回 500，演练发现 anomaly ---
  faults.setFaults([
    { kind: 'redirect', path: '/news/123', value: '/articles/123-v2' },
    { kind: 'final_status', path: '/articles/123-v2', value: 500 },
  ]);
  const badDrill = await drill.runDrill({});
  assert.equal(badDrill.anomalies, 1);
  assert.equal(badDrill.drill.verdict, 'anomaly');
  assert.ok(badDrill.drill.results.find((r) => r.source_norm === newsKey)
    .issues.join(' ').includes('500'));

  // --- 回退到上一 active（v1）；现场故障随回退清除（运维恢复旧配置）---
  const rb = await releases.rollbackRelease(v2.id);
  assert.equal(rb.active.id, v1.id);
  faults.clearFaults();
  const active = await releases.getActiveRelease();
  assert.equal(active.release.id, v1.id);
  assert.equal(active.live_matches_snapshot, false, '现场已漂移，但当前指针回到 v1 快照');

  const restoredDrill = await drill.runDrill({});
  assert.equal(restoredDrill.anomalies, 0, '回退后演练按 v1 快照恢复全部通过');
  const v1SnapTarget = active.release.mappings_snapshot.mappings
    .find((m) => m.source_norm === newsKey).target_norm;
  assert.ok(v1SnapTarget.endsWith('/articles/123'), 'v1 快照仍指向旧目标');

  // 两个版本的证据都保留：v2 的映射快照、验证运行逐跳、异常演练、方案
  const v2Detail = await releases.getRelease(v2.id);
  assert.equal(v2Detail.release.status, 'rolled_back');
  assert.ok(v2Detail.release.mappings_snapshot.mappings
    .find((m) => m.source_norm === newsKey).target_norm.endsWith('/articles/123-v2'));
  assert.ok(Object.keys(v2Detail.hops).length > 0, 'v2 的验证逐跳证据必须保留');
  assert.ok(v2Detail.drills.some((d2) => d2.verdict === 'anomaly'), 'v2 的异常演练记录必须保留');
  assert.ok(v2Detail.release.plan_snapshot.items.length === 5, 'v2 的方案快照必须保留');
  const v1Detail = await releases.getRelease(v1.id);
  assert.ok(v1Detail.drills.some((d2) => d2.verdict === 'pass'), 'v1 的演练记录必须保留');
  assert.ok(Object.keys(v1Detail.hops).length > 0, 'v1 的验证逐跳证据必须保留');

  // ④ 重复回退：幂等，不新增审计
  const auditBeforeRepeat = (await releases.getAuditTrail()).length;
  const rb2 = await releases.rollbackRelease(v2.id);
  assert.equal(rb2.idempotent, true);
  assert.equal((await releases.getAuditTrail()).length, auditBeforeRepeat, '重复回退不得写审计');

  // ④ 重复激活当前 active：幂等，不新增审计
  const actAgain = await releases.activateRelease(v1.id);
  assert.equal(actAgain.idempotent, true);
  assert.equal((await releases.getAuditTrail()).length, auditBeforeRepeat);
  assert.equal(await countActive(), 1);
  assert.ok(auditBeforeRepeat > auditAfterV1, '回退链审计应包含 superseded/rolled_back/reactivated');
});

test('⑤ 审计账本不可变（UPDATE/DELETE 被触发器拒绝）', async () => {
  await insertInputs(BASE_INPUTS);
  const { release: v1 } = await releases.prepareRelease({ name: 'v-audit' });
  await releases.activateRelease(v1.id);
  await assert.rejects(
    () => pool.query('UPDATE release_audit SET action=$1 WHERE release_id=$2',
      ['prepared', v1.id]),
    /不可变审计账本/);
  await assert.rejects(
    () => pool.query('DELETE FROM release_audit WHERE release_id=$1', [v1.id]),
    /不可变审计账本/);
});

test('⑤ 独立进程重新读取（模拟工作台重启）：当前版本、回退链、失败原因仍正确', async () => {
  await insertInputs(BASE_INPUTS);
  const { release: v1 } = await releases.prepareRelease({ name: 'v-restart-1' });
  await releases.activateRelease(v1.id);

  const newsKey = normalize(`${O}/news/123`).normKey;
  await pool.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [newsKey]);
  await insertInputs([{ source_raw: `${O}/news/123`, target_raw: `${O}/articles/123-v2`, mapping_type: 'manual' }]);
  faults.setFaults([{ kind: 'redirect', path: '/news/123', value: '/articles/123-v2' }]);
  const { release: v2 } = await releases.prepareRelease({ name: 'v-restart-2' });
  await releases.activateRelease(v2.id);
  await releases.rollbackRelease(v2.id);

  // 再造一个 failed 版本：先恢复站点直跳到旧目标，准备 v3；之后改映射使其过期
  faults.setFaults([{ kind: 'redirect', path: '/news/123', value: '/articles/123' }]);
  await pool.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [newsKey]);
  await insertInputs([{ source_raw: `${O}/news/123`, target_raw: `${O}/articles/123`, mapping_type: 'manual' }]);
  const { release: v3 } = await releases.prepareRelease({ name: 'v-restart-3' });
  await pool.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [newsKey]);
  await insertInputs([{ source_raw: `${O}/news/123`, target_raw: `${O}/articles/123-v2`, mapping_type: 'manual' }]);
  await assert.rejects(() => releases.activateRelease(v3.id));

  // 全新 Node 进程只读访问账本
  const script = `
    const r = await import(${JSON.stringify(fileURLToPath(new URL('../src/releases-service.js', import.meta.url)))});
    const { pool } = await import(${JSON.stringify(fileURLToPath(new URL('../src/db.js', import.meta.url)))});
    const list = await r.listReleases();
    const active = await r.getActiveRelease();
    const failed = list.releases.find((x) => x.status === 'failed');
    console.log(JSON.stringify({
      active_id: active.release.id,
      statuses: list.releases.map((x) => [x.name, x.status]),
      failed_reason_types: failed.failure_reason.expired_evidence.map((e) => e.type),
    }));
    await pool.end();`;
  const out = JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', script],
    { env: { ...process.env, PGDATABASE: 'url_migration_ledger_test', FIXTURE_MODE: 'fixed' } })
    .toString());
  assert.equal(out.active_id, v1.id, '重启后当前版本必须仍是回退目标 v1');
  assert.deepEqual(
    out.statuses.filter(([n]) => n.startsWith('v-restart')).map(([, s]) => s).sort(),
    ['active', 'failed', 'rolled_back']);
  assert.ok(out.failed_reason_types.includes('mapping'), '失败原因必须跨重启保留');
});
