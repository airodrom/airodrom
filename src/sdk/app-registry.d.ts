export interface AppManifest { id: string; version: string; sdk: string }
export interface CapabilityDefinition {
  validate(input: unknown): unknown;
  perform(context: unknown, input: unknown): unknown;
  [key: string]: unknown;
}
export function supports(range: string, version?: string): boolean;
export class AppRegistry {
  register(app: { manifest: AppManifest; capabilities?: Record<string, CapabilityDefinition> }): Readonly<AppManifest>;
  list(): Readonly<AppManifest>[];
  definitions(): Readonly<Record<string, CapabilityDefinition>>;
}
