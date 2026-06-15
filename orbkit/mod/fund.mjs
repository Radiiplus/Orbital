import path from 'node:path';
import {
  assert,
  assertRpcReachable,
  findFirstTxHash,
  isMainModule,
  loadConfig,
  log,
  normalizePrivateKey,
  parseNumberInput,
  runCmd,
  validateAddress,
} from './common.mjs';

export async function fundDevnetWallet(input) {
  const cfg = loadConfig(input?.configPath || undefined);
  const walletAddress = validateAddress(input?.walletAddress);
  const amountNumber = parseNumberInput(input?.amountInCKB, 'amountInCKB');
  assert(
    amountNumber >= 62,
    'amountInCKB must be at least 62 on CKB so recipient output can satisfy minimum occupied capacity.',
  );
  const amountInCKB = String(amountNumber);

  const network = 'devnet';
  const rpcUrl = cfg.networks.devnet.rpcUrl;
  const offckbNetwork = cfg.networks.devnet.offckbNetwork;
  assert(
    String(offckbNetwork || '').trim().toLowerCase() === 'devnet',
    'config.networks.devnet.offckbNetwork must be "devnet" for fund module.',
  );

  const privateKeyEnvName = String(cfg?.funder?.privateKeyEnv || 'FUNDER_PRIVKEY').trim();
  const defaultPrivateKey = String(cfg?.funder?.defaultPrivateKey || '').trim();
  const rawPrivkey = String(input?.privkey || process.env[privateKeyEnvName] || defaultPrivateKey).trim();
  const privkey = normalizePrivateKey(rawPrivkey, 'funder private key');

  const knownGenesisAddresses = Array.isArray(cfg?._resolved?.genesisAddresses)
    ? cfg._resolved.genesisAddresses.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (cfg?.funder?.requireKnownGenesisAddress) {
    assert(
      knownGenesisAddresses.length > 0,
      `funder.requireKnownGenesisAddress=true but no addresses found in ${cfg._resolved.genesisAddressesFile}`,
    );
  }

  log('fund', `Network: ${network}`);
  log('fund', `RPC: ${rpcUrl}`);
  log('fund', `Wallet: ${walletAddress}`);
  log('fund', `Amount: ${amountInCKB} CKB`);

  await assertRpcReachable(network, rpcUrl);

  const cwd = cfg._resolved.workspaceRoot;
  const transfer = await runCmd(
    'npx',
    [
      '@offckb/cli',
      'transfer',
      walletAddress,
      amountInCKB,
      '--network',
      offckbNetwork,
      '--privkey',
      privkey,
    ],
    { cwd },
  );

  const txHash = findFirstTxHash(`${transfer.stdout}\n${transfer.stderr}`);

  const balance = await runCmd(
    'npx',
    ['@offckb/cli', 'balance', walletAddress, '--network', offckbNetwork],
    { cwd },
  );

  const result = {
    ok: true,
    network,
    rpcUrl,
    walletAddress,
    amountInCKB,
    txHash,
    knownGenesisAddressesFile: path.relative(cwd, cfg._resolved.genesisAddressesFile).replace(/\\/g, '/'),
    knownGenesisAddressesCount: knownGenesisAddresses.length,
    balanceOutput: balance.stdout.trim() || balance.stderr.trim() || null,
  };

  log('fund', txHash ? `Transfer submitted tx=${txHash}` : 'Transfer submitted');
  return result;
}

function usage() {
  console.log(`Usage:\n  node mod/fund.mjs <walletAddress> <amountInCKB> [--privkey <0x...>] [--config <path>]\n\nNotes:\n  - This module funds devnet only.\n  - Funder private key resolution order:\n    1) --privkey\n    2) env var defined by config.funder.privateKeyEnv\n    3) config.funder.defaultPrivateKey\n`);
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }

  let privkey = '';
  let configPath;
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--privkey') {
      privkey = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--config') {
      configPath = String(argv[++i] || '').trim();
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length < 2) {
    throw new Error('Missing required args: <walletAddress> <amountInCKB>');
  }

  return {
    walletAddress: String(positionals[0] || '').trim(),
    amountInCKB: String(positionals[1] || '').trim(),
    privkey,
    configPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await fundDevnetWallet(args);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[fund] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
