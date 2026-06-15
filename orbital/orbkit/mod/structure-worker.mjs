import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isMainModule, loadConfig, nowIso, toRootRelative } from './common.mjs';
import { closeGraphqlWebSocketClient, subscribeGraphqlStream } from './graphqlws.mjs';
import { getContractStructure } from './structure.mjs';
import {
  publishServiceEvent,
  registerOrbkitService,
  unregisterOrbkitService,
} from './serverevents.mjs';

const DEFAULT_SERVICE_NAME = process.env.ORBKIT_SERVICE_NAME || `orbkit-${randomUUID().slice(0, 8)}`;

function parseCommandEvent(payload) {
  const event = payload?.data?.serviceEvents || payload?.serviceEvents || null;
  if (!event) return null;
  if (event.channel !== 'project-structure-request') return null;

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    body = {};
  }

  return {
    requestId: String(body.requestId || '').trim(),
    ownerKey: String(body.ownerKey || '').trim(),
    projectKey: String(body.projectKey || body.contractPath || '').trim(),
    contractPath: String(body.contractPath || '').trim(),
    requestType: String(body.requestType || 'sync').trim(),
    liveSyncEnabled: Boolean(body.liveSyncEnabled),
  };
}

async function publishStructureProgress(base, payload = {}) {
  await publishServiceEvent({
    ...base,
    channel: 'project-structure-progress',
    direction: 'outbound',
    body: JSON.stringify({
      streamId: payload.streamId || `struct_${randomUUID().slice(0, 8)}`,
      ownerKey: base.ownerKey || null,
      projectKey: base.projectKey || base.contractPath,
      contractPath: base.contractPath,
      status: payload.status || 'ready',
      liveSyncEnabled: payload.liveSyncEnabled ?? false,
      syncMode: payload.syncMode || 'manual',
      changeType: payload.changeType || 'snapshot',
      sequence: payload.sequence || 0,
      message: payload.message || '',
      error: payload.error || null,
      snapshot: payload.snapshot ?? null,
      createdAt: nowIso(),
    }),
  });
}

function debounce(fn, delayMs) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn().catch(() => {
        // ignore watch publish errors; next change will retry
      });
    }, delayMs);
  };
}

function resolveWatchRoot(snapshot) {
  if (snapshot?.contractDir) return snapshot.contractDir;
  return null;
}

async function loadRuntimeContracts(input = {}) {
  try {
    const cfg = loadConfig(input.configPath || undefined);
    const configDir = path.dirname(cfg._resolved.configPath);
    const contractsSourceFile = String(cfg?.deployment?.contractsSourceFile || '../orbital.config.js').trim();
    const sourcePath = path.resolve(configDir, contractsSourceFile);
    if (!fs.existsSync(sourcePath)) {
      return {
        configPath: cfg._resolved.configPath,
        contractsSourcePath: null,
        workspaceRoot: input.workspaceRoot || cfg._resolved.workspaceRoot,
        contracts: [],
      };
    }

    const imported = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);
    const runtimeConfig = imported.default ?? imported;
    const contracts = Array.isArray(runtimeConfig?.contracts)
      ? runtimeConfig.contracts
          .map((contract) => ({
            path: String(contract?.path || '').trim().replace(/\\/g, '/'),
            script: contract?.script ? String(contract.script).trim() : undefined,
            build: contract?.build !== undefined ? Boolean(contract.build) : null,
          }))
          .filter((contract) => Boolean(contract.path))
      : [];

    return {
      configPath: cfg._resolved.configPath,
      contractsSourcePath: toRootRelative(cfg._resolved.workspaceRoot, sourcePath),
      workspaceRoot: input.workspaceRoot || cfg._resolved.workspaceRoot,
      contracts,
    };
  } catch {
    return {
      configPath: input.configPath || null,
      contractsSourcePath: null,
      workspaceRoot: input.workspaceRoot || null,
      contracts: [],
    };
  }
}

export async function startStructureWorker(input = {}) {
  const serviceName = String(input.serviceName || DEFAULT_SERVICE_NAME).trim();
  if (!serviceName) throw new Error('serviceName is required.');
  const runtimeContracts = await loadRuntimeContracts(input);

  const watchers = new Map();
  const sequences = new Map();
  const inFlight = new Set();

  function nextSequence(contractPath) {
    const next = (sequences.get(contractPath) || 0) + 1;
    sequences.set(contractPath, next);
    return next;
  }

  async function publishSnapshot(contractPath, liveSyncEnabled, reason = 'snapshot') {
    try {
      const snapshot = getContractStructure({
        contractPath,
        configPath: input.configPath,
        workspaceRoot: input.workspaceRoot,
      });
      await publishStructureProgress({
        ...input,
        service: serviceName,
        target: 'orbital-server',
        contractPath,
      }, {
        status: 'ready',
        liveSyncEnabled,
        syncMode: liveSyncEnabled ? 'live' : 'manual',
        changeType: reason,
        sequence: nextSequence(contractPath),
        message: liveSyncEnabled
          ? `Project structure updated for ${contractPath}.`
          : `Project structure synced for ${contractPath}.`,
        snapshot,
      });
      return snapshot;
    } catch (error) {
      await publishStructureProgress({
        ...input,
        service: serviceName,
        target: 'orbital-server',
        contractPath,
      }, {
        status: 'failed',
        liveSyncEnabled,
        syncMode: liveSyncEnabled ? 'live' : 'manual',
        changeType: 'sync-error',
        sequence: nextSequence(contractPath),
        message: `Failed to sync project structure for ${contractPath}.`,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  function stopWatcher(contractPath) {
    const watcher = watchers.get(contractPath);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // ignore watcher close errors
    }
    watchers.delete(contractPath);
  }

  async function enableWatcher(contractPath) {
    let snapshot;
    try {
      snapshot = getContractStructure({
        contractPath,
        configPath: input.configPath,
        workspaceRoot: input.workspaceRoot,
      });
    } catch (error) {
      await publishStructureProgress({
        ...input,
        service: serviceName,
        target: 'orbital-server',
        contractPath,
      }, {
        status: 'failed',
        liveSyncEnabled: true,
        syncMode: 'live',
        changeType: 'watch-error',
        sequence: nextSequence(contractPath),
        message: `Failed to prepare live sync for ${contractPath}.`,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const watchRoot = resolveWatchRoot(snapshot);
    if (!watchRoot) return;
    stopWatcher(contractPath);

    const publishChange = debounce(async () => {
      await publishSnapshot(contractPath, true, 'change');
    }, Number(input.watchDebounceMs || 75));

    const watcher = fs.watch(watchRoot, { recursive: true }, (_, filename) => {
      const name = String(filename || '');
      if (!name) return;
      if (name.includes(`${path.sep}.git${path.sep}`) || name.includes('node_modules') || name.includes('target')) return;
      publishChange();
    });
    watchers.set(contractPath, watcher);
  }

  async function handleCommand(command) {
    if (!command.contractPath) return;
    if (command.requestType === 'configure-live-sync') {
      if (command.liveSyncEnabled) {
        await enableWatcher(command.contractPath);
      } else {
        stopWatcher(command.contractPath);
      }
      await publishStructureProgress({
        ...input,
        service: serviceName,
        target: 'orbital-server',
        contractPath: command.contractPath,
      }, {
        status: 'configured',
        liveSyncEnabled: command.liveSyncEnabled,
        syncMode: command.liveSyncEnabled ? 'live' : 'manual',
        changeType: 'config',
        sequence: nextSequence(command.contractPath),
        message: command.liveSyncEnabled
          ? `Live structure sync enabled for ${command.contractPath}.`
          : `Live structure sync disabled for ${command.contractPath}.`,
      });
      if (command.liveSyncEnabled) {
        await publishSnapshot(command.contractPath, true, 'snapshot');
      }
      return;
    }

    await publishSnapshot(command.contractPath, command.liveSyncEnabled, 'snapshot');
    if (command.liveSyncEnabled) {
      await enableWatcher(command.contractPath);
    }
  }

  await registerOrbkitService({
    ...input,
    service: serviceName,
    role: 'orbkit',
    metadata: {
      capabilities: ['project-structure-sync'],
      workspaceRoot: runtimeContracts.workspaceRoot,
      configPath: runtimeContracts.configPath,
      contractsSourcePath: runtimeContracts.contractsSourcePath,
      contracts: runtimeContracts.contracts,
    },
  });

  const subscription = await subscribeGraphqlStream({
    ...input,
    query: 'subscription OrbkitProjectStructureRequests($target: String) { serviceEvents(target: $target, channel: "project-structure-request") { id channel service target body direction network createdAt } }',
    variables: {
      target: serviceName,
    },
    onNext: (payload) => {
      const command = parseCommandEvent(payload);
      if (!command?.contractPath) return;
      const task = handleCommand(command).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    },
  });

  let stopped = false;

  return {
    serviceName,
    async stop() {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe();
      await Promise.allSettled(Array.from(inFlight));
      for (const contractPath of Array.from(watchers.keys())) {
        stopWatcher(contractPath);
      }
      await unregisterOrbkitService({
        ...input,
        service: serviceName,
      }).catch(() => {
        // ignore cleanup errors
      });
      closeGraphqlWebSocketClient(input);
    },
  };
}

function parseArgs(argv) {
  let serviceName = DEFAULT_SERVICE_NAME;
  let configPath;
  let workspaceRoot;
  let apiKey;
  let url;
  let wsUrl;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service') {
      serviceName = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--config') {
      configPath = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--workspace') {
      workspaceRoot = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--api-key') {
      apiKey = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--url') {
      url = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--ws-url') {
      wsUrl = String(argv[++i] || '').trim();
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    serviceName,
    configPath,
    workspaceRoot,
    apiKey,
    url,
    wsUrl,
  };
}

async function main() {
  const worker = await startStructureWorker(parseArgs(process.argv.slice(2)));
  process.stdout.write(`[structure-worker] listening as ${worker.serviceName}\n`);

  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
