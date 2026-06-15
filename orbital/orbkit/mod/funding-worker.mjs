import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMainModule, nowIso } from './common.mjs';
import { subscribeGraphqlStream, closeGraphqlWebSocketClient } from './graphqlws.mjs';
import {
  publishOrbkitBalanceUpdate,
  publishServiceEvent,
  registerOrbkitService,
  unregisterOrbkitService,
} from './serverevents.mjs';
import { fundDevnetWallet } from './fund.mjs';
import { getWalletBalance } from './balance.mjs';

const DEFAULT_SERVICE_NAME = process.env.ORBKIT_SERVICE_NAME || `orbkit-${randomUUID().slice(0, 8)}`;

function parseCommandEvent(payload) {
  const event = payload?.data?.serviceEvents || payload?.serviceEvents || null;
  if (!event) return null;
  if (event.channel !== 'devnet-fund-wallet-request') return null;

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
    address: String(body.address || '').trim(),
    amountInCKB: String(body.amountInCKB || '').trim(),
    retryCount: Math.max(1, Math.floor(Number(body.retryCount || 3))),
  };
}

async function publishFundingProgress(base, payload = {}) {
  await publishServiceEvent({
    ...base,
    channel: 'devnet-fund-wallet-progress',
    direction: 'outbound',
    network: 'devnet',
    body: JSON.stringify({
      requestId: base.requestId,
      ownerKey: base.ownerKey || null,
      address: base.address,
      amountInCKB: base.amountInCKB,
      phase: payload.phase,
      status: payload.status,
      message: payload.message,
      txHash: payload.txHash || null,
      error: payload.error || null,
      result: payload.result || null,
      createdAt: nowIso(),
    }),
  });
}

export async function handleFundingRequest(command, workerOptions = {}) {
  const base = {
    ...workerOptions,
    service: workerOptions.serviceName,
    target: 'orbital-server',
    requestId: command.requestId,
    ownerKey: command.ownerKey,
    address: command.address,
    amountInCKB: command.amountInCKB,
  };

  await publishFundingProgress(base, {
    phase: 'accepted',
    status: 'running',
    message: `Accepted funding request for ${command.address}.`,
  });

  try {
    await publishFundingProgress(base, {
      phase: 'funding-ready',
      status: 'running',
      message: 'Backend confirmed devnet is reachable.',
    });

    await sleep(Number(workerOptions.progressDelayMs || 0));

    await publishFundingProgress(base, {
      phase: 'transferring',
      status: 'running',
      message: `Submitting transfer of ${command.amountInCKB} CKB.`,
    });

    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= command.retryCount; attempt += 1) {
      await publishFundingProgress(base, {
        phase: 'transfer-attempt',
        status: 'running',
        message: `Funding attempt ${attempt}/${command.retryCount}.`,
      });

      try {
        // eslint-disable-next-line no-await-in-loop
        result = await fundDevnetWallet({
          walletAddress: command.address,
          amountInCKB: command.amountInCKB,
          configPath: workerOptions.configPath,
          privkey: workerOptions.privkey,
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < command.retryCount) {
          await publishFundingProgress(base, {
            phase: 'retrying',
            status: 'running',
            message: `Funding attempt ${attempt}/${command.retryCount} failed, retrying.`,
            error: error instanceof Error ? error.message : String(error),
          });
          // eslint-disable-next-line no-await-in-loop
          await sleep(Number(workerOptions.retryDelayMs || 250));
          continue;
        }
      }
    }

    if (!result) {
      throw lastError || new Error('Funding failed after retries.');
    }

    await publishFundingProgress(base, {
      phase: 'balance-sync',
      status: 'running',
      message: 'Publishing updated devnet balance.',
      txHash: result.txHash,
    });

    let balance = String(workerOptions.fallbackBalance || '0');
    try {
      const balanceResult = await getWalletBalance({
        walletAddress: command.address,
        network: 'devnet',
        configPath: workerOptions.configPath,
      });
      balance = String(balanceResult.spendableShannons ?? balanceResult.totalShannons ?? balance);
    } catch {
      // keep fallback balance when balance probe fails
    }
    await publishOrbkitBalanceUpdate({
      ...workerOptions,
      address: command.address,
      balance,
    });

    await publishFundingProgress(base, {
      phase: 'completed',
      status: 'completed',
      message: 'Devnet funding completed.',
      txHash: result.txHash,
      result,
    });
  } catch (error) {
    await publishFundingProgress(base, {
      phase: 'failed',
      status: 'failed',
      message: 'Devnet funding failed.',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startFundingWorker(input = {}) {
  const serviceName = String(input.serviceName || DEFAULT_SERVICE_NAME).trim();
  if (!serviceName) throw new Error('serviceName is required.');

  const inFlight = new Set();

  await registerOrbkitService({
    ...input,
    service: serviceName,
    role: 'orbkit',
    metadata: {
      capabilities: ['devnet-fund-wallet'],
    },
  });

  const subscription = await subscribeGraphqlStream({
    ...input,
    query: 'subscription OrbkitFundingRequests($target: String) { serviceEvents(target: $target, channel: "devnet-fund-wallet-request") { id channel service target body direction network createdAt } }',
    variables: {
      target: serviceName,
    },
    onNext: (payload) => {
      const command = parseCommandEvent(payload);
      if (!command?.requestId || !command.address || !command.amountInCKB) return;
      const task = handleFundingRequest(command, {
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
  let privkey = '';

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
    if (arg === '--privkey') {
      privkey = String(argv[++i] || '').trim();
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
    privkey,
  };
}

async function main() {
  const worker = await startFundingWorker(parseArgs(process.argv.slice(2)));
  process.stdout.write(`[funding-worker] listening as ${worker.serviceName}\n`);

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
