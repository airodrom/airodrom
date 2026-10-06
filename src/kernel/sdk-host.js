'use strict';
const { createSDK } = require('../sdk');
const { safeValue } = require('../secret-observation');

function createAppSDK(bridge, { appId, owner = 'mcp', authorize } = {}) {
  if (!['operator', 'mcp'].includes(owner)) throw Error('Unsupported SDK principal');
  const mission = id => bridge.missions.require(id, owner);
  const context = id => bridge.controlContext.build(mission(id));
  return createSDK({ appId, authorize, ports: {
    'mission.create': input => bridge.missions.create(input, owner),
    'mission.inspect': id => bridge.missions.detail(id, owner),
    'mission.dispatch': (id, input) => bridge.missions.dispatch(id, input, owner),
    'mission.cancel': (id, input) => bridge.missions.cancel(id, input, owner),
    'memory.retrieve': context,
    'context.build': context,
    'provider.plan': input => bridge.providerGateway.plan(input),
    'provider.execute': input => bridge.providerGateway.execute(input),
    'review.request': (id, input) => bridge.missions.reverify(id, input, owner),
    'settlement.accept': (id, input) => bridge.missions.accept(id, input, owner),
    'authority.check': (id, requirements) => {
      bridge.missions.assertAuthority(mission(id), requirements);
      return { allowed: true, authority_source: 'existing_mission' };
    },
    'health.task': id => {
      const task = bridge.tasks.get(id);
      if (!task?.controlPlaneMissionId) throw Error('Mission Task required');
      mission(task.controlPlaneMissionId);
      return bridge.taskHealth(task);
    },
    'events.publish': (id, type, metadata = {}) => {
      mission(id);
      if (typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(type)) throw Error('Invalid app event');
      if (Buffer.byteLength(JSON.stringify(metadata)) > 8000) throw Error('App event exceeds bound');
      bridge.controlStore.event(`app.${appId}.${type}`, id, safeValue(metadata));
      return { published: true, execution_authority: false };
    },
    // The scheduling implementation is host owned; this returns advice only.
    'scheduler.suggest': input => bridge.nextActions.choose(input)
  } });
}
module.exports = { createAppSDK };
