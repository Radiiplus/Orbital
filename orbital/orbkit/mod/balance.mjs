import { config as lumosConfig, helpers } from '@ckb-lumos/lumos';
import {
  assert,
  assertRpcReachable,
  rpcCall,
  isMainModule,
  loadConfig,
  normalizeNetwork,
  validateAddress,
} from './common.mjs';

const LUMOS_CONFIG_BY_NETWORK = {
  devnet: lumosConfig.predefined.AGGRON4,
  testnet: lumosConfig.predefined.AGGRON4,
  mainnet: lumosConfig.predefined.LINA,
};

export async function getWalletBalance(input) {
  const cfg = loadConfig(input?.configPath || undefined);
  const network = normalizeNetwork(input?.network || 'devnet');
  const walletAddress = validateAddress(input?.walletAddress);
  const pageLimit = Number.isFinite(Number(input?.pageLimit))
    ? Math.max(1, Math.min(100, Math.floor(Number(input.pageLimit))))
    : 20;
  const scanMode = String(input?.scanMode || '').trim().toLowerCase() || (network === 'devnet' ? 'full' : 'estimate');

  if (network === 'mainnet' && !walletAddress.toLowerCase().startsWith('ckb1')) {
    throw new Error('Mainnet balance lookup requires a ckb1... address.');
  }
  if (network !== 'mainnet' && !walletAddress.toLowerCase().startsWith('ckt1')) {
    throw new Error(`${network} balance lookup requires a ckt1... address.`);
  }

  const rpcUrl = cfg.networks[network].rpcUrl;
  const indexerUrl = cfg.networks[network].indexerUrl || rpcUrl;

  await assertRpcReachable(network, rpcUrl);

  const lumosPreset = LUMOS_CONFIG_BY_NETWORK[network];
  assert(lumosPreset, `No Lumos config mapping for network: ${network}`);
  lumosConfig.initializeConfig(lumosPreset);

  const parsedScript = helpers.parseAddress(walletAddress, { config: lumosPreset });
  const lockScript = {
    code_hash: parsedScript.codeHash,
    hash_type: parsedScript.hashType,
    args: parsedScript.args,
  };

  let totalShannons = 0n;
  let spendableShannons = 0n;
  let dataLockedShannons = 0n;
  let totalCellCount = 0;
  let emptyCellCount = 0;
  let dataCellCount = 0;
  let afterCursor = null;
  const seenCursors = new Set();
  const maxPages = Number.isFinite(Number(input?.maxPages))
    ? Math.max(1, Number(input.maxPages))
    : (scanMode === 'full' ? 200 : 1);
  let pageCount = 0;
  let truncated = false;
  let truncationReason = null;

  while (true) {
    pageCount += 1;
    if (pageCount > maxPages) {
      if (scanMode === 'full') {
        throw new Error(`Index scan exceeded maxPages=${maxPages}. Aborting to avoid infinite pagination.`);
      }
      truncated = true;
      truncationReason = `scanMode=estimate limit reached maxPages=${maxPages}`;
      break;
    }
    const result = await rpcCall(indexerUrl, 'get_cells', [
      {
        script: lockScript,
        script_type: 'lock',
      },
      'asc',
      `0x${pageLimit.toString(16)}`,
      afterCursor,
    ]);

    const objects = Array.isArray(result?.objects) ? result.objects : [];
    for (const cell of objects) {
      const capacityHex = cell?.output?.capacity || cell?.cell_output?.capacity;
      if (!capacityHex) continue;

      const cap = BigInt(capacityHex);
      totalShannons += cap;
      totalCellCount += 1;

      const outputData = String(cell?.output_data || cell?.data || '0x');
      const isEmptyCell = outputData === '0x' || outputData.length <= 2;
      if (isEmptyCell) {
        emptyCellCount += 1;
        spendableShannons += cap;
      } else {
        dataCellCount += 1;
        dataLockedShannons += cap;
      }
    }

    if (objects.length < pageLimit) break;
    const cursor = typeof result?.last_cursor === 'string' ? result.last_cursor : '';
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      if (scanMode === 'full') break;
      truncated = true;
      truncationReason = 'scanMode=estimate repeated last_cursor';
      break;
    }
    seenCursors.add(cursor);
    afterCursor = cursor;
  }

  const shannonsToCkb = (value) => Number(value) / 100000000;

  return {
    ok: true,
    network,
    rpcUrl,
    indexerUrl,
    walletAddress,
    totalShannons: totalShannons.toString(),
    spendableShannons: spendableShannons.toString(),
    dataLockedShannons: dataLockedShannons.toString(),
    totalCkb: shannonsToCkb(totalShannons),
    spendableCkb: shannonsToCkb(spendableShannons),
    dataLockedCkb: shannonsToCkb(dataLockedShannons),
    totalCellCount,
    emptyCellCount,
    dataCellCount,
    scanMode,
    pageLimit,
    maxPages,
    truncated,
    truncationReason,
  };
}

function usage() {
  console.log(
    `Usage:\n  node mod/balance.mjs <walletAddress> [--network devnet|testnet|mainnet] [--config <path>] [--scan-mode full|estimate] [--page-limit 1..100] [--max-pages N]`,
  );
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }

  const positionals = [];
  let network = 'devnet';
  let configPath;
  let scanMode;
  let pageLimit;
  let maxPages;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--network') {
      network = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--config') {
      configPath = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--scan-mode') {
      scanMode = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--page-limit') {
      pageLimit = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--max-pages') {
      maxPages = String(argv[++i] || '').trim();
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length < 1) {
    throw new Error('Missing required arg: <walletAddress>');
  }

  return {
    walletAddress: String(positionals[0] || '').trim(),
    network,
    configPath,
    scanMode,
    pageLimit: pageLimit ? Number(pageLimit) : undefined,
    maxPages: maxPages ? Number(maxPages) : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await getWalletBalance(args);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[balance] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
