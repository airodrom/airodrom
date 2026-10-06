import type { DatabaseSync } from 'node:sqlite';
import type { Actor, AuthorityQueries, JsonValue, LedgerPayloads, Sha256 } from './authority-types';
export interface AuthorityStore extends AuthorityQueries {}
export class AuthorityStore {
  constructor(db: DatabaseSync, options?: {now?:()=>number;operatorId?:string});
  readonly db: DatabaseSync;
  readonly operator: Actor;
  readonly host: Actor;
  readonly operatorId: string;
  append<K extends keyof LedgerPayloads>(kind: K, payload: LedgerPayloads[K], context?: {projectId?:string;missionId?:string;revision?:number;runId?:string;by?:Actor}): JsonValue;
  createProject(input:{id?:string;slug?:string;name:string;status?:string},by?:Actor): JsonValue;
  createGoal(input:{id?:string;project_id:string;parent_goal_id?:string;title:string;description?:string;status?:string},by?:Actor):JsonValue;
  createMission(input:{id?:string;project_id?:string;goal_id?:string;task_id?:string;owner?:string;acceptance_strength?:string;envelope:JsonValue},by?:Actor):JsonValue;
  reviseMission(id:string,envelope:JsonValue,expectedRevision:number,by?:Actor):JsonValue;
  checkpoint(input:{id?:string;project_id:string;mission_id:string;mission_revision:number;run_id?:string;workspace_snapshot_hash:Sha256;artifact_manifest_hash:Sha256;context_pack_hash:Sha256},by?:Actor):JsonValue;
  integrity():{ok:boolean;sqlite:string[];foreign_key_violations:number;ledger:JsonValue;schema_version:number};
}
export function json(value:JsonValue):string;
/** @deprecated Content-derived identity generation is forbidden. */
export function hashId(value:JsonValue):never;
export function safe<T extends JsonValue>(value:T):T;
export function actor(value:Actor,allowed?:Actor['type'][]):Actor;
export const LOCAL_PROJECT:string;
