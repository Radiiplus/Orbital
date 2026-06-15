import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMainModule, loadConfig } from './common.mjs';
import { startFundingWorker } from './funding-worker.mjs';
import { startBuildDeployWorker } from './build-deploy-worker.mjs';
import { startStructureWorker } from './structure-worker.mjs';
import { startBalanceWorker } from './balance-worker.mjs';
import { ensureDevnetReady } from './setup.js';
import { publishServiceEvent, resolveServerApiKey } from './serverevents.mjs';
import { resolveGraphqlAuthToken, subscribeGraphqlStream } from './graphqlws.mjs';
import { shouldUseFirebaseTransport } from './firebase-transport.mjs';
import { startFirebaseWorker } from './firebase-worker.mjs';

const DEFAULT_SERVICE_NAME = process.env.ORBKIT_SERVICE_NAME || `orbkit-${randomUUID().slice(0, 8)}`;

function classifyConnectionFailure(error, base) {
  const message = error instanceof Error ? error.message : String(error);
  const httpToken = resolveServerApiKey(base);
  const wsToken = resolveGraphqlAuthToken(base);
  const hasAnyToken = Boolean(String(httpToken || '').trim() || String(wsToken || '').trim());
  const lowered = message.toLowerCase();

  if (!hasAnyToken) {
    return {
      kind: 'missing-api-key',
      detail: 'No orbkit API key is configured. Set ORBKIT_API_KEY or provide the auth token in the orbkit config.',
    };
  }

  if (
    lowered.includes('unauthorized')
    || lowered.includes('forbidden')
    || lowered.includes('4401')
    || lowered.includes('invalid api key')
  ) {
    return {
      kind: 'invalid-api-key',
      detail: 'Orbkit failed to authenticate with the backend. The API key is missing, incorrect, or does not match the server ORBKIT_API_KEY.',
    };
  }

  return {
    kind: 'generic',
    detail: message,
  };
}

function parseArgs(argv) {
  let serviceName = DEFAULT_SERVICE_NAME;
  let configPath;
  let workspaceRoot;
  let apiKey;
  let url;
  let wsUrl;
  let privkey = '';
  let reconnectDelayMs;
  let maxReconnectDelayMs;

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
    if (arg === '--privkey') {
      privkey = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--reconnect-delay-ms') {
      reconnectDelayMs = Number(argv[++i] || '');
      continue;
    }
    if (arg === '--max-reconnect-delay-ms') {
      maxReconnectDelayMs = Number(argv[++i] || '');
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
    privkey,
    reconnectDelayMs,
    maxReconnectDelayMs,
  };
}

export async function startOrbkit(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const base = {
    serviceName: String(input.serviceName || DEFAULT_SERVICE_NAME).trim(),
    configPath: input.configPath,
    workspaceRoot: input.workspaceRoot || cfg?._resolved?.workspaceRoot,
    apiKey: input.apiKey,
    url: input.url,
    wsUrl: input.wsUrl,
    privkey: input.privkey,
    reconnectDelayMs: Math.max(250, Number(input.reconnectDelayMs || 1000)),
    maxReconnectDelayMs: Math.max(1000, Number(input.maxReconnectDelayMs || 10000)),
  };

  if (shouldUseFirebaseTransport(base)) {
    return startFirebaseWorker(base);
  }

  let stopped = false;
  let currentWorkers = [];
  let controlSubscription = null;
  let supervisorTask = null;
  let reconnectAttempt = 0;
  let rebootTask = null;
  let devnetReady = false;

  async function stopWorkers() {
    const workers = currentWorkers;
    currentWorkers = [];
    await Promise.allSettled(workers.map((worker) => worker.stop()));
  }

  async function bootWorkers() {
    if (!devnetReady) {
      await ensureDevnetReady({
        configPath: base.configPath,
        network: cfg?.deployment?.network || 'devnet',
      });
      devnetReady = true;
    }
    const workers = await Promise.all([
      startBalanceWorker(base),
      startFundingWorker(base),
      startBuildDeployWorker(base),
      startStructureWorker(base),
    ]);
    currentWorkers = workers;
    reconnectAttempt = 0;
    process.stdout.write(`[orbkit] connected as ${base.serviceName}\n`);
  }

  async function publishRuntimeStatus(status, payload = {}) {
    await publishServiceEvent({
      ...base,
      channel: 'orbkit-control-progress',
      service: base.serviceName,
      target: 'orbital-server',
      direction: 'outbound',
      body: JSON.stringify({
        service: base.serviceName,
        status,
        ...payload,
        createdAt: new Date().toISOString(),
      }),
    }).catch(() => {
      // Control progress is informational; worker reboot should continue.
    });
  }

  async function rebootWorkers(reason = 'manual') {
    if (stopped) return;
    if (rebootTask) return rebootTask;
    rebootTask = (async () => {
      await publishRuntimeStatus('reconnecting', { reason });
      process.stdout.write(`[orbkit] reconnect requested for ${base.serviceName}\n`);
      const previousControlSubscription = controlSubscription;
      controlSubscription = null;
      previousControlSubscription?.unsubscribe();
      await stopWorkers();
      devnetReady = false;
      if (stopped) return;
      while (!stopped) {
        try {
          await bootWorkers();
          break;
        } catch (error) {
          const delay = Math.min(
            base.maxReconnectDelayMs,
            base.reconnectDelayMs * (2 ** Math.min(reconnectAttempt, 5)),
          );
          reconnectAttempt += 1;
          const failure = classifyConnectionFailure(error, base);
          await publishRuntimeStatus('retrying', {
            reason,
            error: failure.detail,
            failureKind: failure.kind,
            retryInMs: delay,
          });
          process.stderr.write(
            `[orbkit] reconnect failed for ${base.serviceName}: ${failure.detail} Retrying in ${delay}ms...\n`,
          );
          await stopWorkers();
          if (stopped) return;
          await sleep(delay);
        }
      }
      if (stopped) return;
      await startControlSubscription();
      await publishRuntimeStatus('connected', { reason });
      process.stdout.write(`[orbkit] reconnected as ${base.serviceName}\n`);
    })().catch(async (error) => {
      const failure = classifyConnectionFailure(error, base);
      await publishRuntimeStatus('failed', {
        reason,
        error: failure.detail,
        failureKind: failure.kind,
      });
      throw error;
    }).finally(() => {
      rebootTask = null;
    });
    return rebootTask;
  }

  async function startControlSubscription() {
    controlSubscription?.unsubscribe();
    controlSubscription = null;
    controlSubscription = await subscribeGraphqlStream({
      ...base,
      query: 'subscription OrbkitControl($target: String) { serviceEvents(target: $target, channel: "orbkit-control") { id channel service target body direction network createdAt } }',
      variables: {
        target: base.serviceName,
      },
      onNext: (payload) => {
        const event = payload?.data?.serviceEvents || payload?.serviceEvents || null;
        if (!event) return;
        let body = {};
        try {
          body = JSON.parse(event.body || '{}');
        } catch {
          body = {};
        }
        const command = String(body.command || '').trim().toLowerCase();
        if (command !== 'reconnect') return;
        rebootWorkers(body.reason || 'manual-ui').catch((error) => {
          process.stderr.write(`[orbkit] reconnect failed for ${base.serviceName}: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      },
    });
  }

  supervisorTask = (async () => {
    while (!stopped) {
      try {
        await bootWorkers();
        return;
      } catch (error) {
        const delay = Math.min(
          base.maxReconnectDelayMs,
          base.reconnectDelayMs * (2 ** Math.min(reconnectAttempt, 5)),
        );
        reconnectAttempt += 1;
        const failure = classifyConnectionFailure(error, base);
        process.stderr.write(
          `[orbkit] connection failed for ${base.serviceName}: ${failure.detail} Retrying in ${delay}ms...\n`,
        );
        await stopWorkers();
        if (stopped) return;
        await sleep(delay);
      }
    }
  })();

  await supervisorTask;
  await startControlSubscription();

  return {
    serviceName: base.serviceName,
    async stop() {
      if (stopped) return;
      stopped = true;
      controlSubscription?.unsubscribe();
      await stopWorkers();
    },
  };
}

async function main() {
  const runtime = await startOrbkit(parseArgs(process.argv.slice(2)));
  process.stdout.write(`[orbkit] runtime listening as ${runtime.serviceName}\n`);

  const shutdown = async () => {
    await runtime.stop();
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
