'use strict';

const DEFAULT_FORBIDDEN = '3ef593eead7481d79081dab81405a34f';

function normalizeId(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/-/g, '').toLowerCase();
}

function loadConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Notion documentation config required');
  if (config.schema !== 'airodrom.notion-documentation.v1') {
    throw new Error('Unsupported Notion documentation schema');
  }
  if (config.product !== 'Airodrom') throw new Error('Notion documentation product must be Airodrom');
  return config;
}

function resolvePublishParent(config, options = {}) {
  const cfg = loadConfig(config);
  const hubId = normalizeId(cfg.hub?.page_id);
  if (!hubId || hubId.length !== 32) {
    throw new Error('Airodrom Notion hub is not established; publishing refused');
  }
  if (cfg.rules?.require_verified_airodrom_hub !== true || cfg.rules?.fail_closed_without_hub !== true) {
    throw new Error('Airodrom Notion hub ownership rules are not enabled; publishing refused');
  }

  const requested = normalizeId(options.parent_page_id || hubId);
  if (!requested) throw new Error('Publish parent missing; publishing refused');

  const forbidden = new Set([
    normalizeId(DEFAULT_FORBIDDEN),
    ...(Array.isArray(cfg.forbidden_parents) ? cfg.forbidden_parents.map(row => normalizeId(row.page_id)) : [])
  ].filter(Boolean));

  if (forbidden.has(requested)) {
    throw new Error('Publishing under historical Pi Bridge hub is forbidden');
  }
  if (requested !== hubId) {
    throw new Error('Publish parent is not the verified Airodrom Notion hub');
  }
  return {
    ok: true,
    product: 'Airodrom',
    parent_page_id: hubId,
    hub_title: cfg.hub.title,
    documentation_sync_is_not_shipped: cfg.rules.documentation_sync_is_not_shipped === true
  };
}

module.exports = { resolvePublishParent, normalizeId, loadConfig };
