<template>
  <div class="panel">
    <h2>规范化规则（集中定义，不可在代码里临时解码合并）</h2>
    <ol class="small">
      <li>解析器：WHATWG <code>URL</code>（Node 全局），不手写 split，不做 <code>decodeURIComponent</code> 后比较。</li>
      <li>scheme/host 转小写；默认端口去除；路径<b>大小写敏感</b>——<code>/News</code> 与 <code>/news</code> 是不同资源。</li>
      <li>百分号编码：仅统一十六进制大小写（<code>%2f→%2F</code>），<b>绝不解码</b>；原始中文经 WHATWG 以 UTF-8 编码；
        <code>%2F</code> 不视为分隔符，<code>/files%2Fdraft</code> 与 <code>/files/draft</code> 不合并。</li>
      <li>尾斜杠：当前 <code>{{ rules.rules?.tailSlashMode }}</code>，<code>/column/weekly/</code> 与 <code>/column/weekly</code> 身份不同。</li>
      <li>查询参数：未登记参数一律参与资源身份；追踪参数不参与身份，
        但生成迁移跳转时<b>原样带到最终 URL</b>。</li>
      <li>fragment 不参与身份，直接丢弃。</li>
      <li>多旧址归一后同键却指向不同目标 → 歧义，冲突行 <code>conflicted</code> 不生效、不请求、阻断发布。</li>
    </ol>
  </div>

  <div class="panel">
    <h2>验证器纪律与白名单（只读安全边界）</h2>
    <ul class="small">
      <li>白名单：只允许 <b>{{ rules.allowlist?.origin }}</b>（随项目启动的本地站点），DNS 不参与；
        每一跳 Location 重新解析并重新过白名单（防 SSRF）。白名单来自启动环境，<b>任何 API 都不能改</b>。</li>
      <li>环检测：归一化 URL 在同链中重复即 <code>redirect_loop</code>，立即停止。</li>
      <li>长链：最多跟随 {{ rules.crawl?.maxRedirects }} 跳，仍给 Location 即 <code>chain_too_long</code>。</li>
      <li>最终状态必须核实：普通迁移期望 2xx 且落点等于映射目标；已删除栏目期望 410（也接受 404）。</li>
      <li>所有跳与裁决都写 PostgreSQL；发布版本另存不可变的完整验证运行快照。</li>
    </ul>
    <pre class="evidence">{{ JSON.stringify(rules, null, 2) }}</pre>
  </div>

  <div class="panel">
    <h2>运行时规则微调（策略版本 v{{ policyVersion }}）</h2>
    <p class="muted small">
      只能调整不触及白名单的规则参数。<b>保存后策略版本 +1，所有已 prepared、未激活的版本
      会因规则快照过期而无法激活</b>（已冻结的历史版本快照不受影响）。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:1">
        <span>尾斜杠策略</span>
        <select v-model="form.tailSlashMode">
          <option value="keep">keep（保留，默认）</option>
          <option value="ignore">ignore（查表键去尾斜杠，合并且产生歧义会被拦截）</option>
        </select>
      </label>
      <label class="field" style="flex:1">
        <span>最大跳转数</span>
        <input type="number" v-model.number="form.maxRedirects" min="0" max="20" />
      </label>
      <label class="field" style="flex:1">
        <span>超时（毫秒）</span>
        <input type="number" v-model.number="form.timeoutMs" min="100" max="30000" step="100" />
      </label>
    </div>
    <label class="field">
      <span>追踪参数名单（逗号分隔，改动会使 prepared 版本的规则指纹过期）</span>
      <input v-model="trackersText" />
    </label>
    <button class="btn" @click="save">保存规则微调</button>
    <span v-if="saved" class="badge ok" style="margin-left:10px">已保存，策略版本 {{ policyVersion }}</span>
    <span v-if="error" class="badge bad" style="margin-left:10px">{{ error }}</span>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
const rules = ref({});
const policyVersion = ref(0);
const form = ref({ tailSlashMode: 'keep', maxRedirects: 5, timeoutMs: 4000 });
const trackersText = ref('');
const saved = ref(false);
const error = ref('');

async function load() {
  rules.value = await api.rules();
  policyVersion.value = rules.value.policyVersion ?? 0;
  form.value = {
    tailSlashMode: rules.value.rules.tailSlashMode,
    maxRedirects: rules.value.crawl.maxRedirects,
    timeoutMs: rules.value.crawl.timeoutMs,
  };
  trackersText.value = rules.value.rules.trackerParams.join(', ');
}
async function save() {
  saved.value = false; error.value = '';
  try {
    const patch = { ...form.value, trackerParams: parseTrackers(trackersText.value) };
    const r = await api.updateRules(patch);
    policyVersion.value = r.policyVersion;
    saved.value = true;
    await load();
  } catch (e) { error.value = e.message; }
}
function parseTrackers(text) {
  return text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
onMounted(load);
</script>
