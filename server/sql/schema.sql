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

-- =====================================================================
-- 本地发布版本与回退账本
--
-- 一个“可激活版本”绑定四样不可变材料：
--   1. 精确的映射快照（mapping_inputs + url_mappings 全量内容指纹）
--   2. 规范化 / 白名单策略快照（config.rules + 验证器白名单指纹）
--   3. 一次完整验证运行（verification_runs + 逐跳证据，全量、全通过）
--   4. 迁移方案快照（plan_snapshot JSONB）
--
-- 状态机：prepared -> active -> superseded；active 可 rolled_back；
-- 准备闸门失败 -> failed（终态，永远不能激活，不能借用旧版本放行）。
-- =====================================================================

-- 完整验证运行（版本绑定的“完整验证”证据，逐跳内容随 JSONB 永久保留；
-- 即使 crawl_results / verification_verdicts 被后续验证覆盖，这里的证据不变）
CREATE TABLE IF NOT EXISTS verification_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  total           INT  NOT NULL,
  passed          INT  NOT NULL,
  blocked         INT  NOT NULL,
  -- ok / 空集也算通过：以每条目 verdict ∈ {ok, deleted_gone_ok} 为准
  results         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 本次运行证据（裁决 + 逐跳）的稳定指纹，不含时间戳；
-- 证据内容未变则指纹不变，任一跳/裁决变化则指纹变化
  evidence_hash   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_versions (
  id                    BIGSERIAL PRIMARY KEY,
  version_no            INT  NOT NULL UNIQUE,
  name                  TEXT,
  status                TEXT NOT NULL DEFAULT 'prepared'
                        CHECK (status IN
                          ('prepared','active','superseded','rolled_back','failed')),
  plan_id               BIGINT REFERENCES migration_plans(id),
  plan_name             TEXT,
  plan_snapshot         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 方案条目快照（不可变）
  verification_run_id   BIGINT REFERENCES verification_runs(id),
  -- 四样绑定材料的稳定指纹（SHA-256）
  mapping_fingerprint   TEXT,
  rules_fingerprint     TEXT,
  evidence_fingerprint  TEXT,                 -- = verification_runs.evidence_hash
  verification_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 裁决+逐跳全量快照
  fixture_mode          TEXT NOT NULL DEFAULT 'default',     -- 绑定的本地站点形态
  -- 账本关系：
  --   predecessor       本版本激活时取代的那一版（创建时固定，回退链骨架）
  --   last_superseded_by 最近一次取代/回退后取代本版本的版本（回退到它的快捷目标）
  --   superseded_by     与 last_superseded_by 同值（保留列名兼容展示）
  --   rolled_back_to    本版本被回退时实际恢复的目标
  predecessor           BIGINT REFERENCES release_versions(id),
  last_superseded_by    BIGINT REFERENCES release_versions(id),
  superseded_by         BIGINT REFERENCES release_versions(id),
  rolled_back_to        BIGINT REFERENCES release_versions(id),
  failure_reason        JSONB,                -- failed 时的结构化原因（刷新/重启仍可见）
  prepared_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at          TIMESTAMPTZ,
  deactivated_at        TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ
);
-- 同一时刻只能有一个 active 版本（数据库层硬保证，防并发双激活）
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_one_active
  ON release_versions((1)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_release_status ON release_versions(status);
CREATE INDEX IF NOT EXISTS idx_release_chain ON release_versions(superseded_by);

-- 老库升级：predecessor / last_superseded_by 列（回退链）
ALTER TABLE release_versions
  ADD COLUMN IF NOT EXISTS predecessor BIGINT REFERENCES release_versions(id);
ALTER TABLE release_versions
  ADD COLUMN IF NOT EXISTS last_superseded_by BIGINT REFERENCES release_versions(id);

-- 上线演练：版本激活后对本地站点真实再跑一遍（结果不可变，只追加）
CREATE TABLE IF NOT EXISTS release_drills (
  id              BIGSERIAL PRIMARY KEY,
  version_id      BIGINT NOT NULL REFERENCES release_versions(id),
  kind            TEXT NOT NULL DEFAULT 'post_activation'
                  CHECK (kind IN ('preparation','post_activation','rollback_drill')),
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  passed          INT  NOT NULL,
  failed          INT  NOT NULL,
  anomaly         BOOLEAN NOT NULL DEFAULT false,
  results         JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_drills_version ON release_drills(version_id, ran_at);

-- 不可变审计账本：append-only。所有激活/回退/状态切换逐条留痕，
-- 由触发器拒绝 UPDATE/DELETE/TRUNCATE。
CREATE TABLE IF NOT EXISTS release_audit (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  event           TEXT NOT NULL,                 -- prepared/activated/rolled_back/...
  from_version    BIGINT,
  to_version      BIGINT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION release_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'release_audit 是不可变审计账本，禁止 % 操作', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_release_audit_no_update ON release_audit;
CREATE TRIGGER trg_release_audit_no_update BEFORE UPDATE ON release_audit
  FOR EACH ROW EXECUTE FUNCTION release_audit_immutable();
DROP TRIGGER IF EXISTS trg_release_audit_no_delete ON release_audit;
CREATE TRIGGER trg_release_audit_no_delete BEFORE DELETE ON release_audit
  FOR EACH ROW EXECUTE FUNCTION release_audit_immutable();
DROP TRIGGER IF EXISTS trg_release_audit_no_truncate ON release_audit;
CREATE TRIGGER trg_release_audit_no_truncate BEFORE TRUNCATE ON release_audit
  FOR EACH STATEMENT EXECUTE FUNCTION release_audit_immutable();
