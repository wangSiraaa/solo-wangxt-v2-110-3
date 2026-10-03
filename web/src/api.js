const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.error || `HTTP ${r.status}`);
    e.body = body;
    throw e;
  }
  return body;
};

const jsonPost = (url, payload) =>
  fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }).then(j);

export const api = {
  rules: () => fetch('/api/rules').then(j),
  updateRules: (patch) =>
    fetch('/api/rules', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(j),
  mappings: () => fetch('/api/mappings').then(j),
  addMapping: (payload) => jsonPost('/api/mappings', payload),
  deleteMappingInput: (id) =>
    fetch(`/api/mappings/inputs/${id}`, { method: 'DELETE' }).then(j),
  normalize: (urls) => jsonPost('/api/normalize', { urls }),
  verify: (sourceNorm = null) =>
    jsonPost('/api/verify', sourceNorm ? { source_norm: sourceNorm } : {}),
  crawl: (key) =>
    fetch('/api/crawl/' + encodeURIComponent(key)).then(j),
  plans: () => fetch('/api/plans').then(j),
  plan: (id) => fetch(`/api/plans/${id}`).then(j),
  createPlan: (name) => jsonPost('/api/plans', { name }),
  buildPlan: (id) => jsonPost(`/api/plans/${id}/build`, {}),
  publishPlan: (id) => jsonPost(`/api/plans/${id}/publish`, {}),

  // 发布版本账本
  releases: () => fetch('/api/releases').then(j),
  activeRelease: () => fetch('/api/releases/active').then(j),
  release: (id) => fetch(`/api/releases/${id}`).then(j),
  releaseDiff: (id) => fetch(`/api/releases/${id}/diff`).then(j),
  releaseAudit: () => fetch('/api/releases/audit').then(j),
  prepareRelease: (payload) => jsonPost('/api/releases/prepare', payload),
  activateRelease: (id) => jsonPost(`/api/releases/${id}/activate`, {}),
  rollbackRelease: (id, toVersionId = null) =>
    jsonPost(`/api/releases/${id}/rollback`, { to_version_id: toVersionId }),

  // 本地站点演练
  drillRun: (releaseId = null) => jsonPost('/api/drill/run', { release_id: releaseId }),
  drillRuns: (releaseId = null) =>
    fetch('/api/drill/runs' + (releaseId ? `?release_id=${releaseId}` : '')).then(j),
  drillFaults: () => fetch('/api/drill/faults').then(j),
  setDrillFaults: (faultsList) => jsonPost('/api/drill/faults', { faults: faultsList }),
  clearDrillFaults: () => fetch('/api/drill/faults', { method: 'DELETE' }).then(j),
};
