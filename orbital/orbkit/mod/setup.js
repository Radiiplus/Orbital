import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  assertWindowsWslAvailable,
  isMainModule,
  loadConfig,
  log,
  normalizeNetwork,
  rpcCall,
  runCmd,
} from './common.mjs';

async function isRpcReachable(rpcUrl) {
  try {
    await rpcCall(rpcUrl, 'get_tip_block_number', []);
    return true;
  } catch {
    return false;
  }
}

async function waitForRpc(rpcUrl, maxAttempts, intervalMs) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const attempt = i + 1;
    log('setup', `Checking devnet RPC availability (${attempt}/${maxAttempts}) at ${rpcUrl}...`);
    if (await isRpcReachable(rpcUrl)) {
      log('setup', `Devnet RPC responded on attempt ${attempt}.`);
      return true;
    }
    if (attempt < maxAttempts) {
      log('setup', `Devnet RPC not ready yet; retrying in ${intervalMs}ms...`);
    }
    await sleep(intervalMs);
  }
  return false;
}

function launchDevnetInBackground(cwd) {
  if (process.platform === 'win32') {
    const child = spawn(
      'cmd.exe',
      ['/c', 'start', '"offckb-devnet"', '/min', 'npx', '@offckb/cli', 'node'],
      {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();
    return;
  }

  const child = spawn(
    'bash',
    ['-lc', 'nohup npx @offckb/cli node >/tmp/offckb-devnet.log 2>&1 < /dev/null &'],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();
}

export async function ensureDevnetReady(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const devnetCfg = cfg?.devnet || {};

  if (network !== 'devnet') {
    return {
      ok: true,
      skipped: true,
      reason: `network=${network}`,
      network,
    };
  }

  const autoStart = input.autoStart ?? devnetCfg.autoStart ?? true;
  const cleanBeforeStart = input.cleanBeforeStart ?? devnetCfg.cleanBeforeStart ?? true;
  const maxAttempts = Math.max(1, Number(input.maxAttempts ?? devnetCfg.startupWaitAttempts ?? 60));
  const intervalMs = Math.max(200, Number(input.intervalMs ?? devnetCfg.startupWaitIntervalMs ?? 2000));
  const rpcUrl = cfg.networks.devnet.rpcUrl;
  const cwd = cfg._resolved.workspaceRoot;

  const alreadyRunning = await isRpcReachable(rpcUrl);
  if (alreadyRunning) {
    log('setup', `Devnet already running rpc=${rpcUrl}`);
    return {
      ok: true,
      started: false,
      alreadyRunning: true,
      network,
      rpcUrl,
    };
  }

  if (!autoStart) {
    throw new Error(`Devnet is not reachable at ${rpcUrl} and devnet.autoStart is disabled.`);
  }

  assertWindowsWslAvailable('Devnet setup');

  if (cleanBeforeStart) {
    try {
      log('setup', 'Cleaning stale devnet data...');
      await runCmd('npx', ['@offckb/cli', 'clean'], { cwd, silent: true });
    } catch {
      // no-op
    }
  }

  log('setup', 'Starting devnet node...');
  launchDevnetInBackground(cwd);
  log('setup', 'Devnet launch command sent; waiting for RPC to respond...');

  const ready = await waitForRpc(rpcUrl, maxAttempts, intervalMs);
  if (!ready) {
    throw new Error(`Devnet failed to start in time at ${rpcUrl}`);
  }

  log('setup', 'Devnet is ready.');
  return {
    ok: true,
    started: true,
    alreadyRunning: false,
    network,
    rpcUrl,
    attempts: maxAttempts,
    intervalMs,
  };
}

function usage() {
  console.log(
    'Usage:\n  node mod/setup [--config mod/config.json] [--network devnet|testnet|mainnet]\n\nNotes:\n  - Auto-start only applies when network is devnet.\n  - For non-devnet networks this command exits with skipped=true.',
  );
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }

  let configPath;
  let network;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      configPath = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--network') {
      network = String(argv[++i] || '').trim();
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  return { configPath, network };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await ensureDevnetReady(args);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[setup] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
