import {
  createRandomWallet,
  createWalletFromMnemonic,
  createWalletFromPrivateKey,
  isMainModule,
  normalizeNetwork,
} from './common.mjs';

function usage() {
  console.log(
    'Usage:\n' +
      '  node mod/create.mjs [--network devnet|testnet|mainnet]\n' +
      '  node mod/create.mjs --mnemonic "<words>" [--network devnet|testnet|mainnet]\n' +
      '  node mod/create.mjs --privkey <0x...> [--network devnet|testnet|mainnet]\n\n' +
      'Notes:\n' +
      '  - With no flags, generates a fresh wallet.\n' +
      '  - --mnemonic derives a wallet from an existing mnemonic.\n' +
      '  - --privkey derives a wallet from an existing private key.\n' +
      '  - Use the resulting address with fund.mjs if you want to fund it on devnet.\n',
  );
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }

  let network = 'devnet';
  let mnemonic = '';
  let privkey = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--network') {
      network = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--mnemonic') {
      mnemonic = String(argv[++i] || '').trim();
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

  if (mnemonic && privkey) {
    throw new Error('Use either --mnemonic or --privkey, not both.');
  }

  return {
    network: normalizeNetwork(network),
    mnemonic,
    privkey,
  };
}

export function createWallet(input = {}) {
  const network = normalizeNetwork(input.network || 'devnet');
  if (input.mnemonic) {
    return {
      ok: true,
      source: 'mnemonic',
      ...createWalletFromMnemonic(input.mnemonic, { network }),
    };
  }
  if (input.privkey) {
    return {
      ok: true,
      source: 'private-key',
      ...createWalletFromPrivateKey(input.privkey, { network }),
    };
  }
  return {
    ok: true,
    source: 'generated',
    ...createRandomWallet({ network }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = createWallet(args);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[create] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
