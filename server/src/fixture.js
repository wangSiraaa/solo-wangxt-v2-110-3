/**
 * 随项目启动的本地站点：同时模拟“旧站”和“新站”，
 * 绑定 127.0.0.1，仅供验证器访问（外网地址由 verifier 的白名单拒绝）。
 *
 * 路由全部在 catch-all 中按 req.raw.url 自行匹配，避免 Web 框架
 * 隐式解码/大小写折叠，保证演示的就是真实线上行为：
 *  - 路径大小写敏感（/News 与 /news 不同）
 *  - 尾斜杠有意义（/column/weekly 与 /column/weekly/ 不同）
 *  - %2F 不是分隔符（/files%2Fdraft 与 /files/draft 不同）
 *  - 跳转时查询参数（含追踪参数）原样透传
 */
import Fastify from 'fastify';
import { config, fixtureOrigin } from './config.js';

export function buildFixtureApp() {
  const app = Fastify({ logger: { name: 'fixture', level: 'warn' } });

  // 故障注入表：pathname -> 注入状态码；仅存在于进程内存（重启即清除）。
  // 供“激活后异常 → 回退”上线演练使用；验证器白名单与逐跳纪律不变。
  const injectedFaults = new Map();

  app.post('/__fixture/fault', async (req) => {
    const path = req.body?.path ?? null;
    if (path === null) {
      injectedFaults.clear();
      return { ok: true, faults: [] };
    }
    const code = Number(req.body?.status ?? 500);
    injectedFaults.set(String(path), code);
    return { ok: true, faults: [...injectedFaults.entries()] };
  });

  // FIXTURE_MODE=fixed 模拟“运维按整改单修复旧站配置后”的线上状态：
  // 长链改直跳、环被打断。默认模式保留全部缺陷用于演示检测能力。
  const fixed = process.env.FIXTURE_MODE === 'fixed';

  // 新站正文页
  const newPages = new Set([
    '/articles/tech/42',
    '/articles/123',
    '/sections/weekly',
    '/files%2Fdraft',
    '/chain/7',
  ]);
  const pageTitles = {
    '/articles/tech/42': '科技频道文章 42',
    '/articles/123': '文章 123（小写 /news 迁入）',
    '/sections/weekly': '周刊栏目',
    '/files%2Fdraft': '文件名中带斜杠字符的草稿页（编码斜杠是合法文件名）',
    '/chain/7': '长链终点页',
  };

  /**
   * 旧站跳转表：键 = pathname（保留百分号编码原样），值 = 新 pathname。
   * 用原生 onRequest 钩子匹配 req.url，绕过框架路由的解码与大小写处理，
   * 查询串统一透传，确保 utm 等追踪参数不丢。
   */
  const redirects = new Map([
    ['/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html', '/articles/tech/42'],
    ['/news/123', '/articles/123'],
    ['/column/weekly/', '/sections/weekly'],
    ['/old-files%2Fdraft', '/files%2Fdraft'],
    // 额外演示入口（供“下一版本新增映射”的发布演练，两种模式行为一致）
    ['/extra/x', '/articles/tech/42'],
    // 修复模式：长链改直跳、环打断；默认模式保留缺陷
    ...(fixed
      ? [
          ['/chain/0', '/chain/7'],
          ['/loop/a', '/articles/tech/42'],
        ]
      : [
          ['/chain/0', '/chain/1'],
          ['/chain/1', '/chain/2'],
          ['/chain/2', '/chain/3'],
          ['/chain/3', '/chain/4'],
          ['/chain/4', '/chain/5'],
          ['/chain/5', '/chain/6'],
          ['/chain/6', '/chain/7'],
          ['/loop/a', '/loop/b'],
        ]),
    ['/loop/b', '/loop/a'],
  ]);

  /** 已删除栏目：永久消失，正确状态是 410 Gone（不是 301 到首页） */
  const gone = new Set(['/forum/announce/9']);

  function send(res, status, body, extraHeaders = {}) {
    const payload = Buffer.from(body, 'utf8');
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': payload.length,
      ...extraHeaders,
    });
    res.end(payload);
  }

  app.addHook('onRequest', (req, reply, done) => {
    const raw = req.raw.url ?? '/';
    if (raw.startsWith('/__fixture/')) return done(); // 管理面，不进站点行为模拟
    let u;
    try {
      u = new URL(raw, fixtureOrigin());
    } catch {
      return done();
    }
    const path = u.pathname;       // WHATWG: 保留 %2F 等转义
    const search = u.search;       // 原样透传，含 utm 等追踪参数
    const res = reply.raw;

    // 上线演练注入的故障（模拟激活后站点异常）
    if (injectedFaults.has(path)) {
      const code = injectedFaults.get(path);
      return send(res, code, `${code} injected fault (${path})`);
    }

    if (gone.has(path)) {
      return send(res, 410, `410 Gone: 栏目已删除 (${path})`);
    }
    if (redirects.has(path)) {
      return send(res, path.startsWith('/loop') ? 302 : 301,
        `redirecting to ${redirects.get(path)}${search}`,
        { location: redirects.get(path) + search });
    }
    if (newPages.has(path)) {
      return send(res, 200, `200 OK: ${pageTitles[path]} | query=${search || '(none)'}`);
    }
    // /News/123、/column/weekly（无尾斜杠）、/files/draft 等均落到此：
    // 用来证明大小写、尾斜杠、编码斜杠的差异会得到不同结果。
    return send(res, 404, `404 Not Found: ${path}`);
  });

  // 兜底路由（请求已在钩子中终结）
  app.all('/*', async () => {});

  return app;
}

export async function startFixture() {
  const app = buildFixtureApp();
  await app.listen({ host: config.fixture.host, port: config.fixture.port });
  return app;
}
