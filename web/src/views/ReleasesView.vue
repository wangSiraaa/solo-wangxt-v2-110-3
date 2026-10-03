<template>
  <!-- 当前 active 版本：页面随时指出当前绑定的映射快照 -->
  <div class="panel">
    <h2>当前发布版本</h2>
    <div v-if="activeInfo" class="callout ok">
      <div class="row" style="align-items:center">
        <div style="flex:2">
          <div style="font-size:16px">
            <span class="badge ok">ACTIVE #{{ activeInfo.release.id }}</span>
            <b style="margin-left:8px">{{ activeInfo.release.name }}</b>
          </div>
          <div class="small muted" style="margin-top:6px">
            绑定映射快照 <code>{{ activeInfo.release.mappings_fingerprint.slice(0, 22) }}…</code>
            （{{ activeInfo.release.mappings_snapshot.mappings.length }} 条）·
            完整验证运行 #{{ activeInfo.release.verification_run_id }} ·
            激活于 {{ fmt(activeInfo.release.activated_at) }}
          </div>
          <div class="small" :style="activeInfo.live_matches_snapshot ? 'color:var(--ok)' : 'color:var(--warn)'" style="margin-top:4px">
            {{ activeInfo.live_matches_snapshot
              ? '✅ 当前现场映射与该版本冻结快照完全一致'
              : '⚠️ 当前现场映射已偏离该版本快照（演练仍按快照执行）' }}
          </div>
        </div>
        <div style="flex:1" class="small">
          <div v-if="activeInfo.latest_drill" class="muted">
            最近演练：
            <span :class="activeInfo.latest_drill.verdict === 'pass' ? 'badge ok' : 'badge bad'">
              {{ activeInfo.latest_drill.verdict === 'pass' ? '通过' : '发现异常' }}
            </span>
            {{ fmt(activeInfo.latest_drill.ran_at) }}
          </div>
          <div v-else class="muted">尚无演练记录</div>
          <div v-if="rollbackTarget" style="margin-top:8px">
            回退目标：<b>#{{ rollbackTarget.id }} {{ rollbackTarget.name }}</b>
            <span class="muted">（上一 active，superseded）</span>
          </div>
          <div v-else class="muted" style="margin-top:8px">无回退目标（首个版本）</div>
        </div>
      </div>
    </div>
    <div v-else class="callout">
      当前没有 active 版本。准备一个完全验证通过的版本后激活。
    </div>
  </div>

  <!-- 准备新版本 -->
  <div class="panel">
    <h2>准备新版本（冻结映射快照 + 规则/白名单快照 + 完整验证运行 + 迁移方案）</h2>
    <p class="muted small">
      “准备”会对全部生效映射<b>真实请求本地站点重新做一次完整验证</b>：任一条不通过就不产生版本，
      未完成验证永远不能借旧版本的结论放行。准备后映射或规则一旦变动，激活立即被阻断。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:3">
        <span>版本名称</span>
        <input v-model="newName" placeholder="例：v2.0 冬季节目改版" />
      </label>
      <label class="field" style="flex:3">
        <span>备注</span>
        <input v-model="newNote" placeholder="变更说明（可选）" />
      </label>
      <div style="flex:1">
        <button class="btn" :disabled="preparing" @click="prepare">
          {{ preparing ? '正在全量验证…' : '准备新版本（全量验证）' }}
        </button>
      </div>
    </div>
    <div v-if="prepareResult?.blockers?.length" class="callout bad">
      <b>闸门未通过，未创建版本。受影响链接：</b>
      <table style="margin-top:8px">
        <tbody>
          <tr v-for="(b, i) in prepareResult.blockers" :key="i">
            <td class="mono">{{ b.source || '（全部）' }}</td><td>{{ b.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <span v-if="prepareError" class="badge bad" style="margin-top:8px;display:inline-block">{{ prepareError }}</span>
  </div>

  <!-- 版本账本 -->
  <div class="panel">
    <h2>版本账本（同一时刻只有一个 active；prepared 后漂移会 failed）</h2>
    <table>
      <thead>
        <tr>
          <th>#</th><th>名称</th><th>状态</th><th>映射数</th><th>验证运行</th>
          <th>新鲜度</th><th>取代/回退</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in releases" :key="r.id">
          <td>{{ r.id }}</td>
          <td>{{ r.name }}<div class="small muted">{{ r.note }}</div></td>
          <td><span class="badge" :class="statusClass(r.status)">{{ statusText(r.status) }}</span></td>
          <td>{{ r.mappings_snapshot?.mappings?.length ?? '—' }}</td>
          <td>#{{ r.verification_run_id }}</td>
          <td>
            <span v-if="r.status === 'prepared' && r.fresh" class="badge ok">证据新鲜</span>
            <span v-else-if="r.status === 'prepared'" class="badge bad">证据已过期</span>
            <span v-else class="muted small">—</span>
            <div v-if="r.status === 'failed' && r.failure_reason" class="small" style="color:var(--bad);max-width:280px">
              <div v-for="(e, i) in r.failure_reason.expired_evidence" :key="i">
                · [{{ evidenceType(e.type) }}]{{ e.source ? ` ${e.source}` : '' }} — {{ e.detail }}
              </div>
            </div>
          </td>
          <td class="small">
            <div v-if="r.replaces_version_id">取代 #{{ r.replaces_version_id }}</div>
            <div v-if="r.rolled_back_to" style="color:var(--warn)">回退到 #{{ r.rolled_back_to }}</div>
          </td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="open(r.id)">证据/差异</a>
            <template v-if="r.status === 'prepared'"> ·
              <a href="#" @click.prevent="activate(r.id)">激活</a>
            </template>
            <template v-if="r.status === 'active' && r.rollback_target_id"> ·
              <a href="#" @click.prevent="rollback(r.id, r.rollback_target_id)" style="color:var(--warn)">回退到 #{{ r.rollback_target_id }}</a>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 版本详情：差异 + 冻结证据（映射/规则/方案/逐跳） -->
  <div class="panel" v-if="detail">
    <h2>版本 #{{ detail.release.id }} {{ detail.release.name }}
      （{{ statusText(detail.release.status) }}）</h2>

    <h3>与当前 active 的差异</h3>
    <div v-if="!diff || !diff.compared_to" class="muted small">
      {{ detail.release.status === 'active' ? '该版本即当前 active，无差异可比。' : '当前没有其它 active 版本。' }}
    </div>
    <table v-else>
      <thead><tr><th>类型</th><th>链接</th><th>差异</th></tr></thead>
      <tbody>
        <tr v-for="(d, i) in diff.mappings" :key="i">
          <td><span class="badge" :class="diffKindClass(d.kind)">{{ diffKindText(d.kind) }}</span></td>
          <td class="mono">{{ d.source || '（指纹级差异）' }}</td>
          <td class="small">{{ d.detail }}</td>
        </tr>
        <tr v-if="diff.rules_changed">
          <td><span class="badge warn">规则</span></td>
          <td class="muted">—</td><td class="small">两版本冻结的规范化/白名单策略快照不同</td>
        </tr>
        <tr v-if="!diff.mappings.length && !diff.rules_changed">
          <td colspan="3" class="muted small">映射与规则完全一致（差异可能仅在验证运行或方案备注）。</td>
        </tr>
      </tbody>
    </table>

    <h3>冻结的映射快照（{{ detail.release.mappings_fingerprint.slice(0, 22) }}…）</h3>
    <table>
      <thead><tr><th>旧址</th><th>新址</th><th>类型</th><th>验证裁决（绑定运行）</th></tr></thead>
      <tbody>
        <tr v-for="m in detail.release.mappings_snapshot.mappings" :key="m.source_norm">
          <td class="mono">{{ m.source_raw }}</td>
          <td class="mono">{{ m.mapping_type === 'deleted' ? '（410/404 消亡）' : m.target_raw }}</td>
          <td>{{ m.mapping_type === 'deleted' ? '已删除' : '迁移' }}</td>
          <td>
            <span v-if="hopsFor(m.source_norm).length" class="muted small">
              {{ hopsFor(m.source_norm).length }} 跳逐跳证据已随运行 #{{ detail.release.verification_run_id }} 冻结
            </span>
            <a href="#" v-if="shownHopKey !== m.source_norm" @click.prevent="shownHopKey = m.source_norm"
               class="small" style="margin-left:6px">展开</a>
            <a href="#" v-else @click.prevent="shownHopKey = null" class="small" style="margin-left:6px">收起</a>
            <table v-if="shownHopKey === m.source_norm" style="margin-top:6px">
              <thead><tr><th>#</th><th>URL（规范化）</th><th>状态</th><th>Location</th></tr></thead>
              <tbody>
                <tr v-for="h in hopsFor(m.source_norm)" :key="h.hop_index">
                  <td>{{ h.hop_index }}</td><td class="mono">{{ h.url_norm }}</td>
                  <td>{{ h.status_code ?? '—' }}</td><td class="mono">{{ h.location_raw || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>

    <h3>冻结的规范化 / 白名单策略快照</h3>
    <pre class="evidence">{{ JSON.stringify(detail.release.rules_snapshot, null, 2) }}</pre>

    <h3>该版本相关审计（不可变账本的一部分）</h3>
    <table>
      <thead><tr><th>#</th><th>动作</th><th>明细</th><th>时间</th></tr></thead>
      <tbody>
        <tr v-for="a in detail.audits" :key="a.id">
          <td>{{ a.id }}</td>
          <td><span class="badge" :class="auditClass(a.action)">{{ auditText(a.action) }}</span></td>
          <td class="mono small">{{ JSON.stringify(a.detail) }}</td>
          <td class="small">{{ fmt(a.occurred_at) }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 演练控制台 -->
  <DrillConsole @drilled="onDrilled" />

  <!-- 全量不可变审计 -->
  <div class="panel">
    <h2>不可变审计账本（只增不改；激活/回退与版本切换在同一事务）</h2>
    <table>
      <thead><tr><th>#</th><th>版本</th><th>动作</th><th>明细</th><th>时间</th></tr></thead>
      <tbody>
        <tr v-for="a in audit" :key="a.id">
          <td>{{ a.id }}</td><td>#{{ a.release_id }} {{ a.release_name }}</td>
          <td><span class="badge" :class="auditClass(a.action)">{{ auditText(a.action) }}</span></td>
          <td class="mono small">{{ JSON.stringify(a.detail) }}</td>
          <td class="small">{{ fmt(a.occurred_at) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import DrillConsole from '../components/DrillConsole.vue';

const props = defineProps({ refreshKey: Number });
defineEmits(['changed']);

const releases = ref([]);
const activeId = ref(null);
const activeInfo = ref(null);
const audit = ref([]);
const newName = ref('');
const newNote = ref('');
const preparing = ref(false);
const prepareError = ref('');
const prepareResult = ref(null);
const detail = ref(null);
const diff = ref(null);
const shownHopKey = ref(null);

const rollbackTarget = computed(() => {
  const a = activeInfo.value?.release;
  if (!a || a.replaces_version_id == null) return null;
  return releases.value.find(
    (r) => r.id === a.replaces_version_id && r.status === 'superseded') ?? null;
});

async function load() {
  const [list, act] = await Promise.all([
    api.releases(),
    api.activeRelease().catch(() => null),
  ]);
  releases.value = list.releases;
  activeId.value = list.active_id;
  activeInfo.value = act;
  audit.value = (await api.releaseAudit()).audit;
  if (detail.value) await open(detail.value.release.id);
}

async function prepare() {
  if (!newName.value.trim()) { prepareError.value = '版本名称必填'; return; }
  preparing.value = true; prepareError.value = ''; prepareResult.value = null;
  try {
    await api.prepareRelease({ name: newName.value.trim(), note: newNote.value.trim() || null });
    newName.value = ''; newNote.value = '';
  } catch (e) {
    prepareResult.value = e.body ?? {};
    if (!prepareResult.value.blockers) prepareError.value = e.message;
  } finally {
    preparing.value = false;
    await load();
  }
}

async function activate(id) {
  actionError.value = '';
  try {
    await api.activateRelease(id);
  } catch (e) {
    alert(`${e.message}\n\n${(e.body?.stale?.summary ?? []).join('\n')}`);
  }
  await load();
}

async function rollback(id, toId) {
  try {
    await api.rollbackRelease(id, toId);
  } catch (e) {
    alert(e.message);
  }
  await load();
}

async function open(id) {
  detail.value = await api.release(id);
  diff.value = await api.releaseDiff(id).catch(() => null);
  shownHopKey.value = null;
}

function hopsFor(key) {
  return detail.value?.hops?.[key] ?? [];
}
function onDrilled() { load(); }

function statusText(s) {
  return { prepared: '已准备', active: '激活中', superseded: '被取代',
    rolled_back: '已回退', failed: '已失效' }[s] || s;
}
function statusClass(s) {
  return { prepared: 'warn', active: 'ok', superseded: 'neutral',
    rolled_back: 'warn', failed: 'bad' }[s] || 'neutral';
}
function evidenceType(t) {
  return { mapping: '映射', rules: '规则', verification: '验证结果' }[t] || t;
}
function diffKindText(k) {
  return { input_added: '录入新增', input_removed: '录入删除', input_changed: '录入变更',
    mapping_added: '映射新增', mapping_removed: '映射删除', mapping_changed: '映射变更',
    unknown: '其它差异' }[k] || k;
}
function diffKindClass(k) {
  return k.includes('removed') ? 'bad' : k.includes('changed') || k === 'unknown' ? 'warn' : 'ok';
}
function auditText(a) {
  return { prepared: '准备', activated: '激活', superseded: '被取代',
    rolled_back: '回退', reactivated: '恢复激活', failed: '失效' }[a] || a;
}
function auditClass(a) {
  return a === 'activated' || a === 'reactivated' ? 'ok'
    : a === 'failed' || a === 'rolled_back' ? 'bad'
      : a === 'superseded' ? 'warn' : 'neutral';
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }

onMounted(load);
watch(() => props.refreshKey, load);
</script>
