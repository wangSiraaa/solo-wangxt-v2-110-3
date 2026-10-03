/**
 * 规范化/白名单策略服务。
 *
 * 边界纪律：
 *  - 白名单（fixture host/port、scheme）来自随项目启动的环境配置，**只读**，
 *    任何 API 都不能改；验证器仍然只能访问随项目启动的本地站点。
 *  - 可在运行时微调的只是不触及 SSRF 边界的规则参数
 *    （尾斜杠、追踪参数名单、最大跳数、超时）；
 *    每次微调 policy_version + 1，准备好的版本会因此立即过期。
 *  - normalize.js 在每次解析时取当前生效规则，所以规则变更只影响之后的
 *    归一化/验证；已冻结在版本快照里的规则永不改变。
 */
import { pool } from './db.js';
import { config } from './config.js';

/** 允许在工作台修改的规则键；allowlist 不在其中，绝不暴露 */
export const EDITABLE_RULE_KEYS = [
  'tailSlashMode',
  'trackerParams',
  'maxRedirects',
  'timeoutMs',
];

const VALIDATORS = {
  tailSlashMode: (v) => (v === 'keep' || v === 'ignore'
    ? null : "tailSlashMode 只能是 'keep' 或 'ignore'"),
  trackerParams: (v) => (Array.isArray(v) && v.every((x) =>
    typeof x === 'string' && /^[A-Za-z0-9_\-.[\]]{1,64}$/.test(x))
    ? null : 'trackerParams 必须是非空/空字符串数组'),
  maxRedirects: (v) => (Number.isInteger(v) && v >= 0 && v <= 20
    ? null : 'maxRedirects 必须是 0..20 的整数'),
  timeoutMs: (v) => (Number.isInteger(v) && v >= 100 && v <= 30000
    ? null : 'timeoutMs 必须是 100..30000 的整数'),
};

let cache = null;

export function currentOverrides() {
  return cache ? { ...cache.overrides } : {};
}

/** 当前生效的完整规则集（环境默认值 + 运行时微调）；白名单始终来自 config */
export function effectiveRules() {
  const o = currentOverrides();
  return {
    scheme: config.rules.scheme,
    tailSlashMode: o.tailSlashMode ?? config.rules.tailSlashMode,
    dropFragment: config.rules.dropFragment,
    trackerParams: [...(o.trackerParams ?? config.rules.trackerParams)],
    unknownQueryIsIdentity: config.rules.unknownQueryIsIdentity,
  };
}

export function effectiveCrawl() {
  const o = currentOverrides();
  return {
    maxRedirects: o.maxRedirects ?? config.crawl.maxRedirects,
    timeoutMs: o.timeoutMs ?? config.crawl.timeoutMs,
  };
}

/** 随版本冻结的策略快照：可变规则 + 只读白名单（证明验证器的访问边界） */
export function rulesSnapshot() {
  return {
    rules: effectiveRules(),
    crawl: effectiveCrawl(),
    allowlist: {
      scheme: 'http:',
      host: config.fixture.host,
      port: config.fixture.port,
      origin: `http://${config.fixture.host}:${config.fixture.port}`,
      note: '随项目启动的本地站点，只读，不可通过 API 修改',
    },
  };
}

export function policyVersion() {
  return cache?.policyVersion ?? 0;
}

export async function loadPolicy() {
  const { rows } = await pool.query('SELECT * FROM policy_overrides WHERE id=1');
  cache = rows.length
    ? { overrides: rows[0].overrides ?? {}, policyVersion: Number(rows[0].policy_version) }
    : { overrides: {}, policyVersion: 0 };
  return cache;
}

/**
 * 修改运行时规则（PUT /api/rules）。只接受白名单内的键，白名单本身不可改。
 * @returns {{applied: object, policyVersion: number}}
 */
export async function updateRules(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('请求体必须是规则键值对象'), { statusCode: 400 });
  }
  const incoming = Object.keys(patch);
  const unknown = incoming.filter((k) => !EDITABLE_RULE_KEYS.includes(k));
  if (unknown.length) {
    throw Object.assign(
      new Error(`不允许修改的规则（白名单只读）：${unknown.join(', ')}`),
      { statusCode: 403 },
    );
  }
  for (const k of incoming) {
    const err = VALIDATORS[k]?.(patch[k]);
    if (err) throw Object.assign(new Error(err), { statusCode: 400 });
  }

  const { rows } = await pool.query(
    `INSERT INTO policy_overrides (id, overrides, policy_version, updated_at)
     VALUES (1, $1::jsonb, 1, now())
     ON CONFLICT (id) DO UPDATE
       SET overrides = policy_overrides.overrides || EXCLUDED.overrides,
           policy_version = policy_overrides.policy_version + 1,
           updated_at = now()
     RETURNING overrides, policy_version`,
    [JSON.stringify(patch)],
  );
  cache = { overrides: rows[0].overrides, policyVersion: Number(rows[0].policy_version) };
  return { applied: patch, policyVersion: cache.policyVersion };
}

/** 开发期重置（npm run seed）用：恢复环境默认规则 */
export async function resetRules() {
  await pool.query('DELETE FROM policy_overrides WHERE id=1');
  cache = { overrides: {}, policyVersion: 0 };
}
