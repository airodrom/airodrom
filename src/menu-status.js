'use strict';
// Menu-bar indicator from observed evidence only. A live Node.js process is not an
// operational control plane: only an answering product status can be Healthy.
const CATEGORIES = Object.freeze({
  healthy: 'Airodrom is healthy',
  starting: 'Airodrom is starting',
  degraded: 'Airodrom is degraded',
  maintenance: 'Airodrom is in maintenance',
  disconnected: 'Airodrom is disconnected',
  unknown: 'Airodrom status is unknown'
});

// state: product-control state ('Stopped' | 'Connected' | 'Error'); product: native status;
// admission: lifecycle gate or null; supervisor: managed supervisor state (ADR 0031) or null.
function indicator({ state = null, product = null, admission = null, supervisor = null } = {}) {
  let category;
  if (['STARTING', 'RECOVERING'].includes(supervisor)) category = 'starting';
  else if (state === 'Stopped') category = 'disconnected';
  else if (state !== 'Connected' || !product) category = state === 'Error' ? 'disconnected' : 'unknown';
  else if (admission && admission.state !== 'open') category = 'maintenance';
  else if (supervisor === 'BLOCKED' || supervisor === 'DEGRADED' || product.quarantined_leases > 0 || [product.control, product.runtime, product.memory].some(v => v !== 'Ready')) category = 'degraded';
  else category = 'healthy';
  const detail = category === 'maintenance' ? (admission.blockers?.runs ? admission.blockers.runs + ' unresolved runs' : 'admission closed')
    : category === 'degraded' ? [['Control', product?.control], ['OpenCode', product?.runtime], ['Memory', product?.memory]].filter(([, v]) => v && v !== 'Ready').map(([k, v]) => k + ' ' + v).join(', ') || 'recovery attention needed'
    : category === 'disconnected' ? (state === 'Stopped' ? 'service stopped' : 'control plane not answering') : null;
  return { category, label: category[0].toUpperCase() + category.slice(1), description: CATEGORIES[category] + (detail ? ' — ' + detail : '') };
}

module.exports = { indicator, CATEGORIES };
