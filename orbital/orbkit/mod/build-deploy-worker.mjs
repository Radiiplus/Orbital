import { randomUUID } from 'node:crypto';
import { isMainModule, nowIso } from './common.mjs';
import { closeGraphqlWebSocketClient, subscribeGraphqlStream } from './graphqlws.mjs';
import {
  publishServiceEvent,
  registerOrbkitService,
  unregisterOrbkitService,
} from './serverevents.mjs';
import { buildOnlyContracts } from './buildeploy.mjs';
import { broadcastSignedDeployTransaction, prepareDeployTransaction } from './deploy-prepare.mjs';
import { writeLastDeploymentReceipt } from './deployment-receipts.mjs';

const DEFAULT_SERVICE_NAME = process.env.ORBKIT_SERVICE_NAME || `orbkit-${randomUUID().slice(0, 8)}`;

function parseCommandEvent(payload) {
  const event = payload?.data?.serviceEvents || payload?.serviceEvents || null;
  if (!event) return null;
  if (event.channel !== 'build-deploy-request') return null;

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    body = {};
  }

  return {
    event,
    requestId: String(body.requestId || '').trim(),
    ownerKey: String(body.ownerKey || '').trim(),
    projectKey: String(body.projectKey || body.contractPath || '').trim(),
    action: String(body.action || 'build').trim(),
    contractPath: String(body.contractPath || '').trim(),
    network: String(body.network || 'devnet').trim(),
    retryCount: Math.max(1, Math.floor(Number(body.retryCount || 2))),
    build: body.build === undefined ? undefined : Boolean(body.build),
    deployKind: String(body.deployKind || 'typeid').trim(),
    sponsorMode: String(body.sponsorMode || 'none').trim(),
    tx: body.tx && typeof body.tx === 'object' ? body.tx : null,
    prepareResult: body.prepareResult && typeof body.prepareResult === 'object' ? body.prepareResult : null,
    deployWallet: body.deployWallet && typeof body.deployWallet === 'object'
      ? {
          username: String(body.deployWallet.username || '').trim() || null,
          network: String(body.deployWallet.network || body.network || 'devnet').trim(),
          address: String(body.deployWallet.address || '').trim() || null,
        }
      : null,
  };
}

async function publishBuildDeployProgress(base, payload = {}) {
  await publishServiceEvent({
    ...base,
    channel: 'build-deploy-progress',
    direction: 'outbound',
    network: base.network,
    body: JSON.stringify({
      requestId: base.requestId,
      ownerKey: base.ownerKey || null,
      projectKey: base.projectKey || base.contractPath,
      action: base.action,
      network: base.network,
      contractPath: base.contractPath,
      scriptName: payload.scriptName || null,
      phase: payload.phase,
      status: payload.status,
      message: payload.message,
      error: payload.error || null,
      result: payload.result || null,
      createdAt: nowIso(),
    }),
  });
}

async function executeBuild(command, workerOptions, base) {
  await publishBuildDeployProgress(base, {
    phase: 'building',
    status: 'running',
    message: `Building ${command.contractPath} on ${command.network}.`,
  });

  const result = await buildOnlyContracts({
    configPath: workerOptions.configPath,
    network: command.network,
    contractPath: command.contractPath,
  });

  const primary = result.results?.find((item) => item.contractPath === command.contractPath) || result.results?.[0] || null;
  await publishBuildDeployProgress(base, {
    phase: 'completed',
    status: 'completed',
    scriptName: primary?.scriptName || null,
    message: `Build completed for ${command.contractPath}.`,
    result,
  });
}

async function executeDeploy(command, workerOptions, base) {
  await publishBuildDeployProgress(base, {
    phase: 'preparing',
    status: 'running',
    message: command.deployWallet?.username
      ? `Preparing deploy for ${command.contractPath} on ${command.network} using ${command.deployWallet.username}.`
      : `Preparing deploy for ${command.contractPath} on ${command.network}.`,
  });

  try {
    const prepareInput = {
      configPath: workerOptions.configPath,
      network: command.network,
      build: command.build,
      contractPath: command.contractPath,
      address: command.deployWallet?.address,
      deployKind: command.deployKind || 'typeid',
      sponsorMode: command.sponsorMode || 'none',
    };
    const result = await prepareDeployTransaction(prepareInput);
    await publishBuildDeployProgress(base, {
      phase: 'completed',
      status: 'completed',
      scriptName: pathBasename(result.binaryPath || command.contractPath),
      message: `Unsigned deploy transaction prepared for ${command.contractPath}.`,
      result,
    });
  } catch (error) {
    throw error;
  }
}

async function executeDeployBroadcast(command, workerOptions, base) {
  await publishBuildDeployProgress(base, {
    phase: 'broadcasting',
    status: 'running',
    message: `Broadcasting signed deploy transaction for ${command.contractPath} on ${command.network}.`,
  });

  const result = await broadcastSignedDeployTransaction({
    configPath: workerOptions.configPath,
    network: command.network,
    tx: command.tx,
  });
  const prepareResult = command.prepareResult || null;
  const receipt = writeLastDeploymentReceipt({
    configPath: workerOptions.configPath,
    contractName: pathBasename(prepareResult?.binaryPath || command.contractPath),
    contractPath: command.contractPath,
    scriptName: pathBasename(prepareResult?.binaryPath || command.contractPath),
    network: command.network,
    txHash: result.txHash,
    binaryBytes: prepareResult?.binaryBytes ?? null,
    binaryPath: prepareResult?.binaryPath || null,
    deployKind: prepareResult?.deployKind || command.deployKind || null,
    sponsored: Boolean(prepareResult?.sponsored),
    sponsorMode: prepareResult?.sponsorMode || null,
    sponsorAddress: prepareResult?.sponsorAddress || null,
    scriptConfig: prepareResult?.scriptConfig || null,
    typeId: prepareResult?.typeId || null,
    typeScript: prepareResult?.typeScript || null,
    deployMode: prepareResult?.deployMode || (prepareResult?.redeploy ? 'upgrade' : 'create'),
    redeploy: Boolean(prepareResult?.redeploy),
    deployAddress: prepareResult?.address || command.deployWallet?.address || null,
    service: workerOptions.serviceName,
    broadcast: result,
    deployedAt: nowIso(),
  });

  await publishBuildDeployProgress(base, {
    phase: 'completed',
    status: 'completed',
    message: `Deploy broadcast completed for ${command.contractPath}.`,
    result: {
      ...result,
      action: 'deploy-broadcast',
      contractPath: command.contractPath,
      submittedBy: workerOptions.serviceName,
      deployment: receipt,
    },
  });
}

function pathBasename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || null;
}

export async function handleBuildDeployRequest(command, workerOptions = {}) {
  const base = {
    ...workerOptions,
    service: workerOptions.serviceName,
    target: 'orbital-server',
    requestId: command.requestId,
    ownerKey: command.ownerKey,
    projectKey: command.projectKey || command.contractPath,
    action: command.action,
    contractPath: command.contractPath,
    network: command.network,
  };

  await publishBuildDeployProgress(base, {
    phase: 'accepted',
    status: 'running',
    message: `Accepted ${command.action} request for ${command.contractPath}.`,
  });

  try {
    if (command.action === 'build') {
      await executeBuild(command, workerOptions, base);
      return;
    }
    if (command.action === 'deploy') {
      await executeDeploy(command, workerOptions, base);
      return;
    }
    if (command.action === 'deploy-broadcast') {
      await executeDeployBroadcast(command, workerOptions, base);
      return;
    }
    throw new Error(`Unsupported action: ${command.action}`);
  } catch (error) {
    await publishBuildDeployProgress(base, {
      phase: 'failed',
      status: 'failed',
      message: `${command.action} failed for ${command.contractPath}.`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startBuildDeployWorker(input = {}) {
  const serviceName = String(input.serviceName || DEFAULT_SERVICE_NAME).trim();
  if (!serviceName) throw new Error('serviceName is required.');

  const inFlight = new Set();

  await registerOrbkitService({
    ...input,
    service: serviceName,
    role: 'orbkit',
    metadata: {
      capabilities: ['build-contract', 'deploy-contract'],
    },
  });

  const subscription = await subscribeGraphqlStream({
    ...input,
    query: 'subscription OrbkitBuildDeployRequests($target: String) { serviceEvents(target: $target, channel: "build-deploy-request") { id channel service target body direction network createdAt } }',
    variables: {
      target: serviceName,
    },
    onNext: (payload) => {
      const command = parseCommandEvent(payload);
      if (!command?.requestId || !command.contractPath || !command.network) return;
      const task = handleBuildDeployRequest(command, {
        ...input,
        serviceName,
      }).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    },
  });

  let stopped = false;

  return {
    serviceName,
    subscription,
    async stop() {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe();
      await Promise.allSettled(Array.from(inFlight));
      await unregisterOrbkitService({
        ...input,
        service: serviceName,
      }).catch(() => {
        // ignore cleanup errors during shutdown
      });
      closeGraphqlWebSocketClient(input);
    },
  };
}

function parseArgs(argv) {
  let serviceName = DEFAULT_SERVICE_NAME;
  let configPath;
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
    apiKey,
    url,
    wsUrl,
  };
}

async function main() {
  const worker = await startBuildDeployWorker(parseArgs(process.argv.slice(2)));
  process.stdout.write(`[build-deploy-worker] listening as ${worker.serviceName}\n`);

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
