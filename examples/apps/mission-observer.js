'use strict';
// New apps receive only a host-issued SDK. They do not import bridge internals.
module.exports = async function missionObserver(sdk, missionId) {
  const mission = await sdk.mission.inspect(missionId);
  return { app: sdk.appId, sdk: sdk.version, mission };
};
