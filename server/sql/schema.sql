-- 旧新映射、爬取结果、迁移方案三类数据，全部带“证据”列。
-- 键的规范化由应用层（WHATWG URL，规则见 config.js）保证，不使用 CITEXT，
-- 因为路径大小写敏感、百分号编码不能随意解码。

-- 每次录入的原始材料（证据），同一归一化键可能有多个不同写法的来源。
CREATE TABLE IF NOT EXISTS mapping_inputs (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,
  source_norm     TEXT NOT NULL,           -- 归一化后的查表键
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  note            TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapping_inputs_norm ON mapping_inputs(source_norm);

-- 生效映射：source_norm 唯一。同键不同目标的冲突不允许静默覆盖，
-- 由应用层写入并标记（见 ambiguity.js），冲突行 status='conflicted' 不生效。
CREATE TABLE IF NOT EXISTS url_mappings (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,           -- 首次建立该键时的原始地址（证据）
  source_norm     TEXT NOT NULL UNIQUE,
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','conflicted')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 歧义（多旧址归一后相同，却指向不同资源）：
-- 以 mapping_inputs 为证据，按归一化键分组，存在 2 个以上不同 target_norm。
CREATE OR REPLACE VIEW mapping_ambiguities AS
SELECT source_norm,
       count(*) AS input_count,
       count(DISTINCT target_norm) AS target_variants,
       array_agg(DISTINCT source_raw ORDER BY source_raw) AS source_forms,
       array_agg(DISTINCT target_raw ORDER BY target_raw) AS targets
FROM mapping_inputs
GROUP BY source_norm
HAVING count(DISTINCT target_norm) > 1;

CREATE TABLE IF NOT EXISTS crawl_results (
  id                  BIGSERIAL PRIMARY KEY,
  source_norm         TEXT NOT NULL,
  hop_index           INT  NOT NULL,           -- 0 = 入口地址
  url_raw             TEXT NOT NULL,           -- 该跳实际请求的原始 URL
  url_norm            TEXT NOT NULL,           -- 该跳规范化形式
  status_code         INT,
  location_raw        TEXT,                    -- 响应 Location（原样保留）
  location_norm       TEXT,
  is_redirect         BOOLEAN NOT NULL DEFAULT false,
  fetch_error         TEXT,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_norm, hop_index)
);

-- 对每个入口地址的最终裁决（最终页面状态必须核实）
CREATE TABLE IF NOT EXISTS verification_verdicts (
  source_norm         TEXT PRIMARY KEY,
  source_raw          TEXT NOT NULL,
  final_url_raw       TEXT,
  final_url_norm      TEXT,
  final_status        INT,
  hops                INT  NOT NULL DEFAULT 0,
  tracker_preserved   BOOLEAN,                 -- 追踪参数是否到达最终 URL
  -- ok / redirect_loop / chain_too_long / fetch_error /
  -- deleted_gone_ok / deleted_not_gone / ambiguity / final_status_bad
  verdict             TEXT NOT NULL,
  issues              JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 迁移方案：填表只是 pending，验证通过才 allowed 发布。
CREATE TABLE IF NOT EXISTS migration_plans (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','ready','published')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS migration_plan_items (
  id              BIGSERIAL PRIMARY KEY,
  plan_id         BIGINT NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
  mapping_id      BIGINT NOT NULL REFERENCES url_mappings(id),
  -- pending（仅填表） / verified（有验证证据） / blocked（存在问题）
  item_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (item_status IN ('pending','verified','blocked')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (plan_id, mapping_id)
);

-- ===========================================================================
-- 本地发布版本与回退账本
--
-- 纪律：
--  - 每个可激活版本必须绑定四样“准备时刻冻结”的东西：
--      1. 精确映射快照（mapping_inputs + url_mappings + 歧义视图，含指纹）
--      2. 规范化/白名单策略快照（含指纹；白名单本身只读）
--      3. 一次完整验证运行（verification_runs + 逐跳快照 verification_run_hops）
--      4. 迁移方案快照（plan + items）
--  - prepared 后任何一项漂移 => 激活时判失败，版本置 failed，不可再激活；
--  - 同一时刻至多一个 active（部分唯一索引强制）；
--  - release_audit 只增不改（触发器禁止 UPDATE/DELETE/TRUNCATE），
--    activate/rollback 与状态切换在同一事务内原子提交；
--  - 旧映射、逐跳证据、方案、验证运行一律不删除（快照在 JSONB/run 表中永存）。
-- ===========================================================================

-- 规范化策略的运行时微调（单行 id=1）。白名单（fixture host/port）不在这里、
-- 不可通过 API 修改；这里只允许改不触及 SSRF 边界的规则参数。
CREATE TABLE IF NOT EXISTS policy_overrides (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  overrides       JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version  BIGINT NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 完整验证运行：prepare 必须新建一次全量真实请求；历史运行永不删除。
CREATE TABLE IF NOT EXISTS verification_runs (
  id              BIGSERIAL PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('full','single')),
  source_norm     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  fixture_origin  TEXT NOT NULL,
  fixture_mode    TEXT,
  rules_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- items: 每个源键一条 {source_norm, source_raw, verdict, issues,
  --                     final_status, final_url_raw, final_url_norm,
  --                     hops, tracker_preserved}
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

-- 验证运行的逐跳证据快照：即使 live 表 crawl_results 被后续重验覆盖，
-- 版本绑定的那次运行的逐跳证据仍然原样保留。
CREATE TABLE IF NOT EXISTS verification_run_hops (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES verification_runs(id),
  source_norm     TEXT NOT NULL,
  hop_index       INT  NOT NULL,
  hop             JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_hops_run ON verification_run_hops(run_id, source_norm);

CREATE TABLE IF NOT EXISTS release_versions (
  id                      BIGSERIAL PRIMARY KEY,
  name                    TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL
                          CHECK (status IN
                            ('prepared','active','superseded','rolled_back','failed')),
  note                    TEXT,
  plan_id                 BIGINT NOT NULL REFERENCES migration_plans(id),

  -- 回退链：本次激活所取代的版本；回退发生时指向回到的版本
  replaces_version_id     BIGINT REFERENCES release_versions(id),
  rolled_back_to          BIGINT REFERENCES release_versions(id),

  -- 四样冻结证据（任何一项在 prepared 后漂移 => 激活拒绝并置 failed）
  mappings_snapshot       JSONB NOT NULL,
  mappings_fingerprint    TEXT NOT NULL,
  rules_snapshot          JSONB NOT NULL,
  rules_fingerprint       TEXT NOT NULL,
  plan_snapshot           JSONB NOT NULL,
  verification_run_id     BIGINT NOT NULL REFERENCES verification_runs(id),
  verification_fingerprint TEXT NOT NULL,

  failure_reason          JSONB,
  prepared_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at            TIMESTAMPTZ,
  reactivated_at          TIMESTAMPTZ,
  rolled_back_at          TIMESTAMPTZ
);
-- 数据库级强制：同一时刻只能有一个 active 版本（并发激活也无法插入第二个）
CREATE UNIQUE INDEX IF NOT EXISTS ux_release_one_active
  ON release_versions(status) WHERE status = 'active';

-- 不可变审计账本：只允许 INSERT。
CREATE TABLE IF NOT EXISTS release_audit (
  id              BIGSERIAL PRIMARY KEY,
  release_id      BIGINT NOT NULL REFERENCES release_versions(id),
  action          TEXT NOT NULL
                  CHECK (action IN
                    ('prepared','activated','superseded',
                     'rolled_back','reactivated','failed')),
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_release_audit_release ON release_audit(release_id, id);

CREATE OR REPLACE FUNCTION release_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 仅开发期重置（npm run seed / 测试）允许，且必须在同事务显式打开开关
  IF current_setting('app.ledger_reset', true) = 'on' THEN
    IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'release_audit 是不可变审计账本，禁止 % 操作', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_audit_no_update ON release_audit;
CREATE TRIGGER trg_release_audit_no_update
  BEFORE UPDATE OR DELETE ON release_audit
  FOR EACH ROW EXECUTE FUNCTION release_audit_immutable();

DROP TRIGGER IF EXISTS trg_release_audit_no_truncate ON release_audit;
CREATE TRIGGER trg_release_audit_no_truncate
  BEFORE TRUNCATE ON release_audit
  FOR EACH STATEMENT EXECUTE FUNCTION release_audit_immutable();

-- 本地站点（仅限白名单内）演练记录：每次演练绑定一个版本的映射快照。
CREATE TABLE IF NOT EXISTS drill_runs (
  id                      BIGSERIAL PRIMARY KEY,
  release_id              BIGINT NOT NULL REFERENCES release_versions(id),
  release_name            TEXT NOT NULL,
  mappings_fingerprint    TEXT NOT NULL,
  verdict                 TEXT NOT NULL CHECK (verdict IN ('pass','anomaly')),
  -- results: [{source_norm, source_raw, expected_norm, verdict, issues,
  --           final_status, final_url_raw, hops}]
  results                 JSONB NOT NULL,
  faults                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  ran_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drill_release ON drill_runs(release_id, id);
