import { simulateDeployCost } from '../../orbkit/mod/sim.mjs';

function normalizeContractPath(value) {
  const contractPath = String(value || '').trim().replace(/\\/g, '/');
  if (!contractPath) {
    throw new Error('contractPath is required.');
  }
  return contractPath;
}

function normalizeNetwork(value) {
  const network = String(value || 'devnet').trim().toLowerCase();
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) {
    throw new Error('network must be one of: devnet, testnet, mainnet.');
  }
  return network;
}

function normalizeBuildFlag(value) {
  if (value === undefined) return false;
  return Boolean(value);
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

function hasCapability(service, capability) {
  const metadata = parseMetadata(service?.metadata);
  const capabilities = Array.isArray(metadata.capabilities) ? metadata.capabilities : [];
  return capabilities.map((entry) => String(entry || '').trim()).includes(capability);
}

function resolveRuntimeConfigPath(bridge, contractPath) {
  const services = bridge?.getState?.().connectedServices || [];
  const candidates = services.filter((service) => (
    String(service.role || '').trim() === 'orbkit'
    && hasCapability(service, 'deploy-contract')
  ));
  for (const service of candidates) {
    const metadata = parseMetadata(service.metadata);
    const contracts = Array.isArray(metadata.contracts) ? metadata.contracts : [];
    const ownsContract = contracts.length === 0 || contracts.some((contract) => (
      String(contract?.path || '').trim().replace(/\\/g, '/') === contractPath
    ));
    if (ownsContract && metadata.configPath) {
      return metadata.configPath;
    }
  }
  return null;
}

function applySessionRefresh(reply, session) {
  if (!reply?.raw || !session?.refreshed || !session?.token) return;
  reply.raw.setHeader('x-access-token', session.token);
  reply.raw.setHeader('x-session-refreshed', '1');
}

export function createDeploySimService({ walletAccessService, bridge }) {
  return {
    async simulate({ body = {}, reply } = {}) {
      const contractPath = normalizeContractPath(body.contractPath);
      const network = normalizeNetwork(body.network);
      const build = normalizeBuildFlag(body.build);
      const configPath = body.configPath || resolveRuntimeConfigPath(bridge, contractPath);
      const deployWallet = walletAccessService.resolveDeployWallet({
        accessToken: body.accessToken,
        headers: body.headers,
        network,
        walletAddress: body.walletAddress,
      });
      applySessionRefresh(reply, deployWallet.session);

      const simulation = await simulateDeployCost({
        configPath,
        contractPath,
        network,
        build,
        deployKind: body.deployKind || 'typeid',
        walletAddress: deployWallet.address,
      });
      const binarySizeBytes = simulation.binarySizeBytes ?? simulation.binaryBytes ?? null;

      return {
        ...simulation,
        binaryBytes: simulation.binaryBytes ?? binarySizeBytes,
        binarySizeBytes,
        deployWallet: {
          username: deployWallet.username,
          address: deployWallet.address,
          network: deployWallet.network,
        },
      };
    },
  };
}
