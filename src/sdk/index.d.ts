export const SDK_VERSION: '1.0.0';
export const KERNEL_VERSION: '1.2.0';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Input = { [key: string]: Json };
export type Operation = 'mission.create' | 'mission.inspect' | 'mission.dispatch' | 'mission.cancel' |
  'memory.retrieve' | 'context.build' | 'provider.plan' | 'provider.execute' | 'review.request' |
  'settlement.accept' | 'health.task' | 'authority.check' | 'events.publish' | 'scheduler.suggest';
export interface AuthorizationRequest { appId: string; operation: Operation; args: Json[] }
export interface AirodromSDK {
  readonly version: '1.0.0'; readonly kernelVersion: '1.2.0'; readonly appId: string;
  readonly mission: {
    create(input: Input): Promise<Json>;
    inspect(id: string): Promise<Json>;
    dispatch(id: string, input: { request_id: string }): Promise<Json>;
    cancel(id: string, input: { request_id: string }): Promise<Json>;
  };
  readonly memory: { retrieve(missionId: string): Promise<Json> };
  readonly context: { build(missionId: string): Promise<Json> };
  readonly provider: { plan(input: Input): Promise<Json>; execute(input: Input): Promise<Json> };
  readonly review: { request(missionId: string, input: Input): Promise<Json> };
  readonly settlement: { accept(missionId: string, input: Input): Promise<Json> };
  readonly health: { task(taskId: string): Promise<Json> };
  readonly authority: { check(missionId: string, requirements?: Input): Promise<Json> };
  readonly events: { publish(missionId: string, type: string, metadata?: Input): Promise<Json> };
  readonly scheduler: { suggest(input?: { projectId?: string }): Promise<Json> };
}
export const OPERATIONS: Readonly<Record<string, readonly string[]>>;
export function createSDK(options: {
  appId: string;
  ports: Partial<Record<Operation, (...args: any[]) => Json | Promise<Json>>>;
  authorize: (request: AuthorizationRequest) => boolean | Promise<boolean>;
}): AirodromSDK;
/** @deprecated Use AirodromSDK. Retained for existing integrations. */
export type PiSDK = AirodromSDK;
