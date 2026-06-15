import { randomUUID } from 'node:crypto';
import { getWalletBalance } from '../../orbkit/mod/balance.mjs';

const NETWORKS = new Set(['devnet', 'testnet', 'mainnet']);

function randomId() {
  return randomUUID().slice(0, 8);
}

function normalizeAddress(address) {
  return String(address || '').trim();
}

function normalizeNetwork(network) {
  const value = String(network || '').trim().toLowerCase();
  if (!NETWORKS.has(value)) {
    throw new Error('network must be one of: devnet, testnet, mainnet.');
  }
  return value;
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return parseMetadata(JSON.parse(metadata));
    } catch {
      return {};
    }
  }
  if (typeof metadata !== 'object') return {};
  if (typeof metadata.raw === 'string' && Object.keys(metadata).length === 1) {
    return parseMetadata(metadata.raw);
  }
  return metadata;
}

function serviceCapabilities(service) {
  const metadata = parseMetadata(service?.metadata);
  if (!Array.isArray(metadata.capabilities)) return [];
  return metadata.capabilities
    .map((capability) => String(capability || '').trim())
    .filter(Boolean);
}

function hasCapability(service, capability) {
  return serviceCapabilities(service).includes(capability);
}

function resolveOrbkitService(bridge) {
  const state = bridge.getState();
  const orbkits = state.connectedServices.filter((service) => String(service.role || '').trim() === 'orbkit');
  return orbkits.find((service) => hasCapability(service, 'wallet-balance')) || orbkits[0] || null;
}

function extractBalance(result) {
  if (result?.balance !== undefined && result?.balance !== null) return String(result.balance);
  if (result?.result?.spendableShannons !== undefined && result?.result?.spendableShannons !== null) {
    return String(result.result.spendableShannons);
  }
  if (result?.result?.totalShannons !== undefined && result?.result?.totalShannons !== null) {
    return String(result.result.totalShannons);
  }
  if (result?.spendableShannons !== undefined && result?.spendableShannons !== null) {
    return String(result.spendableShannons);
  }
  if (result?.totalShannons !== undefined && result?.totalShannons !== null) {
    return String(result.totalShannons);
  }
  return null;
}

export function createBalanceService({ bridge, publishServiceEvent, configPath, logger } = {}) {
  async function getRemoteBalance(input = {}) {
    const network = normalizeNetwork(input.network);
    const address = normalizeAddress(input.address || input.walletAddress);
    if (!address) return null;

    try {
      const result = await getWalletBalance({
        walletAddress: address,
        network,
        configPath: input.configPath || configPath,
        scanMode: input.scanMode,
        pageLimit: input.pageLimit,
        maxPages: input.maxPages,
      });
      return String(result.spendableShannons ?? result.totalShannons ?? '0');
    } catch (error) {
      logger?.debug?.(
        {
          err: error,
          address,
          network,
        },
        'remote balance lookup failed',
      );
      return null;
    }
  }

  async function getDevnetBalance(input = {}) {
    const address = normalizeAddress(input.address || input.walletAddress);
    if (!address) return null;

    const cached = bridge.getDevnetBalance(address);
    if (cached?.balance !== undefined && input.preferCache !== false) {
      return cached.balance;
    }

    const targetService = resolveOrbkitService(bridge);
    if (!targetService || !publishServiceEvent) {
      return cached?.balance ?? null;
    }

    const requestId = `bal_${randomId()}`;
    const waitPromise = bridge.waitForBalanceResult({
      requestId,
      timeoutMs: input.timeoutMs || 10000,
    });

    try {
      await publishServiceEvent({
        channel: 'wallet-balance-request',
        service: 'orbital-server',
        target: targetService.service,
        direction: 'outbound',
        network: 'devnet',
        body: JSON.stringify({
          requestId,
          address,
          network: 'devnet',
          scanMode: input.scanMode || 'full',
        }),
      });
    } catch (error) {
      bridge.cancelBalanceRequest(requestId);
      logger?.debug?.(
        {
          err: error,
          address,
          target: targetService.service,
        },
        'devnet balance request publish failed',
      );
      return cached?.balance ?? null;
    }

    const result = await waitPromise;
    const balance = extractBalance(result);
    if (balance !== null) return balance;
    return cached?.balance ?? null;
  }

  return {
    async getWalletBalance(input = {}) {
      const network = normalizeNetwork(input.network);
      if (network === 'devnet') {
        return getDevnetBalance(input);
      }
      return getRemoteBalance({
        ...input,
        network,
        scanMode: input.scanMode || 'estimate',
      });
    },
  };
}
