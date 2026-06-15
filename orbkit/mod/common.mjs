import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync } from 'bip39';
import { config as lumosConfig, hd, helpers } from '@ckb-lumos/lumos';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_ROOT = __dirname;
const DEFAULT_CONFIG_PATH = path.join(MODULE_ROOT, 'config.json');

export const NETWORKS = ['devnet', 'testnet', 'mainnet'];

function parseEnvLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) return null;
  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

export function loadEnvFile(envPath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) return { loaded: false, path: envPath };
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
  return { loaded: true, path: envPath };
}

loadEnvFile();

export function nowIso() {
  return new Date().toISOString();
}

export function log(prefix, message) {
  console.log(`[${prefix}] ${message}`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let fullPath;
  if (!configPath) {
    fullPath = DEFAULT_CONFIG_PATH;
  } else if (path.isAbsolute(configPath)) {
    fullPath = configPath;
  } else {
    const fromCwd = path.resolve(process.cwd(), configPath);
    const fromModuleRoot = path.resolve(MODULE_ROOT, configPath);
    fullPath = fs.existsSync(fromCwd) ? fromCwd : fromModuleRoot;
  }
  assert(fs.existsSync(fullPath), `Missing module config file: ${fullPath}`);
  const cfg = readJson(fullPath);
  const configDir = path.dirname(fullPath);

  for (const name of NETWORKS) {
    assert(cfg?.networks?.[name]?.rpcUrl, `config.networks.${name}.rpcUrl is required`);
    assert(cfg?.networks?.[name]?.offckbNetwork, `config.networks.${name}.offckbNetwork is required`);
  }

  const workspaceRoot = path.resolve(configDir, cfg?.paths?.workspaceRoot ?? '../..');
  const contractsRoot = path.resolve(configDir, cfg?.paths?.contractsRoot ?? '../../contract');
  const deploymentOutput = path.resolve(configDir, cfg?.paths?.deploymentOutput ?? '../../deployment');

  const genesisAddressesFile = path.resolve(
    configDir,
    cfg?.funder?.genesisAddressesFile ?? './genesis.json',
  );
  const genesisAddresses = fs.existsSync(genesisAddressesFile)
    ? readJson(genesisAddressesFile)
    : [];

  return {
    ...cfg,
    _resolved: {
      moduleRoot: MODULE_ROOT,
      configPath: fullPath,
      workspaceRoot,
      contractsRoot,
      deploymentOutput,
      genesisAddressesFile,
      genesisAddresses,
    },
  };
}

export function normalizeNetwork(input) {
  const normalized = String(input || '').trim().toLowerCase();
  assert(NETWORKS.includes(normalized), `Unsupported network: ${input}`);
  return normalized;
}

export function normalizePrivateKey(input, label = 'private key') {
  const raw = String(input || '').trim();
  const normalized = raw.startsWith('0x') ? raw : `0x${raw}`;
  assert(/^0x[0-9a-fA-F]{64}$/.test(normalized), `Invalid ${label} format; expected 0x-prefixed 32-byte hex.`);
  return normalized;
}

export function normalizeMnemonic(input) {
  const normalized = String(input || '').trim().replace(/\s+/g, ' ');
  assert(normalized.length > 0, 'mnemonic is required.');
  mnemonicToEntropy(normalized);
  return normalized;
}

export function createWalletFromPrivateKey(privateKeyInput, options = {}) {
  const privateKey = normalizePrivateKey(privateKeyInput, options.label || 'private key');
  const publicKey = hd.key.privateToPublic(privateKey);
  const lockArg = hd.key.privateKeyToBlake160(privateKey);
  const addresses = {
    devnet: helpers.encodeToAddress(
      {
        codeHash: lumosConfig.predefined.AGGRON4.SCRIPTS.SECP256K1_BLAKE160.CODE_HASH,
        hashType: lumosConfig.predefined.AGGRON4.SCRIPTS.SECP256K1_BLAKE160.HASH_TYPE,
        args: lockArg,
      },
      { config: lumosConfig.predefined.AGGRON4 },
    ),
    testnet: helpers.encodeToAddress(
      {
        codeHash: lumosConfig.predefined.AGGRON4.SCRIPTS.SECP256K1_BLAKE160.CODE_HASH,
        hashType: lumosConfig.predefined.AGGRON4.SCRIPTS.SECP256K1_BLAKE160.HASH_TYPE,
        args: lockArg,
      },
      { config: lumosConfig.predefined.AGGRON4 },
    ),
    mainnet: helpers.encodeToAddress(
      {
        codeHash: lumosConfig.predefined.LINA.SCRIPTS.SECP256K1_BLAKE160.CODE_HASH,
        hashType: lumosConfig.predefined.LINA.SCRIPTS.SECP256K1_BLAKE160.HASH_TYPE,
        args: lockArg,
      },
      { config: lumosConfig.predefined.LINA },
    ),
  };

  return {
    network: normalizeNetwork(options.network || 'devnet'),
    address: addresses[normalizeNetwork(options.network || 'devnet')],
    addresses,
    lockArg,
    publicKey,
    privateKey,
  };
}

export function createWalletFromMnemonic(mnemonicInput, options = {}) {
  const mnemonic = normalizeMnemonic(mnemonicInput);
  const seed = mnemonicToSeedSync(mnemonic);
  const privateKey = seed.subarray(0, 32).toString('hex');
  const wallet = createWalletFromPrivateKey(privateKey, {
    ...options,
    label: 'mnemonic-derived private key',
  });
  return {
    ...wallet,
    mnemonic,
  };
}

export function createRandomWallet(options = {}) {
  const mnemonic = entropyToMnemonic(randomBytes(16).toString('hex'));
  return createWalletFromMnemonic(mnemonic, options);
}

export function validateAddress(address) {
  const value = String(address || '').trim();
  assert(/^(ckt|ckb)1[0-9a-z]+$/i.test(value), 'walletAddress must be a ckt1... or ckb1... address');
  return value;
}

export function parseNumberInput(input, label) {
  const value = Number(input);
  assert(Number.isFinite(value) && value > 0, `${label} must be a positive number.`);
  return value;
}

export function runCmd(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.silent) process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.silent) process.stderr.write(text);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr || stdout || `${command} exited with ${code}`));
      }
    });
  });
}

export async function rpcCall(rpcUrl, method, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const transport = String(rpcUrl).startsWith('https://') ? https : http;
    const req = transport.request(
      rpcUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function assertRpcReachable(networkName, rpcUrl) {
  await rpcCall(rpcUrl, 'get_tip_block_number');
  return true;
}

export function parseBinNameFromCargoToml(contractDir) {
  const cargoTomlPath = path.join(contractDir, 'Cargo.toml');
  if (!fs.existsSync(cargoTomlPath)) return null;
  const text = fs.readFileSync(cargoTomlPath, 'utf8');
  const binMatch = text.match(/\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/m);
  if (binMatch?.[1]) return binMatch[1].trim();
  const pkgMatch = text.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/m);
  return pkgMatch?.[1]?.trim() ?? null;
}

export function resolveContractDir(workspaceRoot, inputPath) {
  const candidatePaths = [
    path.resolve(workspaceRoot, inputPath),
    path.resolve(workspaceRoot, 'contract', inputPath),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(`Contract directory not found for input: ${inputPath}`);
}

export function ensureFile(filePath, message) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(message || `Missing file: ${filePath}`);
  }
}

export function toRootRelative(root, targetPath) {
  return path.relative(root, targetPath).replace(/\\/g, '/');
}

export function findFirstTxHash(text) {
  const match = String(text || '').match(/0x[a-fA-F0-9]{64}/);
  return match?.[0] ?? null;
}

export function toWslPath(winPath) {
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

export function shouldUseWslForBuild() {
  if (process.env.ORBKIT_FORCE_WSL_UNAVAILABLE === '1') return false;
  if (process.platform !== 'win32') return false;
  try {
    return fs.existsSync('C:\\Windows\\System32\\wsl.exe');
  } catch {
    return false;
  }
}

export function assertWindowsWslAvailable(context = 'This operation') {
  if (process.platform !== 'win32') return;
  if (shouldUseWslForBuild()) return;
  throw new Error(
    `${context} requires WSL on Windows. Install WSL2 and a Linux distribution, then rerun the command.`,
  );
}

export function ensureCmd(cmd, args = ['--version'], options = {}) {
  const { useWsl = false } = options;
  return new Promise((resolve, reject) => {
    let proc;
    if (useWsl) {
      proc = spawn('wsl.exe', ['bash', '-lc', `command -v ${cmd} >/dev/null 2>&1`], { shell: false });
    } else if (process.platform === 'win32') {
      proc = spawn('cmd.exe', ['/c', cmd, ...args], { shell: false });
    } else {
      proc = spawn(cmd, args, { shell: false });
    }
    proc.on('error', () => reject(new Error(`Missing required command: ${cmd}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Missing required command: ${cmd}`))));
  });
}

export function runWithOptionalWsl(cmd, args, cwd, options = {}) {
  const { useWsl = false } = options;
  return new Promise((resolve, reject) => {
    let proc;
    if (useWsl) {
      const wslCwd = toWslPath(cwd).replace(/'/g, `'\\''`);
      const escapedArgs = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
      const script = `cd '${wslCwd}' && ${cmd} ${escapedArgs}`;
      proc = spawn('wsl.exe', ['bash', '-lc', script], { shell: false });
    } else if (process.platform === 'win32') {
      proc = spawn('cmd.exe', ['/c', cmd, ...args], { cwd, shell: false });
    } else {
      proc = spawn(cmd, args, { cwd, shell: false });
    }

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      process.stdout.write(text);
    });
    proc.stderr?.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write(text);
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `${cmd} exited with ${code}`));
    });
  });
}

export function isMainModule(importMetaUrl) {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    const thisPath = path.resolve(fileURLToPath(importMetaUrl));
    const entryPath = path.resolve(entryArg);
    if (process.platform === 'win32') {
      return thisPath.toLowerCase() === entryPath.toLowerCase();
    }
    return thisPath === entryPath;
  } catch {
    return false;
  }
}
