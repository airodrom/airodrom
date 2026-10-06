import { AuthorityStore } from '../../src/authority-store';
import type { AuthorityQueries, Coordinates } from '../../src/authority-types';
import type { DatabaseSync } from 'node:sqlite';
function consume(db: DatabaseSync) {
  const store: AuthorityQueries = new AuthorityStore(db);
  return {mission:store.getCurrentMissionProjection('mission'),result:store.getResult('run'),evidence:store.listVerificationsForMission('mission'),ledger:store.readLedger('project',0,100)};
}
function events(store:AuthorityStore) {
  store.append('mission.created',{version:1,mission_id:'mission',revision:1,content_hash:'hash'});
  // @ts-expect-error Event payload is tied to its discriminator.
  store.append('mission.created',{version:1,run_id:'run'});
  // @ts-expect-error No free-form authority event names.
  store.append('agent.accepted',{version:1});
}
void consume;void events;

const opencodeCoordinates: Coordinates = {agentId:'opencode',runtimeId:'opencode'};
// @ts-expect-error Unknown executors cannot become typed authority identities.
const unknownCoordinates: Coordinates = {agentId:'unknown_executor',runtimeId:'unknown'};
void opencodeCoordinates;void unknownCoordinates;
