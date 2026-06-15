import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockchain, utils } from '@ckb-lumos/base';
import { bytes } from '@ckb-lumos/codec';
import { Indexer, RPC, config as lumosConfig, helpers } from '@ckb-lumos/lumos';
import {
  assert,
  assertRpcReachable,
  createWalletFromPrivateKey,
  isMainModule,
  loadConfig,
  normalizeNetwork,
  normalizePrivateKey,
  parseBinNameFromCargoToml,
  resolveContractDir,
  toRootRelative,
} from './common.mjs';
import { buildOnlyContracts } from './buildeploy.mjs';
import { readLastDeploymentReceipt } from './deployment-receipts.mjs';

import {
  generateDeployWithTypeIdTx,
  generateDeployWithDataTx,
  generateUpgradeTypeIdDataTx,
} from '@ckb-lumos/common-scripts/lib/deploy.js';
import { prepareSigningEntries } from '@ckb-lumos/common-scripts/lib/common.js';

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
  if (kind !== 'typeid' && kind !== 'data') {
    throw new Error('deployKind must be "typeid" or "data".');
  }
  return kind;
}

function normalizeSponsorMode(value) {
  const mode = String(value || 'none').trim().toLowerCase();
  if (!['none', 'devnet-funder'].includes(mode)) {
    throw new Error('sponsorMode must be "none" or "devnet-funder".');
  }
  return mode;
}

function resolveNetworkConfig(network) {
  if (network === 'mainnet') return lumosConfig.predefined.LINA;
  if (network === 'devnet') {
    return {
      ...lumosConfig.predefined.AGGRON4,
      SCRIPTS: {
        ...lumosConfig.predefined.AGGRON4.SCRIPTS,
        SECP256K1_BLAKE160: {
          ...lumosConfig.predefined.AGGRON4.SCRIPTS.SECP256K1_BLAKE160,
          TX_HASH: '0x4d804f1495612631da202fe9902fa9899118554b08138cfe5dfb50e1ede76293',
          INDEX: '0x0',
          DEP_TYPE: 'depGroup',
        },
        SECP256K1_BLAKE160_MULTISIG: {
          ...lumosConfig.predefined.AGGRON4.SCRIPTS.SECP256K1_BLAKE160_MULTISIG,
          TX_HASH: '0x4d804f1495612631da202fe9902fa9899118554b08138cfe5dfb50e1ede76293',
          INDEX: '0x1',
          DEP_TYPE: 'depGroup',
        },
      },
    };
  }
  return lumosConfig.predefined.AGGRON4;
}

function resolveFunderPrivateKey(cfg, input = {}) {
  const privateKeyEnvName = String(cfg?.funder?.privateKeyEnv || 'FUNDER_PRIVKEY').trim();
  const rawPrivkey = String(input.privkey || process.env[privateKeyEnvName] || cfg?.funder?.defaultPrivateKey || '').trim();
  return normalizePrivateKey(rawPrivkey, 'funder private key');
}

function resolveBinaryPath({ cfg, network, contractDir, contractPath, buildResult }) {
  const workspaceRoot = cfg._resolved.workspaceRoot;
  const outputDir = cfg._resolved.deploymentOutput;
  const scriptName = parseBinNameFromCargoToml(contractDir) || path.basename(contractDir);
  const builtEntry = buildResult?.results?.find((item) => item.contractPath === contractPath) || null;
  const candidates = [
    builtEntry?.binaryPath ? path.resolve(workspaceRoot, builtEntry.binaryPath) : null,
    path.join(outputDir, network, scriptName, scriptName),
    path.join(contractDir, 'target-windows', 'riscv64imac-unknown-none-elf', 'release', scriptName),
    path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release', scriptName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve binary for ${contractPath}.`);
}

function makeCellProvider(rpcUrl) {
  return new Indexer(rpcUrl, rpcUrl);
}

function formatSigningEntries(txSkeleton) {
  return txSkeleton.get('signingEntries').toArray().map((entry) => ({
    type: entry.type,
    index: entry.index,
    message: entry.message,
  }));
}

function formatTxForClient(tx) {
  return {
    version: tx.version,
    cellDeps: tx.cellDeps,
    headerDeps: tx.headerDeps,
    inputs: tx.inputs,
    outputs: tx.outputs,
    outputsData: tx.outputsData,
    witnesses: tx.witnesses,
  };
}

function calculateScriptConfig(txSkeleton, outputIndex) {
  const output = txSkeleton.get('outputs').get(outputIndex);
  if (!output) throw new Error(`Unable to resolve deploy output at index ${outputIndex}.`);
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);
  const txHash = utils.ckbHash(blockchain.RawTransaction.pack(tx));
  const typeScript = output.cellOutput.type;
  if (typeScript) {
    return {
      CODE_HASH: utils.computeScriptHash(typeScript),
      HASH_TYPE: 'type',
      TX_HASH: txHash,
      INDEX: `0x${outputIndex.toString(16)}`,
      DEP_TYPE: 'code',
    };
  }
  return {
    CODE_HASH: utils.ckbHash(bytes.bytify(output.data || '0x')),
    HASH_TYPE: 'data2',
    TX_HASH: txHash,
    INDEX: `0x${outputIndex.toString(16)}`,
    DEP_TYPE: 'code',
  };
}

function splitSigningEntriesByLock(txSkeleton) {
  const entries = txSkeleton.get('signingEntries').toArray();
  const inputs = txSkeleton.get('inputs');
  return entries.map((entry) => {
    const input = inputs.get(Number(entry.index));
    return {
      type: entry.type,
      index: entry.index,
      message: entry.message,
      lock: input?.cellOutput?.lock || null,
    };
  });
}

function sameScript(left, right) {
  return (
    left?.codeHash === right?.codeHash
    && left?.hashType === right?.hashType
    && left?.args === right?.args
  );
}

function normalizeLumosScript(script) {
  if (!script || typeof script !== 'object') return null;
  const codeHash = String(script.codeHash || script.code_hash || '').trim();
  const hashType = String(script.hashType || script.hash_type || '').trim();
  const args = String(script.args || '').trim();
  if (!codeHash || !hashType || !args) return null;
  return { codeHash, hashType, args };
}

function typeIdDisplay(typeScript) {
  return normalizeLumosScript(typeScript)?.args || null;
}

function outputAt(transaction, index) {
  const outputs = transaction?.outputs || transaction?.outputs_data || [];
  if (!Array.isArray(outputs)) return null;
  return outputs[index] || null;
}

async function resolveReceiptTypeScript(receipt, rpc) {
  const direct = normalizeLumosScript(receipt?.typeScript) || normalizeLumosScript(receipt?.typeId);
  if (direct) return direct;

  const scriptConfig = receipt?.scriptConfig && typeof receipt.scriptConfig === 'object'
    ? receipt.scriptConfig
    : null;
  const txHash = String(scriptConfig?.TX_HASH || receipt?.txHash || '').trim();
  if (!txHash || String(scriptConfig?.HASH_TYPE || '').toLowerCase() !== 'type') return null;

  const index = Number(BigInt(String(scriptConfig?.INDEX || '0x0')));
  const tx = await rpc.getTransaction(txHash);
  const output = outputAt(tx?.transaction, index);
  return normalizeLumosScript(output?.type || output?.cellOutput?.type || output?.cell_output?.type);
}

async function resolveUpgradeTarget({ cfg, network, contractPath, address, rpc }) {
  const receipt = readLastDeploymentReceipt({
    configPath: cfg._resolved.configPath,
    network,
    contractPath,
  });
  if (!receipt || String(receipt.deployKind || '').toLowerCase() !== 'typeid') return null;

  const receiptAddress = String(receipt.walletAddress || receipt.deployAddress || '').trim();
  if (receiptAddress && receiptAddress !== address) return null;

  const typeScript = await resolveReceiptTypeScript(receipt, rpc).catch(() => null);
  if (!typeScript) return null;
  return { receipt, typeScript };
}

function formatSponsoredSigningEntries(txSkeleton, sponsorLock) {
  const entries = splitSigningEntriesByLock(txSkeleton);
  return {
    walletSigningEntries: entries
      .filter((entry) => !sameScript(entry.lock, sponsorLock))
      .map(({ lock, ...entry }) => entry),
    sponsorSigningEntries: entries
      .filter((entry) => sameScript(entry.lock, sponsorLock))
      .map(({ lock, ...entry }) => entry),
  };
}

export async function prepareDeployTransaction(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const contractPath = normalizeContractPath(input.contractPath);
  const shouldBuild = normalizeBuildFlag(input.build, false);
  const deployKind = normalizeDeployKind(input.deployKind);
  const sponsorMode = normalizeSponsorMode(input.sponsorMode);
  const workspaceRoot = cfg._resolved.workspaceRoot;
  const contractDir = resolveContractDir(workspaceRoot, contractPath);
  const address = String(input.address || '').trim();
  assert(address, 'address is required.');

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
  const scriptBinary = fs.readFileSync(binaryPath);
  const rpcUrl = cfg.networks[network].rpcUrl;
  const networkConfig = resolveNetworkConfig(network);
  const cellProvider = makeCellProvider(rpcUrl);
  const rpc = new RPC(rpcUrl);
  const ownerLock = helpers.parseAddress(address, { config: networkConfig });

  if (network === 'devnet' && sponsorMode === 'devnet-funder') {
    const sponsorPrivateKey = resolveFunderPrivateKey(cfg, input);
    const sponsorWallet = createWalletFromPrivateKey(sponsorPrivateKey, { network });
    const sponsorAddress = sponsorWallet.address;
    const sponsorLock = helpers.parseAddress(sponsorAddress, { config: networkConfig });

    const sponsoredDeploy = deployKind === 'data'
      ? await generateDeployWithDataTx({
          cellProvider,
          scriptBinary,
          fromInfo: sponsorAddress,
          config: networkConfig,
        })
      : await generateDeployWithTypeIdTx({
          cellProvider,
          scriptBinary,
          fromInfo: sponsorAddress,
          config: networkConfig,
        });

    let txSkeleton = sponsoredDeploy.txSkeleton.update('outputs', (outputs) => (
      outputs.setIn([0, 'cellOutput', 'lock'], ownerLock)
    ));
    txSkeleton = await prepareSigningEntries(txSkeleton, {
      config: networkConfig,
    });
    const tx = helpers.createTransactionFromSkeleton(txSkeleton);
    const splitEntries = formatSponsoredSigningEntries(txSkeleton, sponsorLock);
    const scriptConfig = calculateScriptConfig(txSkeleton, 0);

    return {
      ok: true,
      action: 'deploy-prepare',
      sponsored: true,
      sponsorMode,
      network,
      contractPath: toRootRelative(workspaceRoot, contractDir),
      binaryPath: toRootRelative(workspaceRoot, binaryPath),
      binaryBytes: scriptBinary.byteLength,
      deployKind,
      address,
      sponsorAddress,
      scriptConfig,
      typeId: typeIdDisplay(sponsoredDeploy.typeId),
      typeScript: normalizeLumosScript(sponsoredDeploy.typeId),
      signingEntries: splitEntries.walletSigningEntries,
      sponsorSigningEntries: splitEntries.sponsorSigningEntries,
      unsignedTx: formatTxForClient(tx),
    };
  }

  const upgradeTarget = deployKind === 'typeid'
    ? await resolveUpgradeTarget({
        cfg,
        network,
        contractPath: toRootRelative(workspaceRoot, contractDir),
        address,
        rpc,
      })
    : null;

  if (upgradeTarget?.typeScript) {
    const upgradeResult = await generateUpgradeTypeIdDataTx({
      cellProvider,
      scriptBinary,
      fromInfo: address,
      config: networkConfig,
      typeId: upgradeTarget.typeScript,
    });
    const txSkeleton = await prepareSigningEntries(upgradeResult.txSkeleton, {
      config: networkConfig,
    });
    const tx = helpers.createTransactionFromSkeleton(txSkeleton);

    return {
      ok: true,
      action: 'deploy-prepare',
      deployMode: 'upgrade',
      redeploy: true,
      network,
      contractPath: toRootRelative(workspaceRoot, contractDir),
      binaryPath: toRootRelative(workspaceRoot, binaryPath),
      binaryBytes: scriptBinary.byteLength,
      deployKind,
      address,
      scriptConfig: upgradeResult.scriptConfig,
      typeId: typeIdDisplay(upgradeTarget.typeScript),
      typeScript: upgradeTarget.typeScript,
      previousDeployment: {
        txHash: upgradeTarget.receipt?.txHash || null,
        deployedAt: upgradeTarget.receipt?.deployedAt || null,
      },
      signingEntries: formatSigningEntries(txSkeleton),
      unsignedTx: formatTxForClient(tx),
    };
  }

  const deployResult = deployKind === 'data'
    ? await generateDeployWithDataTx({
        cellProvider,
        scriptBinary,
        fromInfo: address,
        config: networkConfig,
      })
    : await generateDeployWithTypeIdTx({
        cellProvider,
        scriptBinary,
        fromInfo: address,
        config: networkConfig,
      });

  const txSkeleton = await prepareSigningEntries(deployResult.txSkeleton, {
    config: networkConfig,
  });
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);

  return {
    ok: true,
    action: 'deploy-prepare',
    network,
    contractPath: toRootRelative(workspaceRoot, contractDir),
    binaryPath: toRootRelative(workspaceRoot, binaryPath),
    binaryBytes: scriptBinary.byteLength,
    deployKind,
    address,
    scriptConfig: deployResult.scriptConfig,
    typeId: typeIdDisplay(deployResult.typeId),
    typeScript: normalizeLumosScript(deployResult.typeId),
    signingEntries: formatSigningEntries(txSkeleton),
    unsignedTx: formatTxForClient(tx),
  };
}

export async function broadcastSignedDeployTransaction(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const tx = input.tx;
  if (!tx || typeof tx !== 'object') {
    throw new Error('tx is required.');
  }

  await assertRpcReachable(network, cfg.networks[network].rpcUrl);
  const rpc = new RPC(cfg.networks[network].rpcUrl);
  const txHash = await rpc.sendTransaction(tx, 'passthrough');
  return {
    ok: true,
    network,
    txHash,
  };
}

function parseArgs(argv) {
  const out = {
    configPath: undefined,
    contractPath: '',
    network: '',
    build: false,
    address: '',
    deployKind: 'typeid',
    mode: 'prepare',
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
    if (arg === '--address') {
      out.address = String(argv[++i] || '').trim();
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
    if (arg === '--broadcast') {
      out.mode = 'broadcast';
      continue;
    }
    if (!out.contractPath) {
      out.contractPath = String(arg || '').trim();
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!out.contractPath && out.mode !== 'broadcast') {
    throw new Error('Missing required arg: <contractPath>');
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'prepare') {
    const result = await prepareDeployTransaction(args);
    console.log(JSON.stringify(result, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const filePath = fileURLToPath(import.meta.url);
    process.stderr.write(`[${path.basename(filePath)}] Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
