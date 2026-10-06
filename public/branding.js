'use strict';
// Shared public metadata only: never put configuration or credentials here.
(function (root) {
  const branding = Object.freeze({
    name: 'Airodrom', slug: 'airodrom', website: 'https://airodrom.io',
    tagline: 'Build AI systems that operate.',
    kernel: 'Airodrom Kernel', sdk: 'Airodrom SDK', runtime: 'Airodrom Runtime',
    apps: 'Airodrom Apps', controlCenter: 'Airodrom Control Center',
    controlHub: 'Airodrom Control Hub',
    legacyPackage: 'pi-chatgpt-bridge', legacyMcpName: 'pi-chatgpt-bridge'
  });
  if (typeof module === 'object' && module.exports) module.exports = branding;
  else {
    root.AirodromBranding = branding;
    const apply = () => {
      document.querySelectorAll('[data-brand]').forEach(element => {
        const value = branding[element.dataset.brand];
        if (typeof value === 'string') element.textContent = value;
      });
      document.querySelectorAll('[data-brand-label]').forEach(element => {
        const value = branding[element.dataset.brandLabel];
        if (typeof value === 'string') element.setAttribute('aria-label', value);
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
    else apply();
  }
})(typeof globalThis === 'object' ? globalThis : this);
