/**
 * 指纹：对“准备时刻冻结”的快照做规范化 JSON 序列化后取 SHA-256。
 * 用于 prepared 后漂移检测——任何字节级差异都会改变指纹。
 */
import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function fingerprint(label, value) {
  const h = createHash('sha256').update(`${label}\n${canonicalJson(value)}`).digest('hex');
  return `sha256:${h}`;
}
