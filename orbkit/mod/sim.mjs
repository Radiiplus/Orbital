import fs from 'node:fs';
import path from 'node:path';
import { config as lumosConfig, helpers } from '@ckb-lumos/lumos';
import {
  assert,
  assertRpcReachable,
  isMainModule,
  loadConfig,
  normalizeNetwork,
  parseBinNameFromCargoToml,
  resolveContractDir,
  toRootRelative,
} from './common.mjs';
import { buildOnlyContracts } from './buildeploy.mjs';

const DEFAULT_FEE_RATE = 1200n;
const SHANNONS_PER_CKB = 100000000n;
const TYPE_ID_CODE_HASH = '0x00000000000000000000000000000000000000000000000000545950455f4944';
const TYPE_ID_ARGS_BYTES = 32;
const HASH_TYPE_BYTES = 1;
const CAPACITY_BYTES = 8;
const CHANGE_CELL_RESERVE_CKB = 62n;

function normalizeContractPath(value) {
  const contractPath = String(value || '').trim().replace(/\\/g, '/');
  assert(contractPath, 'contractPath is required.');
  return contractPath;
}

function normalizeBuildFlag(value, fallback = false) {
  if (value === undefined) return Boolean(fallback);
  return Boolean(value);
}

function normalizeDeployKind(value) {
  const kind = String(value || 'typeid').trim().toLowerCase();
  assert(kind === 'typeid' || kind === 'data', 'deployKind must be "typeid" or "data".');
  return kind;
}

function resolveNetworkConfig(network) {
  return network === 'mainnet'
    ? lumosConfig.predefined.LINA
    : lumosConfig.predefined.AGGRON4;
}

function hexByteLength(value) {
  const hex = String(value || '').trim().replace(/^0x/i, '');
  if (!hex) return 0;
  return Math.ceil(hex.length / 2);
}

function shannonsToCkb(value) {
  return Number(value) / Number(SHANNONS_PER_CKB);
}

function resolveLockScript({ address, network }) {
  const normalizedAddress = String(address || '').trim();
  const networkConfig = resolveNetworkConfig(network);
  if (normalizedAddress) {
    return helpers.parseAddress(normalizedAddress, { config: networkConfig });
  }

  const secp = networkConfig.SCRIPTS.SECP256K1_BLAKE160;
  return {
    codeHash: secp.CODE_HASH,
    hashType: secp.HASH_TYPE,
    args: `0x${'00'.repeat(20)}`,
  };
}

function estimateDeployCapacity({ binaryBytes, network, address, deployKind }) {
  const lockScript = resolveLockScript({ address, network });
  const lockScriptBytes = hexByteLength(lockScript.codeHash)
    + hexByteLength(lockScript.args)
    + HASH_TYPE_BYTES;
  const typeScriptBytes = deployKind === 'typeid'
    ? hexByteLength(TYPE_ID_CODE_HASH) + TYPE_ID_ARGS_BYTES + HASH_TYPE_BYTES
    : 0;
  const codeCellBytes = CAPACITY_BYTES + lockScriptBytes + typeScriptBytes + binaryBytes;
  const codeCellShannons = BigInt(codeCellBytes) * SHANNONS_PER_CKB;
  const changeCellShannons = CHANGE_CELL_RESERVE_CKB * SHANNONS_PER_CKB;
  const estimatedTotalShannons = codeCellShannons + changeCellShannons;

  return {
    codeCellBytes,
    lockScriptBytes,
    typeScriptBytes,
    codeCellShannons,
    changeCellShannons,
    estimatedTotalShannons,
  };
}

function resolveBinaryPath({ cfg, network, contractDir, contractPath, buildResult }) {
  const workspaceRoot = cfg._resolved.workspaceRoot;
  const outputDir = cfg._resolved.deploymentOutput;
  const plannedScriptName = parseBinNameFromCargoToml(contractDir) || path.basename(contractDir);
  const builtEntry = buildResult?.results?.find((item) => item.contractPath === contractPath) || null;
  const builtPath = builtEntry?.binaryPath ? path.resolve(workspaceRoot, builtEntry.binaryPath) : null;
  const candidates = [
    builtPath,
    path.join(outputDir, network, plannedScriptName, plannedScriptName),
    path.join(contractDir, 'target-windows', 'riscv64imac-unknown-none-elf', 'release', plannedScriptName),
    path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release', plannedScriptName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve built binary for ${contractPath}.`);
}

function estimateDeployFee(binaryBytes, network) {
  const serializedTxBytes = BigInt(binaryBytes + 520);
  const feeRate = network === 'mainnet' ? 1500n : DEFAULT_FEE_RATE;
  const feeShannons = (serializedTxBytes * feeRate + 999n) / 1000n;
  return {
    txBytesEstimate: Number(serializedTxBytes),
    feeRateShannonsPerKb: feeRate.toString(),
    feeShannons: feeShannons.toString(),
    feeCkb: (Number(feeShannons) / Number(SHANNONS_PER_CKB)).toFixed(8),
  };
}

export async function simulateDeployCost(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const contractPath = normalizeContractPath(input.contractPath);
  const shouldBuild = normalizeBuildFlag(input.build, false);
  const workspaceRoot = cfg._resolved.workspaceRoot;
  const contractDir = resolveContractDir(workspaceRoot, contractPath);

  await assertRpcReachable(network, cfg.networks[network].rpcUrl);

  let buildResult = null;
  if (shouldBuild) {
    buildResult = await buildOnlyContracts({
      configPath: input.configPath || undefined,
      network,
      contractPath,
    });
  }

  const binaryPath = resolveBinaryPath({
    cfg,
    network,
    contractDir,
    contractPath: toRootRelative(workspaceRoot, contractDir),
    buildResult,
  });
  const stat = fs.statSync(binaryPath);
  const binaryBytes = stat.size;
  const fee = estimateDeployFee(binaryBytes, network);
  const deployKind = normalizeDeployKind(input.deployKind);
  const capacityEstimate = estimateDeployCapacity({
    binaryBytes,
    network,
    address: input.address || input.walletAddress,
    deployKind,
  });
  const codeCellCkb = shannonsToCkb(capacityEstimate.codeCellShannons);
  const changeCellCkb = shannonsToCkb(capacityEstimate.changeCellShannons);
  const estimatedTotalCkb = shannonsToCkb(capacityEstimate.estimatedTotalShannons);

  return {
    ok: true,
    network,
    contractPath: toRootRelative(workspaceRoot, contractDir),
    binaryPath: toRootRelative(workspaceRoot, binaryPath),
    binaryBytes,
    binarySizeBytes: binaryBytes,
    binaryKiB: Number((binaryBytes / 1024).toFixed(2)),
    deployKind,
    cells: {
      inputCount: null,
      outputCount: 2,
      codeCellCount: 1,
      changeCellCount: 1,
    },
    capacity: {
      codeCellCkb,
      codeCellShannons: capacityEstimate.codeCellShannons.toString(),
      codeCellBytes: capacityEstimate.codeCellBytes,
      changeCellCkb,
      changeCellShannons: capacityEstimate.changeCellShannons.toString(),
      feeCkb: Number(fee.feeCkb),
      safetyBufferCkb: 0,
      estimatedTotalCkb,
      estimatedTotalShannons: capacityEstimate.estimatedTotalShannons.toString(),
    },
    requiredCapacity: {
      requestedCkb: null,
      estimatedMinimumCkb: codeCellCkb,
      adjustedRequiredCkb: estimatedTotalCkb,
      autoOverheadApplied: true,
      autoOverheadCkb: changeCellCkb,
    },
    fee,
    note: 'CKB deploy capacity is dominated by the on-chain code cell size; the fee estimate is separate and much smaller.',
    assumptions: {
      buildTriggered: shouldBuild,
      txOverheadBytes: 520,
      changeCellReserveCkb: changeCellCkb,
      codeCellBytes: capacityEstimate.codeCellBytes,
      note: 'Fee estimate uses binary size plus a fixed transaction overhead. Required capacity estimates the Type ID code cell plus the minimum change-cell reserve used by Lumos deploy helpers.',
    },
  };
}

function parseArgs(argv) {
  const out = {
    configPath: undefined,
    contractPath: '',
    network: '',
    build: false,
    deployKind: 'typeid',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      out.configPath = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--network') {
      out.network = String(argv[++i] || '').trim();
      continue;
    }
    if (arg === '--build') {
      out.build = true;
      continue;
    }
    if (arg === '--kind') {
      out.deployKind = String(argv[++i] || '').trim();
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!out.contractPath) {
      out.contractPath = String(arg || '').trim();
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!out.contractPath) {
    throw new Error('Missing required arg: <contractPath>');
  }

  return out;
}

async function main() {
  const result = await simulateDeployCost(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sim] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
