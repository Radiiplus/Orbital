import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isMainModule, loadConfig, nowIso, toRootRelative } from './common.mjs';
import {
  ackFirebaseCommand,
  fetchFirebaseCommands,
  publishFirebaseEvent,
  registerFirebaseService,
  unregisterFirebaseService,
} from './firebase-transport.mjs';
import { fundDevnetWallet } from './fund.mjs';
import { getWalletBalance } from './balance.mjs';
import { buildOnlyContracts } from './buildeploy.mjs';
import { broadcastSignedDeployTransaction, prepareDeployTransaction } from './deploy-prepare.mjs';
import { writeLastDeploymentReceipt } from './deployment-receipts.mjs';
import { getContractStructure } from './structure.mjs';

const DEFAULT_SERVICE_NAME = process.env.ORBKIT_SERVICE_NAME || `orbkit-${randomUUID().slice(0, 8)}`;

function parseCommandBody(command) {
  const body = command?.body || {};
  return typeof body === 'object' && body ? body : {};
}

function pathBasename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || null;
}

async function publishProgress(base, channel, body, network = null) {
  await publishFirebaseEvent({
    ...base,
    channel,
    service: base.serviceName,
    target: 'orbital-supabase-function',
    network,
    body: {
      ...body,
      createdAt: body.createdAt || nowIso(),
    },
  });
}

async function handleFundingCommand(command, input) {
  const body = parseCommandBody(command);
  const requestId = String(body.requestId || '').trim();
  const ownerKey = String(body.ownerKey || '').trim();
  const address = String(body.address || '').trim();
  const amountInCKB = String(body.amountInCKB || '').trim();
  const retryCount = Math.max(1, Math.floor(Number(body.retryCount || 3)));
  const basePayload = { requestId, ownerKey, address, amountInCKB };

  await publishProgress(input, 'devnet-fund-wallet-progress', {
    ...basePayload,
    phase: 'accepted',
    status: 'running',
    message: `Accepted funding request for ${address}.`,
  }, 'devnet');

  try {
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      await publishProgress(input, 'devnet-fund-wallet-progress', {
        ...basePayload,
        phase: 'transfer-attempt',
        status: 'running',
        message: `Funding attempt ${attempt}/${retryCount}.`,
      }, 'devnet');
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await fundDevnetWallet({
          walletAddress: address,
          amountInCKB,
          configPath: input.configPath,
          privkey: input.privkey,
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < retryCount) {
          await publishProgress(input, 'devnet-fund-wallet-progress', {
            ...basePayload,
            phase: 'retrying',
            status: 'running',
            message: `Funding attempt ${attempt}/${retryCount} failed, retrying.`,
            error: error instanceof Error ? error.message : String(error),
          }, 'devnet');
        }
      }
    }
    if (!result) throw lastError || new Error('Funding failed after retries.');

    let balance = '0';
    try {
      const balanceResult = await getWalletBalance({
        walletAddress: address,
        network: 'devnet',
        configPath: input.configPath,
      });
      balance = String(balanceResult.spendableShannons ?? balanceResult.totalShannons ?? '0');
      await publishProgress(input, 'wallet-balance-response', {
        requestId: `balance_${requestId}`,
        address,
        network: 'devnet',
        ok: true,
        balance,
        totalShannons: balanceResult.totalShannons ?? balance,
        result: balanceResult,
      }, 'devnet');
    } catch {
      // Funding success is still valid if the follow-up balance probe misses.
    }

    await publishProgress(input, 'devnet-fund-wallet-progress', {
      ...basePayload,
      phase: 'completed',
      status: 'completed',
      message: 'Devnet funding completed.',
      txHash: result.txHash,
      result,
    }, 'devnet');
  } catch (error) {
    await publishProgress(input, 'devnet-fund-wallet-progress', {
      ...basePayload,
      phase: 'failed',
      status: 'failed',
      message: 'Devnet funding failed.',
      error: error instanceof Error ? error.message : String(error),
    }, 'devnet');
  }
}

async function handleBuildDeployCommand(command, input) {
  const body = parseCommandBody(command);
  const requestId = String(body.requestId || '').trim();
  const action = String(body.action || 'build').trim();
  const contractPath = String(body.contractPath || '').trim();
  const network = String(body.network || command.network || 'devnet').trim();
  const ownerKey = String(body.ownerKey || command.ownerKey || '').trim();
  const projectKey = String(body.projectKey || body.contractPath || command.projectKey || '').trim();
  const basePayload = { requestId, ownerKey, projectKey, action, network, contractPath };

  await publishProgress(input, 'build-deploy-progress', {
    ...basePayload,
    phase: 'accepted',
    status: 'running',
    message: `Accepted ${action} request for ${contractPath}.`,
  }, network);

  try {
    if (action === 'build') {
      await publishProgress(input, 'build-deploy-progress', {
        ...basePayload,
        phase: 'building',
        status: 'running',
        message: `Building ${contractPath} on ${network}.`,
      }, network);
      const result = await buildOnlyContracts({
        configPath: input.configPath,
        network,
        contractPath,
      });
      const primary = result.results?.find((item) => item.contractPath === contractPath) || result.results?.[0] || null;
      await publishProgress(input, 'build-deploy-progress', {
        ...basePayload,
        phase: 'completed',
        status: 'completed',
        scriptName: primary?.scriptName || null,
        message: `Build completed for ${contractPath}.`,
        result,
      }, network);
      return;
    }

    if (action === 'deploy') {
      await publishProgress(input, 'build-deploy-progress', {
        ...basePayload,
        phase: 'preparing',
        status: 'running',
        message: `Preparing deploy for ${contractPath} on ${network}.`,
      }, network);
      const result = await prepareDeployTransaction({
        configPath: input.configPath,
        network,
        build: body.build,
        contractPath,
        address: body.deployWallet?.address,
        deployKind: body.deployKind || 'typeid',
        sponsorMode: body.sponsorMode || 'none',
      });
      await publishProgress(input, 'build-deploy-progress', {
        ...basePayload,
        phase: 'completed',
        status: 'completed',
        scriptName: pathBasename(result.binaryPath || contractPath),
        message: `Unsigned deploy transaction prepared for ${contractPath}.`,
        result,
      }, network);
      return;
    }

    if (action === 'deploy-broadcast') {
      await publishProgress(input, 'build-deploy-progress', {
        ...basePayload,
        phase: 'broadcasting',
        status: 'running',
        message: `Broadcasting signed deploy transaction for ${contractPath} on ${network}.`,
      }, network);
      const result = await broadcastSignedDeployTransaction({
        configPath: input.configPath,
        network,
        tx: body.tx,
      });
      const prepareResult = body.prepareResult || null;
      const receipt = writeLastDeploymentReceipt({
        configPath: input.configPath,
        contractName: pathBasename(prepareResult?.binaryPath || contractPath),
        contractPath,
        scriptName: pathBasename(prepareResult?.binaryPath || contractPath),
        network,
        txHash: result.txHash,
        binaryBytes: prepareResult?.binaryBytes ?? null,
        binaryPath: prepareResult?.binaryPath || null,
        deployKind: prepareResult?.deployKind || body.deployKind || null,
        sponsored: Boolean(prepareResult?.sponsored),
        sponsorMode: prepareResult?.sponsorMode || null,
        sponsorAddress: prepareResult?.sponsorAddress || null,
        scriptConfig: prepareResult?.scriptConfig || null,
        typeId: prepareResult?.typeId || null,
        typeScript: prepareResult?.typeScript || null,
        deployMode: prepareResult?.deployMode || (prepareResult?.redeploy ? 'upgrade' : 'create'),
        redeploy: Boolean(prepareResult?.redeploy),
        deployAddress: prepareResult?.address || body.deployWallet?.address || null,
        walletAddress: prepareResult?.address || body.deployWallet?.address || null,
        walletLabel: body.deployWallet?.username || null,
        service: input.serviceName,
        broadcast: result,
        deployedAt: nowIso(),
      });
      await publishProgress(input, 'build-deploy-progress', {
        ...basePayload,
        phase: 'completed',
        status: 'completed',
        message: `Deploy broadcast completed for ${contractPath}.`,
        result: {
          ...result,
          action: 'deploy-broadcast',
          contractPath,
          submittedBy: input.serviceName,
          deployment: receipt,
        },
      }, network);
      return;
    }

    throw new Error(`Unsupported action: ${action}`);
  } catch (error) {
    await publishProgress(input, 'build-deploy-progress', {
      ...basePayload,
      phase: 'failed',
      status: 'failed',
      message: `${action} failed for ${contractPath}.`,
      error: error instanceof Error ? error.message : String(error),
    }, network);
  }
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

function debounce(fn, delayMs) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn().catch(() => {});
    }, delayMs);
  };
}

function createStructureHandler(input) {
  const watchers = new Map();
  const sequences = new Map();

  function nextSequence(contractPath) {
    const next = (sequences.get(contractPath) || 0) + 1;
    sequences.set(contractPath, next);
    return next;
  }

  async function publishStructure(contractPath, payload = {}) {
    await publishProgress(input, 'project-structure-progress', {
      streamId: payload.streamId || `struct_${randomUUID().slice(0, 8)}`,
      ownerKey: payload.ownerKey || null,
      projectKey: payload.projectKey || contractPath,
      contractPath,
      status: payload.status || 'ready',
      liveSyncEnabled: Boolean(payload.liveSyncEnabled),
      syncMode: payload.syncMode || 'manual',
      changeType: payload.changeType || 'snapshot',
      sequence: payload.sequence || nextSequence(contractPath),
      message: payload.message || '',
      error: payload.error || null,
      snapshot: payload.snapshot ?? null,
    });
  }

  function stopWatcher(contractPath) {
    const watcher = watchers.get(contractPath);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {}
    watchers.delete(contractPath);
  }

  async function publishSnapshot(command, reason = 'snapshot') {
    try {
      const snapshot = getContractStructure({
        contractPath: command.contractPath,
        configPath: input.configPath,
        workspaceRoot: input.workspaceRoot,
      });
      await publishStructure(command.contractPath, {
        ownerKey: command.ownerKey,
        projectKey: command.projectKey,
        status: 'ready',
        liveSyncEnabled: command.liveSyncEnabled,
        syncMode: command.liveSyncEnabled ? 'live' : 'manual',
        changeType: reason,
        message: command.liveSyncEnabled
          ? `Project structure updated for ${command.contractPath}.`
          : `Project structure synced for ${command.contractPath}.`,
        snapshot,
      });
      return snapshot;
    } catch (error) {
      await publishStructure(command.contractPath, {
        ownerKey: command.ownerKey,
        projectKey: command.projectKey,
        status: 'failed',
        liveSyncEnabled: command.liveSyncEnabled,
        syncMode: command.liveSyncEnabled ? 'live' : 'manual',
        changeType: 'sync-error',
        message: `Failed to sync project structure for ${command.contractPath}.`,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function enableWatcher(command) {
    const snapshot = await publishSnapshot(command, 'snapshot');
    const watchRoot = snapshot?.contractDir || null;
    if (!watchRoot) return;
    stopWatcher(command.contractPath);
    const publishChange = debounce(async () => {
      await publishSnapshot(command, 'change');
    }, Number(input.watchDebounceMs || 75));
    const watcher = fs.watch(watchRoot, { recursive: true }, (_, filename) => {
      const name = String(filename || '');
      if (!name || name.includes(`${path.sep}.git${path.sep}`) || name.includes('node_modules') || name.includes('target')) return;
      publishChange();
    });
    watchers.set(command.contractPath, watcher);
  }

  return {
    async handle(command) {
      const body = parseCommandBody(command);
      const parsed = {
        requestId: String(body.requestId || '').trim(),
        ownerKey: String(body.ownerKey || '').trim(),
        projectKey: String(body.projectKey || body.contractPath || '').trim(),
        contractPath: String(body.contractPath || '').trim(),
        requestType: String(body.requestType || 'sync').trim(),
        liveSyncEnabled: Boolean(body.liveSyncEnabled),
      };
      if (!parsed.contractPath) return;
      if (parsed.requestType === 'configure-live-sync') {
        if (parsed.liveSyncEnabled) await enableWatcher(parsed);
        else stopWatcher(parsed.contractPath);
        await publishStructure(parsed.contractPath, {
          ownerKey: parsed.ownerKey,
          projectKey: parsed.projectKey,
          status: 'configured',
          liveSyncEnabled: parsed.liveSyncEnabled,
          syncMode: parsed.liveSyncEnabled ? 'live' : 'manual',
          changeType: 'config',
          message: parsed.liveSyncEnabled
            ? `Live structure sync enabled for ${parsed.contractPath}.`
            : `Live structure sync disabled for ${parsed.contractPath}.`,
        });
        return;
      }
      await publishSnapshot(parsed, 'snapshot');
      if (parsed.liveSyncEnabled) await enableWatcher(parsed);
    },
    stop() {
      for (const key of Array.from(watchers.keys())) stopWatcher(key);
    },
  };
}

async function handleCommand(command, input, structureHandler) {
  const channel = String(command.channel || '').trim();
  await ackFirebaseCommand({ ...input, commandId: command.commandId, status: 'running' });
  if (channel === 'devnet-fund-wallet-request') {
    await handleFundingCommand(command, input);
  } else if (channel === 'build-deploy-request') {
    await handleBuildDeployCommand(command, input);
  } else if (channel === 'project-structure-request') {
    await structureHandler.handle(command);
  } else if (channel === 'wallet-balance-request') {
    const body = parseCommandBody(command);
    const result = await getWalletBalance({
      walletAddress: body.address || body.walletAddress,
      network: body.network || command.network || 'devnet',
      configPath: input.configPath,
      scanMode: body.scanMode,
      pageLimit: body.pageLimit,
      maxPages: body.maxPages,
    });
    await publishProgress(input, 'wallet-balance-response', {
      requestId: body.requestId,
      address: body.address || body.walletAddress,
      network: body.network || command.network || 'devnet',
      ok: true,
      balance: String(result.spendableShannons ?? result.totalShannons ?? '0'),
      totalShannons: result.totalShannons,
      result,
    }, body.network || command.network || 'devnet');
  } else if (channel === 'orbkit-control') {
    const body = parseCommandBody(command);
    if (String(body.command || '').trim() === 'reconnect') {
      await publishProgress(input, 'orbkit-control-progress', {
        service: input.serviceName,
        status: 'connected',
        reason: body.reason || 'manual-ui',
      });
    }
  }
  await ackFirebaseCommand({ ...input, commandId: command.commandId, status: 'completed' });
}

export async function startFirebaseWorker(input = {}) {
  const serviceName = String(input.serviceName || DEFAULT_SERVICE_NAME).trim();
  if (!serviceName) throw new Error('serviceName is required.');
  const runtimeContracts = await loadRuntimeContracts(input);
  const base = { ...input, serviceName };
  let stopped = false;
  const inFlight = new Set();
  const structureHandler = createStructureHandler(base);

  await registerFirebaseService({
    ...base,
    service: serviceName,
    role: 'orbkit',
    metadata: {
      capabilities: [
        'build-contract',
        'deploy-contract',
        'devnet-fund-wallet',
        'project-structure-sync',
        'wallet-balance',
      ],
      workspaceRoot: runtimeContracts.workspaceRoot,
      configPath: runtimeContracts.configPath,
      contractsSourcePath: runtimeContracts.contractsSourcePath,
      contracts: runtimeContracts.contracts,
    },
  });

  async function tick() {
    const commands = await fetchFirebaseCommands({ ...base, serviceName, limit: 10 });
    for (const command of commands) {
      if (stopped) break;
      const task = handleCommand(command, base, structureHandler)
        .catch(async (error) => {
          await ackFirebaseCommand({ ...base, commandId: command.commandId, status: 'failed' }).catch(() => {});
          await publishProgress(base, 'build-deploy-progress', {
            requestId: parseCommandBody(command).requestId || command.commandId,
            phase: 'failed',
            status: 'failed',
            message: 'Orbkit command failed.',
            error: error instanceof Error ? error.message : String(error),
          }, command.network || null).catch(() => {});
        })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
  }

  const loop = (async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        process.stderr.write(`[firebase-worker] poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, Number(input.pollIntervalMs || 1500)));
    }
  })();

  process.stdout.write(`[firebase-worker] listening as ${serviceName}\n`);

  return {
    serviceName,
    async stop() {
      if (stopped) return;
      stopped = true;
      await loop.catch(() => {});
      await Promise.allSettled(Array.from(inFlight));
      structureHandler.stop();
      await unregisterFirebaseService({ ...base, service: serviceName }).catch(() => {});
    },
  };
}

function parseArgs(argv) {
  const output = {
    serviceName: DEFAULT_SERVICE_NAME,
    configPath: undefined,
    workspaceRoot: undefined,
    apiKey: undefined,
    supabaseUrl: undefined,
    privkey: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service') output.serviceName = String(argv[++i] || '').trim();
    else if (arg === '--config') output.configPath = String(argv[++i] || '').trim();
    else if (arg === '--workspace') output.workspaceRoot = String(argv[++i] || '').trim();
    else if (arg === '--api-key') output.apiKey = String(argv[++i] || '').trim();
    else if (arg === '--supabase-url' || arg === '--function-url') output.supabaseUrl = String(argv[++i] || '').trim();
    else if (arg === '--privkey') output.privkey = String(argv[++i] || '').trim();
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  return output;
}

async function main() {
  const worker = await startFirebaseWorker(parseArgs(process.argv.slice(2)));
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
