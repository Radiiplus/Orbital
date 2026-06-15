import fs from 'node:fs';
import path from 'node:path';
import { utils } from '@ckb-lumos/base';
import { bytes } from '@ckb-lumos/codec';
import { config as lumosConfig, helpers } from '@ckb-lumos/lumos';
import {
  loadConfig,
  parseBinNameFromCargoToml,
  resolveContractDir,
  rpcCall,
  toRootRelative,
} from './common.mjs';

const LUMOS_CONFIG_BY_NETWORK = {
  devnet: lumosConfig.predefined.AGGRON4,
  testnet: lumosConfig.predefined.AGGRON4,
  mainnet: lumosConfig.predefined.LINA,
};

function normalizeContractPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function normalizeNetwork(value) {
  const network = String(value || 'devnet').trim().toLowerCase();
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) {
    throw new Error('network must be one of: devnet, testnet, mainnet.');
  }
  return network;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function scriptNameForContract(cfg, contractPath) {
  const workspaceRoot = cfg._resolved.workspaceRoot;
  const contractDir = resolveContractDir(workspaceRoot, contractPath);
  return parseBinNameFromCargoToml(contractDir) || path.basename(contractDir);
}

function receiptPath(cfg, network, scriptName) {
  return path.join(cfg._resolved.deploymentOutput, network, scriptName, 'last-deployment.json');
}

function hexByteLength(value) {
  const hex = String(value || '0x');
  if (hex === '0x') return 0;
  return Math.max(0, (hex.length - 2) / 2);
}

function toLumosScript(script) {
  if (!script) return null;
  const normalized = {
    codeHash: script.codeHash || script.code_hash,
    hashType: script.hashType || script.hash_type,
    args: script.args,
  };
  if (!normalized.codeHash || !normalized.hashType || !normalized.args) return null;
  return normalized;
}

function normalizeTypeId(payload) {
  if (!payload) return { typeId: null, typeScript: null };
  const typeScript = toLumosScript(payload.typeScript)
    || (typeof payload.typeId === 'object' ? toLumosScript(payload.typeId) : null);
  const rawTypeId = typeof payload.typeId === 'string' ? payload.typeId.trim() : '';
  return {
    typeId: rawTypeId && rawTypeId !== '[object Object]' ? rawTypeId : typeScript?.args || null,
    typeScript,
  };
}

function scriptConfigFromCell(cell) {
  const outPoint = cell?.out_point || cell?.outPoint || {};
  const output = cell?.output || cell?.cell_output || {};
  const typeScript = toLumosScript(output.type);
  if (typeScript) {
    return {
      CODE_HASH: utils.computeScriptHash(typeScript),
      HASH_TYPE: 'type',
      TX_HASH: outPoint.tx_hash || outPoint.txHash || null,
      INDEX: outPoint.index || '0x0',
      DEP_TYPE: 'code',
    };
  }

  const outputData = String(cell?.output_data || cell?.data || '0x');
  return {
    CODE_HASH: utils.ckbHash(bytes.bytify(outputData)),
    HASH_TYPE: 'data2',
    TX_HASH: outPoint.tx_hash || outPoint.txHash || null,
    INDEX: outPoint.index || '0x0',
    DEP_TYPE: 'code',
  };
}

function lockScriptForAddress(address, network) {
  const lumosPreset = LUMOS_CONFIG_BY_NETWORK[network];
  if (!address || !lumosPreset) return null;
  lumosConfig.initializeConfig(lumosPreset);
  const parsed = helpers.parseAddress(address, { config: lumosPreset });
  return {
    code_hash: parsed.codeHash,
    hash_type: parsed.hashType,
    args: parsed.args,
  };
}

async function findDeploymentCell({ cfg, network, walletAddress, binaryBytes }) {
  const lockScript = lockScriptForAddress(walletAddress, network);
  if (!lockScript) return null;
  const indexerUrl = cfg.networks[network].indexerUrl || cfg.networks[network].rpcUrl;
  const pageLimit = 100;
  let afterCursor = null;
  const candidates = [];

  for (let page = 0; page < 20; page += 1) {
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
      const outputData = String(cell?.output_data || cell?.data || '0x');
      if (outputData === '0x' || outputData.length <= 2) continue;
      const dataBytes = hexByteLength(outputData);
      if (Number.isFinite(Number(binaryBytes)) && Number(binaryBytes) > 0 && dataBytes !== Number(binaryBytes)) continue;
      candidates.push(cell);
    }
    if (objects.length < pageLimit) break;
    afterCursor = result?.last_cursor || null;
    if (!afterCursor) break;
  }

  return candidates.sort((left, right) => {
    const rightBlock = Number(BigInt(right?.block_number || '0x0'));
    const leftBlock = Number(BigInt(left?.block_number || '0x0'));
    if (rightBlock !== leftBlock) return rightBlock - leftBlock;
    const rightIndex = Number(BigInt(right?.tx_index || '0x0'));
    const leftIndex = Number(BigInt(left?.tx_index || '0x0'));
    return rightIndex - leftIndex;
  })[0] || null;
}

function normalizeReceipt(cfg, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const contractPath = normalizeContractPath(payload.contractPath);
  if (!contractPath) return null;
  const network = normalizeNetwork(payload.network || cfg?.deployment?.network || 'devnet');
  const scriptName = String(payload.scriptName || payload.contractName || scriptNameForContract(cfg, contractPath)).trim();
  const binaryPath = payload.binaryPath ? String(payload.binaryPath).replace(/\\/g, '/') : null;
  const absoluteBinaryPath = binaryPath
    ? path.resolve(cfg._resolved.workspaceRoot, binaryPath)
    : null;
  const binaryBytes = Number.isFinite(Number(payload.binaryBytes))
    ? Number(payload.binaryBytes)
    : absoluteBinaryPath && fs.existsSync(absoluteBinaryPath)
      ? fs.statSync(absoluteBinaryPath).size
      : null;
  const scriptConfig = payload.scriptConfig && typeof payload.scriptConfig === 'object'
    ? payload.scriptConfig
    : null;
  const { typeId, typeScript } = normalizeTypeId(payload);

  return {
    ok: true,
    contractName: String(payload.contractName || scriptName || contractPath).trim(),
    contractPath,
    scriptName,
    network,
    txHash: payload.txHash ? String(payload.txHash).trim() : scriptConfig?.TX_HASH || null,
    deployAddress: payload.deployAddress ? String(payload.deployAddress).trim() : null,
    binaryBytes,
    binaryPath,
    deployKind: payload.deployKind ? String(payload.deployKind).trim() : null,
    sponsored: Boolean(payload.sponsored),
    sponsorMode: payload.sponsorMode ? String(payload.sponsorMode).trim() : null,
    sponsorAddress: payload.sponsorAddress ? String(payload.sponsorAddress).trim() : null,
    scriptConfig,
    typeId,
    typeScript,
    service: payload.service ? String(payload.service).trim() : null,
    walletAddress: payload.walletAddress ? String(payload.walletAddress).trim() : payload.deployAddress ? String(payload.deployAddress).trim() : null,
    walletLabel: payload.walletLabel ? String(payload.walletLabel).trim() : null,
    broadcast: payload.broadcast ?? null,
    deployedAt: payload.deployedAt || payload.createdAt || new Date().toISOString(),
    source: payload.source ? String(payload.source).trim() : 'orbkit-deployment-receipt',
  };
}

export function writeLastDeploymentReceipt(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const receipt = normalizeReceipt(cfg, input);
  if (!receipt) return null;
  writeJson(receiptPath(cfg, receipt.network, receipt.scriptName), receipt);
  return receipt;
}

export function readLastDeploymentReceipt(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const contractPath = normalizeContractPath(input.contractPath);
  if (contractPath) {
    const scriptName = scriptNameForContract(cfg, contractPath);
    const direct = normalizeReceipt(cfg, loadJson(receiptPath(cfg, network, scriptName)));
    if (direct) return direct;
  }

  const networkDir = path.join(cfg._resolved.deploymentOutput, network);
  if (!fs.existsSync(networkDir)) return null;
  const receipts = fs.readdirSync(networkDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizeReceipt(cfg, loadJson(path.join(networkDir, entry.name, 'last-deployment.json'))))
    .filter(Boolean)
    .sort((left, right) => new Date(right.deployedAt).getTime() - new Date(left.deployedAt).getTime());
  return receipts[0] || null;
}

export function legacyDeploymentReceipt(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const contractPath = normalizeContractPath(input.contractPath);
  if (!contractPath) return null;
  const scriptName = scriptNameForContract(cfg, contractPath);
  const binaryPath = path.join(cfg._resolved.deploymentOutput, network, scriptName, scriptName);
  if (!fs.existsSync(binaryPath)) return null;
  return normalizeReceipt(cfg, {
    contractName: scriptName,
    contractPath,
    scriptName,
    network,
    binaryPath: toRootRelative(cfg._resolved.workspaceRoot, binaryPath),
    binaryBytes: fs.statSync(binaryPath).size,
    deployedAt: fs.statSync(binaryPath).mtime.toISOString(),
    source: 'orbkit-deployment-binary',
  });
}

export async function backfillDeploymentReceipt(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const legacy = legacyDeploymentReceipt(input);
  if (!legacy) return null;
  const walletAddress = String(input.walletAddress || input.deployAddress || '').trim();
  if (!walletAddress) return legacy;

  const cell = await findDeploymentCell({
    cfg,
    network: legacy.network,
    walletAddress,
    binaryBytes: legacy.binaryBytes,
  }).catch(() => null);
  if (!cell) return legacy;

  const outPoint = cell.out_point || cell.outPoint || {};
  const output = cell.output || cell.cell_output || {};
  const scriptConfig = scriptConfigFromCell(cell);
  const typeScript = toLumosScript(output.type);
  const receipt = normalizeReceipt(cfg, {
    ...legacy,
    txHash: outPoint.tx_hash || outPoint.txHash || null,
    deployAddress: walletAddress,
    walletAddress,
    deployKind: typeScript ? 'typeid' : 'data',
    scriptConfig,
    typeId: typeScript?.args || null,
    source: 'orbkit-chain-backfill',
  });
  if (receipt) {
    writeJson(receiptPath(cfg, receipt.network, receipt.scriptName), receipt);
  }
  return receipt || legacy;
}
