const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
};

export const api = {
  rules: () => fetch('/api/rules').then(j),
  mappings: () => fetch('/api/mappings').then(j),
  addMapping: (payload) =>
    fetch('/api/mappings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  normalize: (urls) =>
    fetch('/api/normalize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    }).then(j),
  verify: (sourceNorm = null) =>
    fetch('/api/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sourceNorm ? { source_norm: sourceNorm } : {}),
    }).then(j),
  crawl: (key) =>
    fetch('/api/crawl/' + encodeURIComponent(key)).then(j),
  plans: () => fetch('/api/plans').then(j),
  plan: (id) => fetch(`/api/plans/${id}`).then(j),
  createPlan: (name) =>
    fetch('/api/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(j),
  buildPlan: (id) =>
    fetch(`/api/plans/${id}/build`, { method: 'POST' }).then(j),
  publishPlan: (id) =>
    fetch(`/api/plans/${id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(j),

  // 发布版本与回退账本
  releases: () => fetch('/api/releases').then(j),
  release: (id) => fetch(`/api/releases/${id}`).then(j),
  prepareRelease: (planId, name) =>
    fetch('/api/releases/prepare', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan_id: planId, name: name || null }),
    }).then(j),
  activateRelease: (id) =>
    fetch(`/api/releases/${id}/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(j),
  rollbackRelease: (targetId = null, fromVersion = null) =>
    fetch('/api/releases/rollback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(targetId || fromVersion
        ? { target_id: targetId || null, from_version: fromVersion || null }
        : {}),
    }).then(j),
  drillRelease: (id, kind = 'post_activation') =>
    fetch(`/api/releases/${id}/drill`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    }).then(j),
  injectFault: (path, status = 500) =>
    fetch('/api/fixture/fault', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, status }),
    }).then(j),
  clearFaults: () =>
    fetch('/api/fixture/fault', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: null }),
    }).then(j),
};
