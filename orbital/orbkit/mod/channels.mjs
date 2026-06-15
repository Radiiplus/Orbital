import { closeGraphqlWebSocketClient, subscribeGraphqlStream } from './graphqlws.mjs';
import { getContractStructure } from './structure.mjs';

export const CHANNELS = {
  devnetBalance: 'subscription DevnetBalance($address: String!) { devnetBalance(address: $address) { address balanceShannons balanceCkb updatedAt } }',
  devnetFundWallet: 'subscription DevnetFundWallet($address: String!, $amountCkb: Float!) { devnetFundWallet(address: $address, amountCkb: $amountCkb) { requestId status txHash error updatedAt } }',
  devnetCreateWallet: 'subscription DevnetCreateWallet { devnetCreateWallet { address lockArg publicKey privateKey mnemonic network } }',
  buildRequest: 'subscription BuildRequest($network: String!, $contractPath: String!, $action: String!) { buildRequest(network: $network, contractPath: $contractPath, action: $action) { requestId action network status contractPath tx unsignedTx updatedAt } }',
};

export function classifyBuildDeployMode(network, action) {
  const normalizedNetwork = String(network || '').trim().toLowerCase();
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (normalizedAction !== 'build' && normalizedAction !== 'deploy') {
    throw new Error(`Unsupported action: ${action}`);
  }
  if (normalizedNetwork === 'devnet') {
    return normalizedAction === 'deploy'
      ? 'devnet-local-sign-and-broadcast'
      : 'devnet-local-build';
  }
  if (normalizedNetwork === 'testnet' || normalizedNetwork === 'mainnet') {
    return normalizedAction === 'deploy'
      ? 'remote-build-return-tx'
      : 'remote-build-return-result';
  }
  throw new Error(`Unsupported network: ${network}`);
}

export function normalizeBuildDeployEvent(payload) {
  const event = payload?.data?.buildRequest || payload?.buildRequest || null;
  if (!event) return null;
  const mode = classifyBuildDeployMode(event.network, event.action);
  return {
    ...event,
    mode,
    shouldOrbkitBroadcast: mode === 'devnet-local-sign-and-broadcast',
    shouldServerHandleSigning: mode === 'remote-build-return-tx',
  };
}

export async function subscribeDevnetBalance(input = {}) {
  return subscribeGraphqlStream({
    ...input,
    query: CHANNELS.devnetBalance,
    variables: {
      address: input.address,
    },
  });
}

export async function subscribeDevnetFundWallet(input = {}) {
  return subscribeGraphqlStream({
    ...input,
    query: CHANNELS.devnetFundWallet,
    variables: {
      address: input.address,
      amountCkb: input.amountCkb,
    },
  });
}

export async function subscribeDevnetCreateWallet(input = {}) {
  return subscribeGraphqlStream({
    ...input,
    query: CHANNELS.devnetCreateWallet,
    variables: {},
  });
}

export async function subscribeBuildDeploy(input = {}) {
  return subscribeGraphqlStream({
    ...input,
    query: CHANNELS.buildRequest,
    variables: {
      network: input.network,
      contractPath: input.contractPath,
      action: input.action,
    },
    onNext: (payload) => {
      const normalized = normalizeBuildDeployEvent(payload);
      input.onNext?.(normalized);
    },
    onError: input.onError,
    onComplete: input.onComplete,
  });
}

export async function subscribeStructure(input = {}) {
  const structure = getContractStructure({
    contractPath: input.contractPath,
    configPath: input.configPath,
    workspaceRoot: input.workspaceRoot,
  });
  const payload = {
    data: {
      structure,
    },
  };
  input.onNext?.(payload);
  input.onComplete?.();
  return {
    id: 'structure-local',
    completed: Promise.resolve(),
    unsubscribe: () => {},
  };
}

export function closeChannelClient(input = {}) {
  closeGraphqlWebSocketClient(input);
}
