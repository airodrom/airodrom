'use strict';

const SDK_VERSION = '1.0.0';
const KERNEL_VERSION = '1.2.0';
const ID = /^[a-z][a-z0-9.-]{1,63}$/;
const OPERATIONS = Object.freeze({
  mission: ['create', 'inspect', 'dispatch', 'cancel'],
  memory: ['retrieve'], context: ['build'], provider: ['plan', 'execute'],
  review: ['request'], settlement: ['accept'], health: ['task'],
  authority: ['check'], events: ['publish'], scheduler: ['suggest']
});

// Host construction only: no bridge, database, credential resolver or raw
// executor is handed to an app. Authorization is checked on every operation.
function createSDK({ appId, ports, authorize } = {}) {
  if (typeof appId !== 'string' || !ID.test(appId) || !ports || typeof authorize !== 'function') throw Error('Host-bound SDK authorization required');
  const boundPorts = Object.freeze({ ...ports });
  const sdk = { version: SDK_VERSION, kernelVersion: KERNEL_VERSION, appId };
  for (const [surface, methods] of Object.entries(OPERATIONS)) {
    sdk[surface] = Object.freeze(Object.fromEntries(methods.map(method => [method, async (...args) => {
      const operation = `${surface}.${method}`;
      const input = structuredClone(args);
      // A policy callback gets its own snapshot; it cannot rewrite execution.
      if (await authorize({ appId, operation, args: structuredClone(input) }) !== true) throw Error('SDK operation denied');
      const port = boundPorts[operation];
      if (typeof port !== 'function') throw Error('SDK operation unavailable');
      return structuredClone(await port(...input));
    }])));
  }
  return Object.freeze(sdk);
}
module.exports = { SDK_VERSION, KERNEL_VERSION, OPERATIONS, createSDK };
