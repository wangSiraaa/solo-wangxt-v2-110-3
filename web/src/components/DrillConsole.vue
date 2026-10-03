<template>
  <div class="panel">
    <h2>本地站点上线演练（故障注入仅作用于 127.0.0.1 白名单站点）</h2>
    <p class="muted small">
      演练对<b>当前 active 版本冻结的映射快照</b>逐跳真实请求随项目启动的本地站点。
      故障注入是进程内、非持久化的：工作台重启自动清空，注入的跳转目标也必须留在白名单内。
    </p>

    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:1">
        <span>故障类型</span>
        <select v-model="form.kind">
          <option value="final_status">最终状态码异常（如 500）</option>
          <option value="redirect">本地直跳改道（仍限白名单）</option>
        </select>
      </label>
      <label class="field" style="flex:2">
        <span>精确路径 pathname（如 /articles/123-v2 或 /news/123）</span>
        <input v-model="form.path" placeholder="/articles/123-v2" />
      </label>
      <label class="field" style="flex:1">
        <span>{{ form.kind === 'final_status' ? '状态码' : '跳转路径' }}</span>
        <input v-model="form.value" :placeholder="form.kind === 'final_status' ? '500' : '/articles/123-v2'" />
      </label>
      <div style="white-space:nowrap">
        <button class="btn secondary" @click="inject">注入故障</button>
        <button class="btn secondary" @click="clear" style="margin-left:6px">清空</button>
      </div>
    </div>
    <span v-if="error" class="badge bad" style="margin:6px 0;display:inline-block">{{ error }}</span>

    <table v-if="faults.length" style="margin-top:8px">
      <thead><tr><th>类型</th><th>路径</th><th>值</th></tr></thead>
      <tbody>
        <tr v-for="(f, i) in faults" :key="i">
          <td>{{ f.kind === 'final_status' ? '状态码异常' : '改道 302' }}</td>
          <td class="mono">{{ f.path }}</td><td class="mono">{{ f.value }}</td>
        </tr>
      </tbody>
    </table>

    <div style="margin-top:10px">
      <button class="btn" :disabled="running" @click="run">
        {{ running ? '演练中（真实请求本地站点）…' : '对当前 active 版本执行演练' }}
      </button>
    </div>

    <div v-if="last" style="margin-top:12px">
      <div :class="['callout', last.verdict === 'pass' ? 'ok' : 'bad']">
        <b>{{ last.verdict === 'pass' ? '✅ 演练通过' : '🚨 演练发现异常' }}</b>
        —— 共 {{ last.results.length }} 条，异常 {{ anomalyCount }} 条；
        基于版本 <b>{{ last.release_name }}</b> 的映射快照
        <code>{{ short(last.mappings_fingerprint) }}</code>
      </div>
      <table>
        <thead><tr><th>裁决</th><th>旧址</th><th>期望落点</th><th>实际最终</th><th>状态</th><th>跳数</th><th>问题</th></tr></thead>
        <tbody>
          <tr v-for="r in last.results" :key="r.source_norm">
            <td>
              <span class="badge" :class="good.has(r.verdict) ? 'ok' : 'bad'">{{ label[r.verdict] ?? r.verdict }}</span>
            </td>
            <td class="mono">{{ r.source_raw }}</td>
            <td class="mono">{{ r.expected_norm || '（410/404 消亡）' }}</td>
            <td class="mono">{{ r.final_url_raw || '—' }}</td>
            <td>{{ r.final_status ?? '—' }}</td>
            <td>{{ r.hops.length }}</td>
            <td>
              <ul v-if="r.issues.length" class="issues"><li v-for="(x, k) in r.issues" :key="k">{{ x }}</li></ul>
              <span v-else class="muted small">无</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['drilled']);
const faults = ref([]);
const running = ref(false);
const last = ref(null);
const error = ref('');
const form = ref({ kind: 'final_status', path: '/articles/123-v2', value: '500' });
const good = new Set(['ok', 'deleted_gone_ok']);
const label = {
  ok: '通过', redirect_loop: '重定向环', chain_too_long: '链过长',
  fetch_error: '请求失败', deleted_gone_ok: '消亡正确',
  deleted_not_gone: '未消亡', ambiguity: '歧义', final_status_bad: '最终页异常',
};
const anomalyCount = () => (last.value?.results ?? []).filter((r) => !good.has(r.verdict)).length;
const short = (h) => (h || '').slice(0, 18);

async function loadFaults() { faults.value = (await api.drillFaults()).active_faults; }
async function inject() {
  error.value = '';
  const f = form.value;
  try {
    const payload = [...faults.value, {
      kind: f.kind, path: f.path,
      value: f.kind === 'final_status' ? Number(f.value) : f.value,
    }];
    faults.value = (await api.setDrillFaults(payload)).active_faults;
  } catch (e) { error.value = e.message; }
}
async function clear() {
  await api.clearDrillFaults();
  await loadFaults();
}
async function run() {
  running.value = true; error.value = '';
  try {
    const d = await api.drillRun();
    last.value = d.drill;
    emit('drilled', d);
  } catch (e) { error.value = e.message; }
  finally { running.value = false; }
}
onMounted(loadFaults);
</script>
