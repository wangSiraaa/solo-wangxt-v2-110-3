#!/usr/bin/env node
/**
 * 测试入口：分两组运行，隔离两套本地站点。
 *  - 规则/验证器：4568，默认（保留缺陷）站点
 *  - 发布版本端到端：4571，fixed 站点 + 独立 DB 数据
 * 两组都必须全部通过；任一失败则整体退出非零。
 */
import { spawn } from 'node:child_process';

const groups = [
  { name: 'rules+verifier', args: ['--test', 'server/test/normalize.test.js', 'server/test/verifier.test.js'] },
  { name: 'releases-ledger', args: ['--test', 'server/test/releases.test.js'], env: { FIXTURE_PORT: '4571', FIXTURE_MODE: 'fixed' } },
];

function run(group) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, group.args, {
      stdio: 'inherit',
      env: { ...process.env, ...(group.env ?? {}) },
    });
    child.on('exit', (code) => resolve({ name: group.name, code }));
  });
}

const results = [];
for (const g of groups) results.push(await run(g));

let failed = 0;
for (const r of results) {
  console.log(`[test-group] ${r.name}: ${r.code === 0 ? 'PASS' : 'FAIL'}`);
  if (r.code !== 0) failed++;
}
process.exit(failed ? 1 : 0);
