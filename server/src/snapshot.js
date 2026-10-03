/**
 * 发布版本绑定的“不可变材料”快照与指纹。
 *
 * 纪律：
 *  - 指纹只基于材料内容：键按字典序排序、JSON 确定性序列化、SHA-256；
 *  - 时间戳/自增 id 等易变因素一律剔除（验证证据重跑但内容不变时，
 *    版本不应被判过期；任一跳/裁决/映射内容变化则指纹必然变化）；
 *  - 这里只计算与比对，绝不修改线上材料。
 */
import { createHash } from 'node:crypto';
import { config } from './config.js';

/** 确定性 JSON：对象键递归排序（数组保持顺序）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function fingerprint(value) {
  return sha256(stableStringify(value));
}

/**
 * 精确映射快照：原始录入材料 + 生效表的全部身份字段。
 * 只取与“映射内容”相关的列，剔除 received_at / created_at / id 等易变列。
 */
export function buildMappingSnapshot({ inputs, mappings }) {
  return {
    inputs: inputs
      .map((i) => ({
        source_raw: i.source_raw,
        source_norm: i.source_norm,
        target_raw: i.target_raw,
        target_norm: i.target_norm,
        mapping_type: i.mapping_type,
        note: i.note ?? null,
      }))
      .sort((a, b) =>
        a.source_norm.localeCompare(b.source_norm)
        || a.target_norm.localeCompare(b.target_norm)
        || a.source_raw.localeCompare(b.source_raw)),
    mappings: mappings
      .map((m) => ({
        source_raw: m.source_raw,
        source_norm: m.source_norm,
        target_raw: m.target_raw,
        target_norm: m.target_norm,
        mapping_type: m.mapping_type,
        status: m.status,
        note: m.note ?? null,
      }))
      .sort((a, b) => a.source_norm.localeCompare(b.source_norm)),
  };
}

/**
 * 规范化 / 白名单策略快照。
 * 规则与白名单都在进程启动时由环境固定（验证器只访问随项目启动的本地站点）；
 * 以不同环境重启（尾斜杠模式、白名单端口、追踪参数清单等）会产生不同指纹，
 * 已 prepared 的版本随即失效。
 */
export function buildRulesSnapshot() {
  return {
    rules: config.rules,
    allowlist: {
      scheme: 'http:',
      host: config.fixture.host,
      port: config.fixture.port,
    },
    crawl: {
      maxRedirects: config.crawl.maxRedirects,
      timeoutMs: config.crawl.timeoutMs,
    },
  };
}

/**
 * 验证证据快照：按归一化键排序的最终裁决 + 逐跳内容（不含 verified_at、id）。
 * 与 verify-runner 写入 crawl_results / verification_verdicts 的内容一致，
 * 因此激活前可以用线上当前证据重算同一指纹来判定证据是否过期。
 */
export function buildEvidenceSnapshot({ verdicts, hopsByKey }) {
  return [...verdicts]
    .map((v) => ({
      source_norm: v.source_norm,
      source_raw: v.source_raw,
      final_url_raw: v.final_url_raw ?? null,
      final_url_norm: v.final_url_norm ?? null,
      final_status: v.final_status ?? null,
      hops: v.hops ?? 0,
      tracker_preserved: v.tracker_preserved ?? null,
      verdict: v.verdict,
      issues: v.issues ?? [],
      hops_detail: (hopsByKey.get(v.source_norm) ?? [])
        .map((h) => ({
          hop_index: h.hop_index,
          url_raw: h.url_raw,
          url_norm: h.url_norm,
          status_code: h.status_code ?? null,
          location_raw: h.location_raw ?? null,
          location_norm: h.location_norm ?? null,
          is_redirect: h.is_redirect,
          fetch_error: h.fetch_error ?? null,
        })),
    }))
    .sort((a, b) => a.source_norm.localeCompare(b.source_norm));
}
