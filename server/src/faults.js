/**
 * 本地站点故障注入（仅用于上线演练，且只影响 127.0.0.1 的随项目站点）。
 *
 * 安全约束：
 *  - 进程内状态，不持久化；工作台重启后自动清空，绝不可能带进真实环境；
 *  - redirect 类故障的目标 Location 也必须落在白名单（本地站点）内，
 *    演练/验证器永远不会因此离开随项目启动的本地站点；
 *  - 按 pathname 精确匹配，不做模式匹配，避免误伤演示路由。
 */
import { config } from './config.js';

let faults = []; // [{kind:'final_status'|'redirect', path, value}]

/** 校验单个故障描述；不合法抛错（带 statusCode） */
export function validateFault(f) {
  if (!f || typeof f !== 'object') throw err('故障必须是对象', 400);
  const { kind, path, value } = f;
  if (kind !== 'final_status' && kind !== 'redirect') {
    throw err("kind 只能是 'final_status' 或 'redirect'", 400);
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw err('path 必须是 / 开头的本地路径', 400);
  }
  if (kind === 'final_status') {
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      throw err('final_status 的 value 必须是 100..599 的整数', 400);
    }
  } else {
    let u;
    try {
      u = new URL(value, `http://${config.fixture.host}:${config.fixture.port}`);
    } catch {
      throw err('redirect 的 value 不是合法 URL', 400);
    }
    if (u.hostname !== config.fixture.host || u.port !== String(config.fixture.port)) {
      throw err(
        `演练故障不允许跳离白名单：${u.host}（只能指向随项目启动的本地站点）`, 403);
    }
  }
  return { kind, path, value };
}

export function setFaults(list) {
  if (!Array.isArray(list)) throw err('faults 必须是数组', 400);
  faults = list.map(validateFault);
  return faults;
}

export function clearFaults() {
  faults = [];
}

export function getFaults() {
  return faults.map((f) => ({ ...f }));
}

/** 返回命中的故障（精确 pathname） */
export function matchFault(pathname) {
  return faults.find((f) => f.path === pathname) ?? null;
}

function err(msg, code) {
  return Object.assign(new Error(msg), { statusCode: code });
}
