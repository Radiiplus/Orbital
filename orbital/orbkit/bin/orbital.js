#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORBKIT_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_MOD_DIR = path.join(ORBKIT_ROOT, 'mod');
const TEMPLATE_CONFIG_PATH = path.join(TEMPLATE_MOD_DIR, 'config.json');
const TEMPLATE_GENESIS_PATH = path.join(TEMPLATE_MOD_DIR, 'genesis.json');
const TEMPLATE_ORBKIT_PACKAGE_PATH = path.join(ORBKIT_ROOT, 'package.json');

function fail(message) {
  console.error(`[orbital] Error: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[orbital] ${message}`);
}

function usage() {
  console.log(
    'Usage:\n' +
      '  orbital init <project-name> [--dir <targetDir>] [--force]\n\n' +
      '  orbital start orbital <project-name> [--dir <targetDir>] [--force]\n\n' +
      'Commands:\n' +
      '  init    Create a new Orbital workspace.\n' +
      '  start   Alias that supports "start orbital <project-name>".\n\n' +
      'Examples:\n' +
      '  orbital init my-game\n' +
      '  orbital start orbital my-game\n' +
      '  orbital init my-game --dir ./sandbox\n' +
      '  orbital init my-game --force\n',
  );
}

function sanitizeScriptName(input) {
  const raw = String(input || '').trim().toLowerCase();
  const collapsed = raw
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (!collapsed) fail('Project name must include at least one letter or number.');
  return collapsed;
}

function sanitizePackageName(input) {
  const scriptName = sanitizeScriptName(input);
  return scriptName.replace(/_/g, '-');
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }

  const [command, ...rest] = argv;
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command !== 'init' && command !== 'start') {
    fail(`Unknown command: ${command}`);
  }

  let projectName = '';
  let targetDir = process.cwd();
  let force = false;
  let argsList = rest;

  if (command === 'start' && argsList.length > 0 && String(argsList[0]).trim().toLowerCase() === 'orbital') {
    argsList = argsList.slice(1);
  }

  for (let i = 0; i < argsList.length; i += 1) {
    const arg = argsList[i];
    if (arg === '--dir') {
      targetDir = path.resolve(process.cwd(), String(argsList[++i] || '').trim());
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    }
    if (projectName) {
      fail(`Unexpected argument: ${arg}`);
    }
    projectName = arg;
  }

  if (!projectName) {
    fail('Missing required argument: <project-name>');
  }

  return {
    command,
    projectName: String(projectName).trim(),
    targetDir,
    force,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function copyFile(sourcePath, destPath) {
  ensureDir(path.dirname(destPath));
  fs.copyFileSync(sourcePath, destPath);
}

function loadTemplateConfig() {
  if (!fs.existsSync(TEMPLATE_CONFIG_PATH)) {
    fail(`Missing template config: ${TEMPLATE_CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(TEMPLATE_CONFIG_PATH, 'utf8'));
}

function loadTemplateOrbkitPackage() {
  if (!fs.existsSync(TEMPLATE_ORBKIT_PACKAGE_PATH)) {
    fail(`Missing template package: ${TEMPLATE_ORBKIT_PACKAGE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(TEMPLATE_ORBKIT_PACKAGE_PATH, 'utf8'));
}

function buildOrbitalConfigText(scriptName) {
  return (
    'export default {\n' +
    '  deployment: {\n' +
    '    network: "devnet",\n' +
    '    out: "deployment",\n' +
    '    build: true,\n' +
    '    concurrency: 2,\n' +
    '    migrations: "latest-only"\n' +
    '  },\n' +
    '  contracts: [\n' +
    '    {\n' +
    `      path: "contract/${scriptName}",\n` +
    `      script: "${scriptName}",\n` +
    '      build: true\n' +
    '    }\n' +
    '  ],\n' +
    '  rules: {\n' +
    '    unique: true\n' +
    '  }\n' +
    '};\n'
  );
}

function buildProjectEnvTemplate() {
  return (
    '# Orbital environment template\n' +
    '# Add only project-specific values here when a workflow explicitly needs them.\n\n' +
    '# Required for npm run orbkit to authenticate with the Orbital backend.\n' +
    '# Copy this from the frontend helper/API key control.\n' +
    'ORBKIT_API_KEY=\n\n' +
    '# Supabase Edge Function endpoint (built-in by default; override only for custom deployments).\n' +
    'ORBITAL_SUPABASE_FUNCTION_URL=https://eiwifodbwwingurqifjx.supabase.co/functions/v1/orbital-api\n' +
    'ORBKIT_BACKEND_MODE=firebase\n\n' +
    '# Traditional Fastify backend GraphQL endpoint. Used only when the hosted\n' +
    '# Supabase transport above is not configured.\n' +
    'ORBITAL_SERVER_GRAPHQL_URL=http://127.0.0.1:4000/graphql\n'
  );
}

function buildProjectPackageJson(projectNameInput, templateOrbkitPkg) {
  const packageName = sanitizePackageName(projectNameInput);
  const dependencyVersion =
    templateOrbkitPkg?.dependencies?.['@ckb-lumos/lumos'] || '^0.23.0';

  return {
    name: packageName,
    private: true,
    type: 'module',
    version: '0.1.0',
    scripts: {
      dev: 'npm run devnet:setup',
      'devnet:setup': 'node ./orbkit/mod/setup.js',
      orbkit: 'node ./orbkit/mod/orbkit.mjs',
      'wallet:create': 'node ./orbkit/mod/create.mjs',
      'fund:devnet': 'node ./orbkit/mod/fund.mjs',
      'balance:worker': 'node ./orbkit/mod/balance-worker.mjs',
      'funding:worker': 'node ./orbkit/mod/funding-worker.mjs',
      'build-deploy:worker': 'node ./orbkit/mod/build-deploy-worker.mjs',
      'structure:worker': 'node ./orbkit/mod/structure-worker.mjs',
      'orbkit:firebase': 'node ./orbkit/mod/orbkit.mjs',
      balance: 'node ./orbkit/mod/balance.mjs',
      'build:deploy': 'node ./orbkit/mod/buildeploy.mjs',
      'deploy:prepare': 'node ./orbkit/mod/deploy-prepare.mjs',
      'deploy:sim': 'node ./orbkit/mod/sim.mjs',
      channels: 'node ./orbkit/mod/channels.mjs',
      'graphql:ws': 'node ./orbkit/mod/graphqlws.mjs',
    },
    dependencies: {
      '@ckb-lumos/lumos': dependencyVersion,
      bip39: '^3.1.0',
      ws: '^8.18.3',
    },
  };
}

function buildProjectOrbkitConfig(templateCfg) {
  const cloned = JSON.parse(JSON.stringify(templateCfg));
  cloned.paths = {
    workspaceRoot: '../..',
    contractsRoot: '../../contract',
    deploymentOutput: '../../deployment',
  };
  cloned.deployment = {
    ...(cloned.deployment || {}),
    contractsSourceFile: '../orbital.config.js',
  };
  return cloned;
}

function buildContractCargoToml(scriptName) {
  return (
    '[package]\n' +
    `name = "${scriptName}"\n` +
    'version = "0.1.0"\n' +
    'edition = "2021"\n\n' +
    '[dependencies]\n' +
    'ckb-std = "0.15"\n\n' +
    '[[bin]]\n' +
    `name = "${scriptName}"\n` +
    'path = "src/main.rs"\n\n' +
    '[profile.release]\n' +
    'overflow-checks = true\n' +
    'opt-level = "s"\n' +
    'lto = true\n' +
    'codegen-units = 1\n' +
    'strip = true\n' +
    'panic = "abort"\n'
  );
}

function buildContractCargoConfig() {
  return (
    '[build]\n' +
    'target = "riscv64imac-unknown-none-elf"\n\n' +
    '[target.riscv64imac-unknown-none-elf]\n' +
    'linker = "rust-lld"\n\n' +
    '[env]\n' +
    'CC_riscv64imac_unknown_none_elf = "clang"\n' +
    'AR_riscv64imac_unknown_none_elf = "llvm-ar"\n' +
    'CFLAGS_riscv64imac_unknown_none_elf = "--target=riscv64-unknown-elf"\n'
  );
}

function buildContractMainRs() {
  return (
    '#![no_std]\n' +
    '#![no_main]\n\n' +
    'use ckb_std::default_alloc;\n\n' +
    'ckb_std::entry!(program_entry);\n' +
    'default_alloc!();\n\n' +
    'fn program_entry() -> i8 {\n' +
    '    0\n' +
    '}\n'
  );
}

function buildProjectReadme(projectName, scriptName) {
  return (
    `# ${projectName}\n\n` +
    'Generated by Orbital orbkit CLI.\n\n' +
    '## Requirements\n\n' +
    '- Node.js 18+\n' +
    '- On Windows: WSL2 with a Linux distribution installed\n\n' +
    '## Environment\n\n' +
    '- A default `.env` is generated for project-specific overrides when a workflow explicitly needs them\n' +
    '- Set `ORBKIT_API_KEY` in `.env`, then run `npm run orbkit` without passing `--api-key`\n' +
    '- The backend GraphQL URL defaults to the packaged Orbital endpoint and can be overridden with `ORBITAL_SERVER_GRAPHQL_URL`\n' +
    '- Orbkit manages its own transport endpoints internally\n' +
    '- Wallet signing can stay on the frontend, including devnet flows backed by passkeys\n\n' +
    '## Windows Note\n\n' +
    '- Orbital requires WSL on Windows for contract setup and build flow\n' +
    '- If WSL is unavailable, Orbital will stop with a clear error instead of partially setting up the project\n\n' +
    '## Commands\n\n' +
    '- Initialize a new workspace: `npx <package-name> init <project-name>`\n' +
    '- Alias form: `npx <package-name> start orbital <project-name>`\n' +
    '- Start and prepare devnet through Orbital: use your Orbital command from this workspace\n' +
    '- Start local dev ping/start flow: `npm run dev`\n' +
    '- Start the unified orbkit runtime and auto-prepare devnet if needed: `npm run orbkit`\n' +
    '- Create a new wallet: `npm run wallet:create`\n' +
    '- Create from mnemonic: `npm run wallet:create -- --mnemonic "<words>"`\n' +
    '- Create from private key: `npm run wallet:create -- --privkey 0x...`\n' +
    '- Use the shared channel layer: `npm run channels`\n' +
    '- Use the shared GraphQL WebSocket module: `npm run graphql:ws`\n' +
    '- Fund a devnet wallet: `npm run fund:devnet -- <walletAddress> <amountInCKB>`\n' +
    '- Check a wallet balance: `npm run balance -- <walletAddress> --network devnet`\n' +
    '- Build and deploy: `npm run build:deploy -- --network devnet --build`\n\n' +
    '## Contract\n\n' +
    `- Starter contract path: \`contract/${scriptName}/src/main.rs\`\n` +
    `- Orbital config path: \`orbkit/orbital.config.js\`\n`
  );
}

function createWorkspace(input) {
  const scriptName = sanitizeScriptName(input.projectName);
  const projectDir = path.resolve(input.targetDir, input.projectName);
  const contractDir = path.join(projectDir, 'contract', scriptName);

  if (fs.existsSync(projectDir)) {
    const entries = fs.readdirSync(projectDir);
    if (entries.length > 0 && !input.force) {
      fail(
        `Target directory already exists and is not empty: ${projectDir}. Use --force to continue.`,
      );
    }
  }

  ensureDir(projectDir);
  ensureDir(path.join(contractDir, '.cargo'));
  ensureDir(path.join(contractDir, 'src'));
  ensureDir(path.join(projectDir, 'deployment'));
  ensureDir(path.join(projectDir, 'orbkit', 'mod'));

  const templateCfg = loadTemplateConfig();
  const templateOrbkitPkg = loadTemplateOrbkitPackage();
  const projectPkg = buildProjectPackageJson(input.projectName, templateOrbkitPkg);
  const orbkitCfg = buildProjectOrbkitConfig(templateCfg);

  copyFile(path.join(TEMPLATE_MOD_DIR, 'common.mjs'), path.join(projectDir, 'orbkit', 'mod', 'common.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'create.mjs'), path.join(projectDir, 'orbkit', 'mod', 'create.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'channels.mjs'), path.join(projectDir, 'orbkit', 'mod', 'channels.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'fund.mjs'), path.join(projectDir, 'orbkit', 'mod', 'fund.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'balance-worker.mjs'), path.join(projectDir, 'orbkit', 'mod', 'balance-worker.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'funding-worker.mjs'), path.join(projectDir, 'orbkit', 'mod', 'funding-worker.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'build-deploy-worker.mjs'), path.join(projectDir, 'orbkit', 'mod', 'build-deploy-worker.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'structure-worker.mjs'), path.join(projectDir, 'orbkit', 'mod', 'structure-worker.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'structure.mjs'), path.join(projectDir, 'orbkit', 'mod', 'structure.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'deployment-receipts.mjs'), path.join(projectDir, 'orbkit', 'mod', 'deployment-receipts.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'firebase-transport.mjs'), path.join(projectDir, 'orbkit', 'mod', 'firebase-transport.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'firebase-worker.mjs'), path.join(projectDir, 'orbkit', 'mod', 'firebase-worker.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'orbkit.mjs'), path.join(projectDir, 'orbkit', 'mod', 'orbkit.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'balance.mjs'), path.join(projectDir, 'orbkit', 'mod', 'balance.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'buildeploy.mjs'), path.join(projectDir, 'orbkit', 'mod', 'buildeploy.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'deploy-prepare.mjs'), path.join(projectDir, 'orbkit', 'mod', 'deploy-prepare.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'sim.mjs'), path.join(projectDir, 'orbkit', 'mod', 'sim.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'graphqlws.mjs'), path.join(projectDir, 'orbkit', 'mod', 'graphqlws.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'serverevents.mjs'), path.join(projectDir, 'orbkit', 'mod', 'serverevents.mjs'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'setup.js'), path.join(projectDir, 'orbkit', 'mod', 'setup.js'));
  copyFile(path.join(TEMPLATE_MOD_DIR, 'README.md'), path.join(projectDir, 'orbkit', 'mod', 'README.md'));
  copyFile(TEMPLATE_GENESIS_PATH, path.join(projectDir, 'orbkit', 'mod', 'genesis.json'));

  writeJson(path.join(projectDir, 'package.json'), projectPkg);
  writeJson(path.join(projectDir, 'orbkit', 'mod', 'config.json'), orbkitCfg);
  fs.writeFileSync(
    path.join(projectDir, 'orbkit', 'orbital.config.js'),
    buildOrbitalConfigText(scriptName),
  );
  fs.writeFileSync(path.join(contractDir, 'Cargo.toml'), buildContractCargoToml(scriptName));
  fs.writeFileSync(path.join(contractDir, '.cargo', 'config.toml'), buildContractCargoConfig());
  fs.writeFileSync(path.join(contractDir, 'src', 'main.rs'), buildContractMainRs());
  fs.writeFileSync(path.join(projectDir, '.env'), buildProjectEnvTemplate());
  fs.writeFileSync(path.join(projectDir, 'README.md'), buildProjectReadme(input.projectName, scriptName));

  return {
    projectDir,
    scriptName,
  };
}

function printSuccess(result) {
  const rel = path.relative(process.cwd(), result.projectDir).replace(/\\/g, '/');
  const displayPath = rel && rel !== '' ? rel : '.';
  info(`Workspace created at ${displayPath}`);
  info(`Contract template name: ${result.scriptName}`);
  info('Next steps:');
  console.log(`  cd ${displayPath}`);
  console.log('  use your Orbital command in this workspace');
  console.log('  Orbital will handle setup and devnet startup');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'init' && args.command !== 'start') {
    fail(`Unsupported command: ${args.command}`);
  }
  const result = createWorkspace(args);
  printSuccess(result);
}

main();
