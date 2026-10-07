import { createSDK, type PiSDK, type AirodromSDK } from '../../src/sdk';
import { AppRegistry } from '../../src/sdk/app-registry';
async function extension(sdk: PiSDK) {
  await sdk.mission.inspect('mission');
  await sdk.context.build('mission');
  await sdk.provider.execute({ request_id: 'request' });
  // @ts-expect-error No bridge or database access in the app surface.
  sdk.bridge.controlStore;
  // @ts-expect-error Dispatch requires a durable request identity.
  await sdk.mission.dispatch('mission', {});
  // @ts-expect-error No merge/deploy surface.
  await sdk.settlement.merge('mission');
  // @ts-expect-error Version is immutable.
  sdk.version = '2.0.0';
}
const sdk = createSDK({ appId: 'observer', authorize: () => false, ports: {} });
const registry = new AppRegistry();
registry.register({ manifest: { id: 'observer', version: '1.0.0', sdk: '^1.0.0' } });
void extension; void sdk;

// Both public names preserve the same host-bound contract.
const legacyToCurrent = (sdk: PiSDK): AirodromSDK => sdk;
const currentToLegacy = (sdk: AirodromSDK): PiSDK => sdk;
