<template>
  <div class="panel">
    <h2>当前发布版本（本地账本）</h2>
    <div v-if="status.active" class="callout ok">
      <div class="row" style="align-items:center">
        <div style="flex:2">
          <div style="font-size:15px;font-weight:600">
            v{{ status.active.version_no }}<span v-if="status.active.name"> · {{ status.active.name }}</span>
            <span class="badge ok">active</span>
          </div>
          <div class="small muted" style="margin-top:4px">
            方案：{{ status.active.plan_name }} ｜ 本地站点形态：{{ status.active.fixture_mode }}
            ｜ 激活于 {{ fmt(status.active.activated_at) }}
          </div>
        </div>
        <div style="flex:3" class="small mono">
          <div>映射快照指纹：{{ short(status.active.mapping_fingerprint) }}</div>
          <div>规则/白名单指纹：{{ short(status.active.rules_fingerprint) }}</div>
          <div>完整验证指纹：{{ short(status.active.evidence_fingerprint) }}</div>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" :disabled="busy" @click="drill(status.active.id)">
          上线演练（对绑定快照真实请求本地站点）
        </button>
        <button class="btn" style="background:var(--warn);color:#1a1205"
                :disabled="busy || !status.rollback_target"
                @click="rollback(null)">
          {{ status.rollback_target ? `原子回退到 v${status.rollback_target.version_no}` : '无可回退的上一版本' }}
        </button>
      </div>
    </div>
    <div v-else class="callout">
      当前没有 active 版本——只有完全验证、prepared 且证据未过期的版本才能激活；
      未完成验证的版本不能借用任何旧版本放行。
    </div>

    <!-- 与当前工作区的差异 -->
    <div v-if="status.diff" style="margin-top:12px">
      <h3>active 快照 vs 当前工作区（页面与本地演练都指向同一份映射快照）</h3>
      <div class="small">
        <span :class="status.diff.mapping_in_sync ? 'badge ok' : 'badge bad'">
          映射 {{ status.diff.mapping_in_sync ? '与激活快照一致' : '已偏离激活快照' }}
        </span>
        <span :class="status.diff.evidence_in_sync ? 'badge ok' : 'badge bad'" style="margin-left:6px">
          验证证据 {{ status.diff.evidence_in_sync ? '与绑定证据一致' : '已偏离绑定证据' }}
        </span>
      </div>
      <table v-if="status.diff.mapping_changes.length || status.diff.evidence_changes.length" style="margin-top:8px">
        <thead><tr><th>类型</th><th>归一化键</th><th>差异</th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in status.diff.mapping_changes" :key="'m'+i">
            <td><span class="badge warn">{{ c.type }}</span></td>
            <td class="mono">{{ c.source_norm }}</td>
            <td class="mono small">
              <template v-if="c.type === 'changed_target'">{{ c.from }} → {{ c.to }}</template>
              <template v-else-if="c.bound_target">快照绑定：{{ c.bound_target }}</template>
              <template v-else>{{ c.target_norm }}</template>
            </td>
          </tr>
          <tr v-for="(c, i) in status.diff.evidence_changes" :key="'e'+i">
            <td><span class="badge bad">evidence</span></td>
            <td class="mono" colspan="2">{{ c }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 异常提示区 -->
    <div v-if="lastResult" style="margin-top:12px">
      <div :class="isBlocked(lastResult) ? 'callout bad' : 'callout ok'" class="small">
        <template v-if="lastResult.stale">
          <b>激活被阻断：以下绑定证据已过期（版本已标记 failed，拒绝激活）：</b>
          <ul>
            <li v-for="(s, i) in lastResult.stale_evidence" :key="i">
              <b>{{ evidenceName(s.evidence) }}</b>：{{ s.reason }}
              <div v-if="s.changed_sources?.length" class="mono" style="margin-top:2px">
                 · {{ s.changed_sources.join('；') }}
              </div>
            </li>
          </ul>
        </template>
        <template v-else-if="lastResult.error">{{ lastResult.error }}</template>
        <template v-else-if="lastResult.activated && !lastResult.idempotent">
          ✅ 已原子激活 v{{ lastResult.version.version_no }}
          <span v-if="lastResult.previous">，v{{ lastResult.previous.version_no }} 置为 superseded</span>
        </template>
        <template v-else-if="lastResult.activated && lastResult.idempotent">
          ℹ️ 该版本已是 active（重复点击，未产生重复审计）
        </template>
        <template v-else-if="lastResult.rolled_back">
          ✅ 已原子回退：v{{ lastResult.from.version_no }} → 恢复 v{{ lastResult.to.version_no }}，两版证据均保留
        </template>
      </div>
    </div>

    <!-- 演练异常区 -->
    <div v-if="lastDrill" class="panel" style="background:var(--panel2)">
      <h3>本地站点演练结果（v{{ drillVersionNo }}）</h3>
      <div :class="lastDrill.anomaly ? 'callout bad' : 'callout ok'" class="small">
        {{ lastDrill.anomaly
          ? `检测到 ${lastDrill.failed.length} 个异常入口——建议立即原子回退`
          : '全部入口与版本绑定的 prepared 证据一致' }}
      </div>
      <table v-if="lastDrill.failed?.length" style="margin-top:6px">
        <thead><tr><th>入口</th><th>prepared 裁决/状态</th><th>演练实况</th><th>异常</th></tr></thead>
        <tbody>
          <tr v-for="(f, i) in lastDrill.failed" :key="i">
            <td class="mono">{{ f.source_norm }}</td>
            <td class="small">{{ f.prepared_verdict }} / {{ f.prepared_final_status }}</td>
            <td class="small">{{ f.live_verdict }} / {{ f.live_final_status }}</td>
            <td class="small issues"><li v-for="(a, k) in f.anomalies" :key="k">{{ a }}</li></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>准备新版本</h2>
    <p class="muted small">
      准备会：①对全部生效映射真实跑一次完整验证（仅本地白名单站点）；
      ②固化映射快照、规范化/白名单策略快照、验证逐跳证据与迁移方案指纹。
      验证未全绿 → 产生 failed 版本（永不可激活）。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:1">
        <span>绑定迁移方案</span>
        <select v-model="preparePlan">
          <option value="" disabled>选择方案…</option>
          <option v-for="p in plans" :key="p.id" :value="p.id">
            #{{ p.id }} {{ p.name }}（verified {{ p.verified }}/{{ p.items }}）
          </option>
        </select>
      </label>
      <label class="field" style="flex:1">
        <span>版本备注（可选）</span>
        <input v-model="prepareName" placeholder="例：2026 秋季栏目改版" />
      </label>
      <div style="flex:0 0 auto">
        <button class="btn" :disabled="busy || !preparePlan" @click="prepare">
          完整验证并准备版本
        </button>
      </div>
    </div>
    <div v-if="lastPrepare && !lastPrepare.prepared" class="callout bad small" style="margin-top:8px">
      <b>准备失败，版本已记为 failed（不能激活）：</b>
      <ul>
        <li v-for="(b, i) in (lastPrepare.blockers || [])" :key="i">
          <span class="mono">{{ b.source || '—' }}</span>：{{ b.reason }}
        </li>
      </ul>
    </div>
  </div>

  <div class="panel">
    <h2>版本账本与回退链</h2>
    <table>
      <thead>
        <tr>
          <th>#</th><th>备注/方案</th><th>状态</th><th>绑定条目</th>
          <th>映射快照</th><th>最新本地演练</th><th>失败原因</th><th>时间</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="v in [...status.versions].reverse()" :key="v.id"
            :style="v.status === 'active' ? 'background:rgba(63,185,80,.06)' : ''">
          <td>v{{ v.version_no }}</td>
          <td class="small">{{ v.name || '—' }}<div class="muted">{{ v.plan_name }}</div></td>
          <td><span class="badge" :class="statusClass(v.status)">{{ statusLabel(v.status) }}</span>
            <div v-if="v.superseded_by" class="small muted">后任 v{{ versionNo(v.superseded_by) }}</div>
            <div v-if="v.predecessor" class="small muted">前任 v{{ versionNo(v.predecessor) }}</div>
            <div v-if="v.rolled_back_to" class="small muted">↩ 回退到 v{{ versionNo(v.rolled_back_to) }}</div>
          </td>
          <td>{{ v.item_count }}</td>
          <td class="mono small" :title="v.mapping_fingerprint">{{ short(v.mapping_fingerprint) }}</td>
          <td>
            <span v-if="v.latest_drill" class="small"
                  :class="v.latest_drill.anomaly ? 'issues' : ''">
              {{ v.latest_drill.anomaly
                ? `异常 ${v.latest_drill.failed}/${v.latest_drill.passed + v.latest_drill.failed}`
                : `通过 ${v.latest_drill.passed}` }}
              <div class="muted">{{ fmt(v.latest_drill.ran_at) }}</div>
            </span>
            <span v-else class="muted small">未演练</span>
          </td>
          <td class="small">
            <a v-if="v.failure_reason?.length" href="#"
               @click.prevent="showFailure(v)">{{ v.failure_reason.length }} 项证据</a>
            <span v-else class="muted">—</span>
          </td>
          <td class="small muted">{{ fmt(v.prepared_at) }}</td>
          <td style="white-space:nowrap" class="small">
            <a href="#" @click.prevent="open(v.id)">证据</a>
            <template v-if="v.status === 'prepared'"> ·
              <a href="#" @click.prevent="activate(v.id)">激活</a>
            </template>
            <template v-if="['superseded','rolled_back'].includes(v.status)"> ·
              <a href="#" @click.prevent="rollback(v.id)">回退到此版</a>
            </template>
            <template v-if="v.status === 'active'"> ·
              <a href="#" @click.prevent="drill(v.id)">演练</a>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 故障注入（演练“激活后异常”） -->
  <div class="panel">
    <h2>演练台：在随项目启动的本地站点注入异常</h2>
    <p class="muted small">
      故障只注入到验证器白名单内的本地站点（127.0.0.1:4568，进程内存，重启清除）。
      注入后对 active 版本执行“上线演练”即可复现激活后异常，再原子回退。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:3">
        <span>出现故障的路径（新站落点）</span>
        <input v-model="faultPath" placeholder="/articles/tech/42" list="fault-suggest" />
        <datalist id="fault-suggest">
          <option value="/articles/tech/42"></option>
          <option value="/articles/123"></option>
          <option value="/sections/weekly"></option>
          <option value="/files%2Fdraft"></option>
          <option value="/chain/7"></option>
        </datalist>
      </label>
      <label class="field" style="flex:1">
        <span>状态码</span>
        <input v-model.number="faultStatus" type="number" />
      </label>
      <div style="flex:0 0 auto">
        <button class="btn secondary" @click="inject">注入故障</button>
        <button class="btn secondary" style="margin-left:6px" @click="clearFault">清除</button>
      </div>
    </div>
  </div>

  <!-- 不可变审计 -->
  <div class="panel">
    <h2>不可变审计账本（release_audit，append-only）</h2>
    <table>
      <thead><tr><th>#</th><th>时间</th><th>事件</th><th>from</th><th>to</th><th>细节</th></tr></thead>
      <tbody>
        <tr v-for="a in [...status.audit].reverse()" :key="a.id">
          <td>{{ a.id }}</td>
          <td class="small muted">{{ fmt(a.at) }}</td>
          <td><span class="badge" :class="auditClass(a.event)">{{ a.event }}</span></td>
          <td>{{ a.from_version ? 'v' + versionNo(a.from_version) : '—' }}</td>
          <td>{{ a.to_version ? 'v' + versionNo(a.to_version) : '—' }}</td>
          <td class="small mono" style="max-width:420px">{{ JSON.stringify(a.detail) }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 版本证据详情 -->
  <div class="panel" v-if="detail">
    <h2>版本 v{{ detail.version.version_no }} 绑定证据（不可变快照）</h2>
    <p class="muted small">
      映射指纹 {{ short(detail.version.mapping_fingerprint) }} ｜
      规则指纹 {{ short(detail.version.rules_fingerprint) }} ｜
      验证指纹 {{ short(detail.version.evidence_fingerprint) }}
    </p>
    <table>
      <thead><tr><th>入口</th><th>裁决</th><th>最终状态</th><th>最终落点</th><th>跳数</th><th>逐跳</th></tr></thead>
      <tbody>
        <template v-for="e in detail.evidence" :key="e.source_norm">
          <tr>
            <td class="mono small">{{ e.source_norm }}</td>
            <td><span class="badge" :class="['ok','deleted_gone_ok'].includes(e.verdict) ? 'ok' : 'bad'">{{ e.verdict }}</span></td>
            <td>{{ e.final_status }}</td>
            <td class="mono small">{{ e.final_url_norm }}</td>
            <td>{{ e.hops }}</td>
            <td><a href="#" @click.prevent="toggleHops(e.source_norm)">
              {{ openHops === e.source_norm ? '收起' : `${e.hops_detail.length} 跳证据` }}</a></td>
          </tr>
          <tr v-if="openHops === e.source_norm">
            <td colspan="6">
              <table>
                <thead><tr><th>#</th><th>URL（规范化）</th><th>状态</th><th>Location（原样）</th><th>错误</th></tr></thead>
                <tbody>
                  <tr v-for="h in e.hops_detail" :key="h.hop_index">
                    <td>{{ h.hop_index }}</td><td class="mono small">{{ h.url_norm }}</td>
                    <td>{{ h.status_code ?? '—' }}</td>
                    <td class="mono small">{{ h.location_raw || '—' }}</td>
                    <td class="mono small">{{ h.fetch_error || '' }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <h3>该版本审计事件</h3>
    <table>
      <thead><tr><th>#</th><th>事件</th><th>from → to</th><th>细节</th></tr></thead>
      <tbody>
        <tr v-for="a in detail.audit" :key="a.id">
          <td>{{ a.id }}</td><td>{{ a.event }}</td>
          <td class="small">{{ a.from_version ?? '—' }} → {{ a.to_version ?? '—' }}</td>
          <td class="mono small">{{ JSON.stringify(a.detail) }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 失败原因弹层 -->
  <div class="panel" v-if="failureFor" style="border-color:var(--bad)">
    <h2>v{{ failureFor.version_no }} 失效原因（持久保留）</h2>
    <ul>
      <li v-for="(f, i) in failureFor.failure_reason" :key="i" class="small">
        <b>{{ evidenceName(f.evidence) }}</b>：{{ f.reason }}
        <div v-if="f.changed_sources?.length" class="mono"> · {{ f.changed_sources.join('；') }}</div>
      </li>
    </ul>
    <button class="btn secondary" @click="failureFor = null">关闭</button>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({ refreshKey: Number });

const status = ref({ versions: [], audit: [], active: null, rollback_target: null, diff: null, labels: {} });
const plans = ref([]);
const preparePlan = ref('');
const prepareName = ref('');
const busy = ref(false);
const lastResult = ref(null);
const lastPrepare = ref(null);
const lastDrill = ref(null);
const drillVersionNo = ref(null);
const detail = ref(null);
const openHops = ref(null);
const failureFor = ref(null);
const faultPath = ref('/articles/tech/42');
const faultStatus = ref(500);

async function load() {
  status.value = await api.releases();
  plans.value = await api.plans();
  if (detail.value) {
    const d = await api.release(detail.value.version.id);
    detail.value = d;
  }
}
async function prepare() {
  busy.value = true;
  try {
    lastPrepare.value = await api.prepareRelease(preparePlan.value, prepareName.value.trim());
    if (lastPrepare.value.prepared) prepareName.value = '';
  } catch (e) { lastPrepare.value = { prepared: false, blockers: [{ reason: e.message }] }; }
  finally { busy.value = false; await load(); }
}
async function activate(id) {
  busy.value = true;
  lastDrill.value = null;
  try { lastResult.value = await api.activateRelease(id); }
  catch (e) { lastResult.value = { error: e.message }; }
  finally { busy.value = false; await load(); }
}
async function rollback(targetId) {
  const fromId = status.value.active?.id ?? null;
  if (targetId === null && !status.value.rollback_target) return;
  busy.value = true;
  try { lastResult.value = await api.rollbackRelease(targetId, fromId); }
  catch (e) { lastResult.value = { error: e.message }; }
  finally { busy.value = false; lastDrill.value = null; await load(); }
}
async function drill(id) {
  busy.value = true;
  try {
    const r = await api.drillRelease(id);
    lastDrill.value = r;
    drillVersionNo.value = status.value.versions.find((v) => v.id === id)?.version_no;
  } catch (e) { lastResult.value = { error: e.message }; }
  finally { busy.value = false; await load(); }
}
async function open(id) { openHops.value = null; detail.value = await api.release(id); }
function toggleHops(k) { openHops.value = openHops.value === k ? null : k; }
function showFailure(v) { failureFor.value = v; }
async function inject() {
  if (!faultPath.value.trim()) return;
  await api.injectFault(faultPath.value.trim(), faultStatus.value || 500);
  lastResult.value = { error: `已在本地站点注入 ${faultStatus.value}：${faultPath.value}（现在对 active 版本做上线演练）` };
}
async function clearFault() {
  await api.clearFaults();
  lastResult.value = { error: '本地站点故障已清除' };
}

function isBlocked(r) {
  return r && (r.stale || (r.error && !r.activated && !r.rolled_back));
}
function versionNo(id) {
  return status.value.versions.find((v) => v.id === id)?.version_no ?? id;
}
function statusLabel(s) { return status.value.labels?.[s] || s; }
function statusClass(s) {
  return { active: 'ok', prepared: 'warn', superseded: 'neutral',
    rolled_back: 'neutral', failed: 'bad' }[s] || 'neutral';
}
function auditClass(e) {
  return e === 'activated' ? 'ok'
    : e === 'rolled_back' ? 'warn'
    : e.includes('failed') || e.includes('blocked') ? 'bad' : 'neutral';
}
function evidenceName(k) {
  return {
    mapping_snapshot: '映射快照',
    rules_snapshot: '规范化/白名单策略快照',
    verification_run: '完整验证运行证据',
    plan_gate: '方案发布闸门',
    verification_run_gate: '完整验证',
  }[k] || k;
}
function short(h) { return h ? h.slice(0, 12) + '…' : '—'; }
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }

watch(() => props.refreshKey, load);
onMounted(load);
</script>
