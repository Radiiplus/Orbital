import { randomUUID } from 'node:crypto';
import { isMainModule, nowIso } from './common.mjs';
import { closeGraphqlWebSocketClient, subscribeGraphqlStream } from './graphqlws.mjs';
import {
  publishOrbkitBalanceUpdate,
  publishServiceEvent,
  registerOrbkitService,
  unregisterOrbkitService,
} from './serverevents.mjs';
import { getWalletBalance } from './balance.mjs';

const DEFAULT_SERVICE_NAME = process.env.ORBKIT_SERVICE_NAME || `orbkit-${randomUUID().slice(0, 8)}`;

function parseCommandEvent(payload) {
  const event = payload?.data?.serviceEvents || payload?.serviceEvents || null;
  if (!event) return null;
  if (event.channel !== 'wallet-balance-request') return null;

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    body = {};
  }

  return {
    event,
    requestId: String(body.requestId || '').trim(),
    address: String(body.address || body.walletAddress || '').trim(),
    network: String(body.network || event.network || 'devnet').trim().toLowerCase(),
    scanMode: String(body.scanMode || '').trim() || undefined,
    pageLimit: body.pageLimit === undefined ? undefined : Number(body.pageLimit),
    maxPages: body.maxPages === undefined ? undefined : Number(body.maxPages),
  };
}

async function publishBalanceResponse(base, payload = {}) {
  await publishServiceEvent({
    ...base,
    channel: 'wallet-balance-response',
    direction: 'outbound',
    network: base.network,
    body: JSON.stringify({
      requestId: base.requestId,
      address: base.address,
      network: base.network,
      ok: payload.ok,
      balance: payload.balance ?? null,
      totalShannons: payload.totalShannons ?? payload.balance ?? null,
      error: payload.error || null,
      result: payload.result || null,
      createdAt: nowIso(),
    }),
  });
}

async function handleBalanceRequest(command, workerOptions = {}) {
  const base = {
    ...workerOptions,
    service: workerOptions.serviceName,
    target: 'orbital-server',
    requestId: command.requestId,
    address: command.address,
    network: command.network,
  };

  try {
    const result = await getWalletBalance({
      walletAddress: command.address,
      network: command.network,
      configPath: workerOptions.configPath,
      scanMode: command.scanMode,
      pageLimit: command.pageLimit,
      maxPages: command.maxPages,
    });
    const balance = String(result.spendableShannons ?? result.totalShannons ?? '0');

    await publishBalanceResponse(base, {
      ok: true,
      balance,
      totalShannons: result.totalShannons ?? balance,
      result,
    });

    if (command.network === 'devnet') {
      await publishOrbkitBalanceUpdate({
        ...workerOptions,
        address: command.address,
        balance,
      }).catch(() => {
        // The wallet-balance-response already carries the fresh value.
      });
    }
  } catch (error) {
    await publishBalanceResponse(base, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startBalanceWorker(input = {}) {
  const serviceName = String(input.serviceName || DEFAULT_SERVICE_NAME).trim();
  if (!serviceName) throw new Error('serviceName is required.');

  const inFlight = new Set();

  await registerOrbkitService({
    ...input,
    service: serviceName,
    role: 'orbkit',
    metadata: {
      capabilities: ['wallet-balance'],
    },
  });

  const subscription = await subscribeGraphqlStream({
    ...input,
    query: 'subscription OrbkitBalanceRequests($target: String) { serviceEvents(target: $target, channel: "wallet-balance-request") { id channel service target body direction network createdAt } }',
    variables: {
      target: serviceName,
    },
    onNext: (payload) => {
      const command = parseCommandEvent(payload);
      if (!command?.requestId || !command.address || !command.network) return;
      const task = handleBalanceRequest(command, {
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
  const worker = await startBalanceWorker(parseArgs(process.argv.slice(2)));
  process.stdout.write(`[balance-worker] listening as ${worker.serviceName}\n`);

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
