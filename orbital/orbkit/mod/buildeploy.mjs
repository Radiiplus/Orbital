import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  assert,
  assertRpcReachable,
  assertWindowsWslAvailable,
  ensureCmd,
  ensureFile,
  isMainModule,
  loadConfig,
  log,
  normalizeNetwork,
  parseBinNameFromCargoToml,
  resolveContractDir,
  runCmd,
  runWithOptionalWsl,
  shouldUseWslForBuild,
  toRootRelative,
  writeJson,
} from './common.mjs';
import { ensureDevnetReady } from './setup.js';

async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    runners.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        await worker(item);
      }
    })());
  }
  await Promise.all(runners);
}

function parseCliArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const out = {
    configPath: undefined,
    network: '',
    build: undefined,
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
    if (arg === '--no-build') {
      out.build = false;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return out;
}

function printUsage() {
  console.log(`Usage:\n  node mod/buildeploy.mjs [--config mod/config.json] [--network devnet|testnet|mainnet] [--build|--no-build]\n\nNotes:\n  - Uses one shared config file.\n  - Reads contract list from orbkit-side orbital.config.js.\n  - Deploy private key is required via env: CKB_PRIVATE_KEY or DEPLOYER_PRIVKEY\n    for testnet/mainnet, and recommended for devnet.\n`);
}

function resolveDeployPrivkey(network, overridePrivkey) {
  const raw = String(overridePrivkey || process.env.CKB_PRIVATE_KEY || process.env.DEPLOYER_PRIVKEY || '').trim();
  if (!raw) {
    throw new Error(`Missing deploy private key. Set CKB_PRIVATE_KEY or DEPLOYER_PRIVKEY for ${network}.`);
  }
  return raw;
}

function resolveExistingBinaryTarget({ contractDir, scriptName, outputDir, network }) {
  const cargoBin = parseBinNameFromCargoToml(contractDir);
  const candidates = [
    path.join(outputDir, network, scriptName, scriptName),
    cargoBin ? path.join(outputDir, network, scriptName, cargoBin) : null,
    cargoBin ? path.join(contractDir, 'target-windows', 'riscv64imac-unknown-none-elf', 'release', cargoBin) : null,
    path.join(contractDir, 'target-windows', 'riscv64imac-unknown-none-elf', 'release', scriptName),
    cargoBin ? path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release', cargoBin) : null,
    path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release', scriptName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  throw new Error(`Unable to find binary target for script "${scriptName}". Build first or provide target.`);
}

async function buildContract(cfg, network, contractDir, scriptName) {
  const rustTarget = String(cfg?.deployment?.rustTarget || 'riscv64imac-unknown-none-elf');
  const rustTargetDir = String(cfg?.deployment?.rustTargetDir || 'target-windows');
  const outputDir = cfg._resolved.deploymentOutput;
  const plannedBinary = path.join(outputDir, network, scriptName, scriptName);

  const binName = parseBinNameFromCargoToml(contractDir);
  assert(binName, `Unable to determine binary name from ${path.join(contractDir, 'Cargo.toml')}`);

  if (process.env.ORBKIT_SKIP_CARGO_BUILD === '1') {
    const existingBinary = resolveExistingBinaryTarget({
      contractDir,
      scriptName,
      outputDir,
      network,
    });
    fs.mkdirSync(path.dirname(plannedBinary), { recursive: true });
    fs.copyFileSync(existingBinary, plannedBinary);
    return plannedBinary;
  }

  const useWsl = shouldUseWslForBuild();
  assertWindowsWslAvailable(`Building contract "${scriptName}"`);
  await ensureCmd('cargo', ['--version'], { useWsl });
  await ensureCmd('rustup', ['--version'], { useWsl });

  log('buildeploy', `Building ${scriptName} target=${rustTarget}`);
  await runWithOptionalWsl('rustup', ['target', 'add', rustTarget], contractDir, { useWsl });
  await runWithOptionalWsl(
    'cargo',
    ['build', '--release', '--target', rustTarget, '--target-dir', rustTargetDir],
    contractDir,
    { useWsl },
  );

  const builtPath = path.join(contractDir, rustTargetDir, rustTarget, 'release', binName);
  ensureFile(builtPath, `Build finished but binary not found: ${builtPath}`);

  fs.mkdirSync(path.dirname(plannedBinary), { recursive: true });
  fs.copyFileSync(builtPath, plannedBinary);
  return plannedBinary;
}

export async function buildOnlyContracts(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const workspaceRoot = cfg._resolved.workspaceRoot;
  const concurrency = Math.max(1, Number(cfg?.deployment?.concurrency || 1));
  const { sourcePath: contractsSourcePath, contracts } = await loadContractsFromServerConfig(cfg);

  const plans = contracts
    .map((item) => {
      const normalizedPath = String(item.path || '').trim().replace(/\\/g, '/');
      if (input.contractPath && normalizedPath !== String(input.contractPath).trim().replace(/\\/g, '/')) {
        return null;
      }
      const contractDir = resolveContractDir(workspaceRoot, item.path);
      const binName = parseBinNameFromCargoToml(contractDir);
      const scriptName = String(item.script || binName || path.basename(contractDir)).trim();
      return {
        contractDir,
        scriptName,
        contractPath: toRootRelative(workspaceRoot, contractDir),
      };
    })
    .filter(Boolean);

  assert(plans.length > 0, `No contracts matched ${input.contractPath || 'requested scope'}.`);

  const results = [];
  await runPool(plans, concurrency, async (plan) => {
    const binaryPath = await buildContract(cfg, network, plan.contractDir, plan.scriptName);
    results.push({
      scriptName: plan.scriptName,
      contractPath: plan.contractPath,
      binaryPath: toRootRelative(workspaceRoot, binaryPath),
    });
  });

  return {
    ok: true,
    action: 'build',
    network,
    concurrency,
    contractsSource: toRootRelative(workspaceRoot, contractsSourcePath),
    results: results.sort((left, right) => left.scriptName.localeCompare(right.scriptName)),
  };
}

function loadJsonOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findDeployedScript({ before, after, network, scriptNameHint, contractDir }) {
  const beforeNet = before?.[network] || {};
  const afterNet = after?.[network] || {};
  const newKeys = Object.keys(afterNet).filter((k) => !Object.prototype.hasOwnProperty.call(beforeNet, k));

  if (scriptNameHint && afterNet[scriptNameHint]) return { name: scriptNameHint, info: afterNet[scriptNameHint] };
  if (newKeys.length === 1) return { name: newKeys[0], info: afterNet[newKeys[0]] };

  const contractBase = path.basename(contractDir).toLowerCase();
  const matched = Object.keys(afterNet).find((k) => k.toLowerCase().includes(contractBase));
  if (matched) return { name: matched, info: afterNet[matched] };

  throw new Error(`Unable to identify deployed script on ${network}: ${Object.keys(afterNet).join(', ')}`);
}

function clearMigrationsIfNeeded(migrationsDir, mode) {
  if (mode !== 'latest-only') return;
  if (!fs.existsSync(migrationsDir)) return;
  for (const entry of fs.readdirSync(migrationsDir)) {
    fs.rmSync(path.join(migrationsDir, entry), { recursive: true, force: true });
  }
}

function rewriteDeploymentTomlCellPath(workspaceRoot, deploymentTomlPath, desiredBinaryPath) {
  if (!fs.existsSync(deploymentTomlPath)) return;
  const text = fs.readFileSync(deploymentTomlPath, 'utf8');
  const relative = toRootRelative(workspaceRoot, desiredBinaryPath);
  const updated = text.replace(/file\s*=\s*"[^"]+"/, `file = "${relative}"`);
  fs.writeFileSync(deploymentTomlPath, updated);
}

function writeDeploymentConfig({ cfg, network, scriptName, contractDir, scriptInfo, binaryPath }) {
  const outputDir = cfg._resolved.deploymentOutput;
  const deployDir = path.join(outputDir, network, scriptName);
  const configPath = path.join(deployDir, `${scriptName}.${network}.config.json`);
  const cellDep = scriptInfo?.cellDeps?.[0]?.cellDep || null;

  writeJson(configPath, {
    generatedAt: new Date().toISOString(),
    network,
    rpcUrl: cfg.networks[network].rpcUrl,
    deploymentOutputDir: toRootRelative(cfg._resolved.workspaceRoot, outputDir),
    contract: {
      name: path.basename(contractDir),
      sourceDir: toRootRelative(cfg._resolved.workspaceRoot, contractDir),
      deployedScriptName: scriptName,
      codeHash: scriptInfo?.codeHash,
      hashType: scriptInfo?.hashType,
      cellDep,
      txHash: cellDep?.outPoint?.txHash || null,
      binary: toRootRelative(cfg._resolved.workspaceRoot, binaryPath),
    },
    script: scriptInfo,
  });

  return configPath;
}

async function loadContractsFromServerConfig(cfg) {
  const configDir = path.dirname(cfg._resolved.configPath);
  const contractsSourceFile = String(
    cfg?.deployment?.contractsSourceFile || '../orbital.config.js',
  ).trim();
  const sourcePath = path.resolve(configDir, contractsSourceFile);
  assert(fs.existsSync(sourcePath), `Missing contracts source config: ${sourcePath}`);

  const imported = await import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);
  const serverCfg = imported.default || imported;
  const contracts = Array.isArray(serverCfg?.contracts)
    ? serverCfg.contracts
        .map((entry) => ({
          path: String(entry?.path || '').trim(),
          script: entry?.script ? String(entry.script).trim() : undefined,
          build: entry?.build === true,
          target: entry?.target ? String(entry.target).trim() : undefined,
        }))
        .filter((entry) => Boolean(entry.path))
    : [];

  assert(contracts.length > 0, `No contracts found in ${sourcePath}`);
  return {
    sourcePath,
    contracts,
  };
}

function isRbfRejectedError(errorText) {
  const text = String(errorText || '');
  return text.includes('PoolRejectedRBF') || text.includes('RBF rejected');
}

export async function buildAndDeployContracts(input = {}) {
  const cfg = loadConfig(input.configPath || undefined);
  const network = normalizeNetwork(input.network || cfg?.deployment?.network || 'devnet');
  const offckbNetwork = cfg.networks[network].offckbNetwork;
  const outputDir = cfg._resolved.deploymentOutput;
  const workspaceRoot = cfg._resolved.workspaceRoot;
  const shouldBuildAll = input.build !== undefined ? Boolean(input.build) : Boolean(cfg?.deployment?.build);
  const migrationsMode = String(cfg?.deployment?.migrationsMode || 'keep-all');
  const concurrency = Math.max(1, Number(cfg?.deployment?.concurrency || 1));

  if (network === 'devnet') {
    await ensureDevnetReady({
      configPath: input.configPath || undefined,
      network,
    });
  }

  if (network === 'mainnet' && cfg?.deployment?.allowMainnetDeploy !== true) {
    throw new Error('Mainnet deploy is disabled by config. Set deployment.allowMainnetDeploy=true to enable.');
  }

  await assertRpcReachable(network, cfg.networks[network].rpcUrl);
  const deployPrivkey = resolveDeployPrivkey(network, input.privkey);

  const { sourcePath: contractsSourcePath, contracts } = await loadContractsFromServerConfig(cfg);
  log('buildeploy', `Contracts source: ${toRootRelative(workspaceRoot, contractsSourcePath)}`);

  const results = [];
  const scriptsPath = path.join(outputDir, 'scripts.json');

  const contractPlans = contracts.map((item) => {
    const normalizedItemPath = String(item.path || '').trim().replace(/\\/g, '/');
    if (input.contractPath && normalizedItemPath !== String(input.contractPath).trim().replace(/\\/g, '/')) {
      return null;
    }
    const contractDir = resolveContractDir(workspaceRoot, item.path);
    const binName = parseBinNameFromCargoToml(contractDir);
    const scriptName = String(item.script || binName || path.basename(contractDir)).trim();
    const shouldBuild = shouldBuildAll || Boolean(item.build);
    const plannedDir = path.join(outputDir, network, scriptName);
    const plannedBinary = path.join(plannedDir, scriptName);
    const migrationsDir = path.join(plannedDir, 'migrations');
    return {
      item,
      contractDir,
      scriptName,
      shouldBuild,
      plannedBinary,
      migrationsDir,
    };
  }).filter(Boolean);

  assert(contractPlans.length > 0, `No contracts matched ${input.contractPath || 'requested scope'}.`);

  const buildPlans = contractPlans.filter((plan) => plan.shouldBuild);
  if (buildPlans.length > 0) {
    await runPool(buildPlans, concurrency, async (plan) => {
      await buildContract(cfg, network, plan.contractDir, plan.scriptName);
    });
  }

  for (const plan of contractPlans) {
    const { item, contractDir, scriptName, shouldBuild, plannedBinary, migrationsDir } = plan;
    let deployTarget = item.target
      ? path.resolve(workspaceRoot, item.target)
      : plannedBinary;

    if (!shouldBuild) {
      deployTarget = item.target
        ? path.resolve(workspaceRoot, item.target)
        : resolveExistingBinaryTarget({
            contractDir,
            scriptName,
            outputDir,
            network,
          });
      ensureFile(deployTarget, `Deploy target must be an existing binary file: ${deployTarget}`);
    }

    clearMigrationsIfNeeded(migrationsDir, migrationsMode);
    const before = loadJsonOrEmpty(scriptsPath);

    log('buildeploy', `Deploying script=${scriptName} network=${network}`);
    const deployArgs = [
      '@offckb/cli',
      'deploy',
      '--network',
      offckbNetwork,
      '--target',
      deployTarget,
      '--output',
      outputDir,
      '--privkey',
      deployPrivkey,
      '-y',
    ];
    try {
      await runCmd('npx', deployArgs, { cwd: workspaceRoot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRbfRejectedError(message)) throw error;
      log('buildeploy', 'RBF rejection detected, waiting and retrying deploy once...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await runCmd('npx', deployArgs, { cwd: workspaceRoot });
    }

    const after = loadJsonOrEmpty(scriptsPath);
    const deployed = findDeployedScript({
      before,
      after,
      network,
      scriptNameHint: scriptName,
      contractDir,
    });

    const finalName = deployed.name;
    const finalDir = path.join(outputDir, network, finalName);
    const finalBinaryPath = path.join(finalDir, finalName);
    const finalTomlPath = path.join(finalDir, 'deployment.toml');

    clearMigrationsIfNeeded(path.join(finalDir, 'migrations'), migrationsMode);

    if (deployTarget !== finalBinaryPath) {
      fs.mkdirSync(path.dirname(finalBinaryPath), { recursive: true });
      fs.copyFileSync(deployTarget, finalBinaryPath);
    }

    rewriteDeploymentTomlCellPath(workspaceRoot, finalTomlPath, finalBinaryPath);
    const generatedConfig = writeDeploymentConfig({
      cfg,
      network,
      scriptName: finalName,
      contractDir,
      scriptInfo: deployed.info,
      binaryPath: finalBinaryPath,
    });

    results.push({
      scriptName: finalName,
      contractPath: toRootRelative(workspaceRoot, contractDir),
      network,
      codeHash: deployed.info?.codeHash ?? null,
      hashType: deployed.info?.hashType ?? null,
      txHash: deployed.info?.cellDeps?.[0]?.cellDep?.outPoint?.txHash ?? null,
      deployTarget: toRootRelative(workspaceRoot, deployTarget),
      deploymentConfig: toRootRelative(workspaceRoot, generatedConfig),
    });
  }

  return {
    ok: true,
    network,
    offckbNetwork,
    concurrency,
    built: shouldBuildAll,
    contractsSource: toRootRelative(workspaceRoot, contractsSourcePath),
    results,
  };
}

export async function deployContracts(input = {}) {
  return buildAndDeployContracts({
    ...input,
    build: input.build !== undefined ? Boolean(input.build) : false,
  });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await buildAndDeployContracts(args);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[buildeploy] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
