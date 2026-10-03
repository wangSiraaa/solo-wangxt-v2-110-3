# URL 迁移验证工作台（Vue 3 + Fastify + PostgreSQL）

内容平台更换栏目结构时，技术负责人需要回答一个问题：**旧链接最终会落到哪里、最终页面状态是什么**。
本项目把“填映射表”和“迁移完成”严格区分开——每条映射只有经过真实 HTTP 请求验证、
拿到逐跳证据并通过发布闸门，才允许发布。

## 它保证了什么

1. **WHATWG URL 规范化**（`server/src/normalize.js`），规则集中、显式：
   - 路径**大小写敏感**：`/News/123` ≠ `/news/123`；
   - 百分号编码只统一十六进制大小写（`%2f→%2F`），**绝不 decode 后合并**；
     原始中文按 UTF-8 编码，`/a%2Fb` 与 `/a/b` 是不同资源；
   - **尾斜杠保留**：`/column/weekly/` ≠ `/column/weekly`；
   - 查询参数：非追踪参数参与资源身份；追踪参数（utm_*、gclid 等）不参与身份，
     但迁移跳转时**原样带到最终 URL**；fragment 丢弃。
2. **只验证随项目启动的本地站点**：白名单 `127.0.0.1:4568`，每一跳的 `Location`
   重新解析并重新过白名单，外网/其它端口一律拒绝（防 SSRF，见 `server/src/verifier.js`）。
3. **检测重定向环、过长链（>5 跳）、多旧址归一后的歧义**：
   - 环：归一化 URL 在同链中重复即停；
   - 长链：超过预算仍给 Location 即 `chain_too_long`；
   - 歧义：多个录入归一到同一键却指向不同目标 → `conflicted`，不挑赢家、阻断发布。
4. **最终页面状态必须核实**：普通迁移期望最终 2xx 且落点严格等于映射目标；
   已删除栏目期望 **410 Gone**（接受 404），不允许 301 到首页蒙混。
5. **PostgreSQL 保存三类数据**：旧新映射（原始材料 `mapping_inputs` + 生效表
   `url_mappings`）、爬取逐跳结果（`crawl_results`）、迁移方案（`migration_plans`
   / `migration_plan_items`），另存每入口最终裁决 `verification_verdicts`。
6. **本地发布版本账本与回退**（`release_versions` / `release_audit`）：
   publish 不是不可逆终点——每个可激活版本必须绑定四样**准备时刻冻结**的证据，
   prepared 后任何漂移都会阻断激活；激活/回退原子切换当前版本，审计只增不改。

## 本地发布版本与回退账本

激活的是“版本”，不是一次随手 publish。每个版本经历
`prepared → active → superseded →（异常）rolled_back`，或漂移时 `failed`：

- **四样冻结证据**（prepare 时一次性绑定，各带 SHA-256 指纹）：
  1. 精确映射快照（`mapping_inputs` + `url_mappings` + 歧义视图，原样 JSONB 永存）；
  2. 规范化/白名单策略快照（白名单即随项目启动的 `127.0.0.1:4568`，**只读**，
     规则微调只允许尾斜杠/追踪参数/跳数/超时，改动立即使 prepared 版本过期）；
  3. 一次**完整验证运行**（`verification_runs` + 逐跳快照 `verification_run_hops`），
     prepare 会真实重跑全量验证，未全绿就不产生版本，**未完成验证永远不能借旧版本放行**；
  4. 迁移方案快照（plan + items）。
- **同一时刻只有一个 active**：数据库部分唯一索引 `ux_release_one_active` 强制，
  并发激活也无法产生第二个。
- **激活/回退原子化**：状态切换（active→superseded、目标→active 等）与审计写入
  在同一事务提交；`release_audit` 有触发器禁止 UPDATE/DELETE/TRUNCATE（不可变账本）。
- **证据过期即失效**：prepare 后映射、规则或验证结果任何一项变化，激活返回
  409 并列出**哪条链接的哪类证据过期**，版本置 `failed`，不可再激活。
- **旧证据永不删除**：旧映射、逐跳证据、方案、验证运行都随版本快照保留；
  回退后上一 active 恢复，两个版本的证据与演练记录都在。
- **本地站点演练**：对当前 active 版本**冻结的映射快照**真实请求本地站点；
  可在白名单内注入故障（最终状态码异常/本地改道，进程内不持久化、重启清空）
  模拟上线异常，演练记录绑定版本与快照指纹。
- **幂等**：重复点击激活/回退不会产生两个 active 或重复审计；刷新、重启工作台后
  当前版本、回退链、失败原因仍从账本正确恢复。

## 快速开始

本仓库在无 root 环境中携带了从 Debian 官方包解压的 PostgreSQL 15（arm64，
位于 `tools/`）。如目录不存在，见文末“自备 PostgreSQL”。

```bash
npm install
npm run pg:start        # 启动 tools/ 下的本地 PostgreSQL（127.0.0.1:55432）
npm run migrate         # 建库 + 建表
npm run seed            # 写入 10 条演示录入（含全部异常场景）

npm test                # 27 项测试：规范化 + 验证器 + 发布版本账本全流程（真实本地站点）
npm run verify          # CLI：对全部映射真实请求验证并给出裁决
node scripts/report.js  # 产出 docs/verification-report-before.md 风格的证据报告

npm start               # 本地站点 + API + 已构建的前端
                        # 工作台 http://127.0.0.1:4567 （仅监听 127.0.0.1）
```

前端开发模式：`npm run dev:web`（Vite :5173，`/api` 代理到 4567）。

## 演示场景（`server/src/seed.js` + `server/src/fixture.js`）

| 场景 | 旧址 | 预期 |
|---|---|---|
| 编码中文路径 + 追踪参数 | `/频道/科技/42.html?utm_source=weibo` | 301→新页 200，追踪参数保留 |
| 正确小写路径 | `/news/123` | 通过 |
| 尾斜杠是身份 | `/column/weekly/` | 通过；无斜杠写法 404 |
| 编码斜杠 | `/old-files%2Fdraft` | 通过；`/files/draft` 是另一个资源（404） |
| 已删除栏目 | `/forum/announce/9` | **410 Gone** |
| 重定向环 | `/loop/a ↔ /loop/b` | `redirect_loop` |
| 过长链（7 跳） | `/chain/0 … /chain/7` | `chain_too_long` |
| 归一化歧义 | 同键 `/news/123` 指向 123 与 999 | `ambiguity`，不生效不请求 |
| 外网地址 | `http://example.com/...` | 白名单拒绝，**不发起请求** |
| 大小写错误 | `/News/123` | 最终 404，验证失败 |

## “填完表 ≠ 迁移完成”的完整闭环

```bash
# 1) 整改前：验证失败、报告记录受影响链接与证据（docs/verification-report-before.md）
npm run seed && npm run verify
#  → 共 9 条，通过 4，阻断 5（环/长链/404/歧义/越权）

# 2) 业务与运维修复：
#    - 站点侧打断环、长链改直跳（FIXTURE_MODE=fixed 模拟已上线配置）
#    - scripts/remediate.js：裁决歧义、剔除错误录入和非本站地址、更新映射目标
FIXTURE_MODE=fixed node scripts/remediate.js
FIXTURE_MODE=fixed npm run verify
#  → 共 7 条，全部通过（含 1 条已删除正确 410）

# 3) 整改后证据报告
FIXTURE_MODE=fixed node scripts/report.js
#  → docs/verification-report.md（passed=7 blocked=0）
```

工作台里的“迁移方案”也遵循同样闸门：纳入方案只是 `pending`，
`build` 时按最新裁决标注 `verified/blocked`；`publish` 时只要存在
blocked/pending、未纳入的生效映射或未裁决歧义，就返回 **409 + 受影响链接清单**。

## 版本化发布与回退演练（推荐流程）

```bash
# 前置：整改 + 全量验证通过（见上）。在“发布版本 / 回退账本”页：
# 1) 准备 v1：冻结四样证据并跑一次完整验证（任何一条不过就不产生版本）
curl -X POST localhost:4567/api/releases/prepare -H 'content-type: application/json' \
  -d '{"name":"v1.0 秋季"}'
# 2) 激活（prepared 后若映射/规则/验证结果有任何漂移，这里 409 并指明过期证据）
curl -X POST localhost:4567/api/releases/1/activate
# 3) 本地站点演练（按 v1 冻结快照逐跳请求 127.0.0.1:4568）
curl -X POST localhost:4567/api/drill/run
# 4) 上线演练发现异常：在白名单内注入故障（仅进程内、重启清空），再演练复现
curl -X POST localhost:4567/api/drill/faults -H 'content-type: application/json' \
  -d '{"faults":[{"kind":"final_status","path":"/articles/123","value":500}]}'
# 5) 安全回到上一 active 版本（原子切换；两个版本证据都保留）
curl -X POST localhost:4567/api/releases/2/rollback
```

## API 摘要

| 方法/路径 | 作用 |
|---|---|
| `POST /api/normalize` | 规范化试算（不写库） |
| `GET/POST /api/mappings`、`DELETE /api/mappings/inputs/:id` | 原始录入材料 / 录入或撤回一条（自动重算生效与冲突；已冻结快照不受影响） |
| `POST /api/verify` | 对全部（或指定 `source_norm`）真实验证 |
| `GET /api/crawl/:key` | 查看某条链接的逐跳证据 |
| `GET/POST /api/plans`、`POST /api/plans/:id/build`、`POST /api/plans/:id/publish` | 方案与发布闸门 |
| `GET /api/rules`、`PUT /api/rules` | 规则/白名单快照（白名单只读）；运行时微调规则，prepared 版本随之过期 |
| `POST /api/releases/prepare` | 全量验证 + 冻结映射/规则/验证运行/方案，创建 prepared 版本 |
| `GET /api/releases`、`GET /api/releases/active`、`GET /api/releases/:id`、`GET /api/releases/:id/diff` | 账本总览/当前版本（含快照是否仍匹配现场、最近演练）/详情（含逐跳证据）/差异 |
| `POST /api/releases/:id/activate` | 原子激活；漂移则 409 + 过期证据清单，版本 failed；重复调用幂等 |
| `POST /api/releases/:id/rollback` | 原子回退到该版本取代的上一 active；重复调用幂等 |
| `GET /api/releases/audit` | 不可变审计账本（触发器禁止改/删） |
| `POST /api/drill/run`、`GET /api/drill/runs` | 对 active 版本冻结快照的本地站点演练 |
| `GET/POST/DELETE /api/drill/faults` | 演练故障注入（仅白名单本地站点、不持久化、目标仍限白名单） |

## 环境变量（见 `.env.example`）

`HOST/PORT`（API）、`FIXTURE_HOST/PORT`（本地站点）、`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`、
`TRAILING_SLASH_MODE`（默认 `keep`）、`MAX_REDIRECTS`（默认 5）、`HTTP_TIMEOUT_MS`、
`FIXTURE_MODE`（`fixed` = 模拟整改后站点）。

## 自备 PostgreSQL

若 `tools/` 不存在，在 Debian/Ubuntu 上可由无 root 方式取得二进制：

```bash
mkdir -p tools/pg-debs && cd tools/pg-debs
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-15_15.18-0+deb12u1_arm64.deb
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-client-15_15.18-0+deb12u1_arm64.deb
mkdir pg && cd pg && ar x ../postgresql-15_*.deb && tar xf data.tar.xz
cd .. && mkdir pg-client && cd pg-client && ar x ../postgresql-client-15_*.deb && tar xf data.tar.xz
cd /workspace && npm run pg:start
```

其它架构（amd64 等）把 deb 文件名中的 `arm64` 替换即可。也可改用系统 PostgreSQL，
用上述 `PG*` 环境变量指向它（脚本不会触碰你已有的实例，只创建 `url_migration` 库）。

## 目录

```
server/src/   normalize.js(规范化规则) verifier.js(白名单/环/长链/最终状态)
              ambiguity.js mappings-service.js verify-runner.js(含完整验证运行)
              releases-service.js(版本账本/漂移检测/原子激活回退)
              drill-service.js(本地站点演练) faults.js(白名单内故障注入)
              policy.js(规则快照/运行时微调；白名单只读) fingerprint.js
              fixture.js(随项目本地站点) routes.js(Fastify) db.js
server/sql/   schema.sql(含 release_versions/release_audit/verification_runs/drill_runs)
web/          Vue 3 + Vite 工作台（总览/发布版本账本/证据/方案闸门/规则五页）
scripts/      start-pg.js remediate.js report.js
docs/         verification-report-before.md / -after.md（真实跑出来的证据）
server/test/  规则单测 + 验证器集成 + 版本账本端到端（27 项）
```
