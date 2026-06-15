import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', '..', '..', 'orbital.config.js');

function titleCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  return capabilities
    .map((entry) => String(entry || '').trim())
    .includes(capability);
}

function mapContract(contract) {
  const contractPath = String(contract?.path || '').trim().replace(/\\/g, '/');
  if (!contractPath) return null;

  const baseName = path.posix.basename(contractPath);
  const script = String(contract?.script || '').trim();
  const id = script || baseName || contractPath;

  return {
    id,
    name: titleCase(script || baseName || contractPath),
    path: contractPath,
    script: script || baseName,
    build: contract?.build !== undefined && contract?.build !== null ? Boolean(contract.build) : null,
  };
}

async function loadContractsFromConfig(configPath) {
  const imported = await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`);
  const config = imported.default ?? imported;
  const contracts = Array.isArray(config?.contracts) ? config.contracts : [];

  return contracts
    .map(mapContract)
    .filter(Boolean);
}

function resolveRuntimeStructureConfig(fastify) {
  const services = fastify.serviceBridge.getState().connectedServices || [];
  const service = services.find((item) => (
    String(item.role || '').trim() === 'orbkit'
    && hasCapability(item, 'project-structure-sync')
  ));
  if (!service) return null;

  const metadata = parseMetadata(service.metadata);
  const contracts = Array.isArray(metadata.contracts)
    ? metadata.contracts.map(mapContract).filter(Boolean)
    : [];

  return {
    service: service.service,
    workspaceRoot: metadata.workspaceRoot || null,
    configPath: metadata.configPath || null,
    contractsSourcePath: metadata.contractsSourcePath || null,
    contracts,
  };
}

async function resolvePersistedRuntimeStructureConfig(fastify) {
  if (typeof fastify.db?.listOrbkitServices !== 'function') return null;
  const services = await fastify.db.listOrbkitServices().catch(() => []);
  const service = services
    .filter((item) => (
      String(item.role || '').trim() === 'orbkit'
      && hasCapability(item, 'project-structure-sync')
    ))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
  if (!service) return null;

  const metadata = parseMetadata(service.metadata);
  const contracts = Array.isArray(metadata.contracts)
    ? metadata.contracts.map(mapContract).filter(Boolean)
    : [];

  return {
    service: service.service,
    workspaceRoot: metadata.workspaceRoot || null,
    configPath: metadata.configPath || null,
    contractsSourcePath: metadata.contractsSourcePath || null,
    contracts,
  };
}

export default async function contractRoutes(fastify) {
  fastify.get('/contracts/config', async () => {
    const runtime = resolveRuntimeStructureConfig(fastify);
    if (runtime?.contracts?.length) {
      return {
        ok: true,
        source: 'orbkit-runtime',
        ...runtime,
      };
    }

    const persistedRuntime = await resolvePersistedRuntimeStructureConfig(fastify);
    if (persistedRuntime?.contracts?.length) {
      return {
        ok: true,
        source: 'orbkit-cache',
        ...persistedRuntime,
      };
    }

    const configPath = DEFAULT_CONFIG_PATH;
    const contracts = await loadContractsFromConfig(configPath).catch(() => []);

    return {
      ok: true,
      source: 'server-config',
      configPath,
      contracts,
    };
  });
}
