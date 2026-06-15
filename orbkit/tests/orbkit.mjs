import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as lumosConfig, helpers } from '@ckb-lumos/lumos';
import { WebSocketServer } from 'ws';
import {
  closeAllGraphqlWebSocketClients,
  buildGraphqlConnectionParams,
  getGraphqlWebSocketClient,
  subscribeGraphqlStream,
} from '../mod/graphqlws.mjs';
import {
  classifyBuildDeployMode,
  normalizeBuildDeployEvent,
  subscribeBuildDeploy,
  subscribeDevnetBalance,
  subscribeDevnetCreateWallet,
  subscribeDevnetFundWallet,
  subscribeStructure,
} from '../mod/channels.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORBKIT_ROOT = path.resolve(__dirname, '..');
const MOD_ROOT = path.join(ORBKIT_ROOT, 'mod');
const BIN_ROOT = path.join(ORBKIT_ROOT, 'bin');
const LOG_PATH = path.join(__dirname, 'orbkit.log');

const PASS = '[PASS]';
const FAIL = '[FAIL]';

const logLines = [];

function line(message) {
  const text = String(message);
  process.stdout.write(`${text}\n`);
  logLines.push(text);
}

function nowIso() {
  return new Date().toISOString();
}

function flushLog() {
  fs.writeFileSync(LOG_PATH, `${logLines.join('\n')}\n`);
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function removeDirSafe(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function extractJsonFromOutput(text) {
  const raw = String(text || '').trim();
  const starts = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '{') starts.push(i);
  }
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const candidate = raw.slice(starts[i]);
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  throw new Error(`Unable to parse JSON from output: ${raw}`);
}

function makeTestConfig({ workspaceRoot, deploymentOutput, contractsSourceFile, rpcUrl }) {
  return {
    version: 1,
    paths: {
      workspaceRoot: path.relative(path.join(workspaceRoot, 'orbkit', 'mod'), workspaceRoot).replace(/\\/g, '/'),
      contractsRoot: path.relative(path.join(workspaceRoot, 'orbkit', 'mod'), path.join(workspaceRoot, 'contract')).replace(/\\/g, '/'),
      deploymentOutput: path.relative(path.join(workspaceRoot, 'orbkit', 'mod'), deploymentOutput).replace(/\\/g, '/'),
    },
    networks: {
      devnet: {
        rpcUrl,
        indexerUrl: rpcUrl,
        offckbNetwork: 'devnet',
      },
      testnet: {
        rpcUrl,
        indexerUrl: rpcUrl,
        offckbNetwork: 'testnet',
      },
      mainnet: {
        rpcUrl,
        indexerUrl: rpcUrl,
        offckbNetwork: 'mainnet',
      },
    },
    funder: {
      network: 'devnet',
      genesisAddressesFile: './genesis.json',
      privateKeyEnv: 'FUNDER_PRIVKEY',
      defaultPrivateKey: '',
      requireKnownGenesisAddress: false,
    },
    deployment: {
      contractsSourceFile,
      rustTarget: 'riscv64imac-unknown-none-elf',
      rustTargetDir: 'target-windows',
      migrationsMode: 'latest-only',
      concurrency: 1,
      allowMainnetDeploy: true,
    },
    devnet: {
      autoStart: true,
      cleanBeforeStart: true,
      startupWaitAttempts: 3,
      startupWaitIntervalMs: 20,
    },
  };
}

function writeNpxShim(binDir, { scriptsTemplatePath, failDeployOnce = false, withDeployArtifacts = false }) {
  const npxPath = path.join(binDir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const script = process.platform === 'win32'
    ? [
        '@echo off',
        'setlocal',
        `node "${scriptsTemplatePath}" npx %*`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n')
    : [
        '#!/usr/bin/env sh',
        `node "${scriptsTemplatePath}" npx "$@"`,
        '',
      ].join('\n');
  fs.writeFileSync(npxPath, script);
  if (process.platform !== 'win32') {
    fs.chmodSync(npxPath, 0o755);
  }

  const npxRunnerPath = path.join(binDir, 'npx-shim.js');
  const runner = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const all = process.argv.slice(2).join(' ');",
    "const stateFile = process.env.TEST_STATE_FILE || '';",
    "const outputDir = process.env.TEST_DEPLOYMENT_OUTPUT || '';",
    `const failDeployOnce = ${failDeployOnce ? 'true' : 'false'};`,
    `const withDeployArtifacts = ${withDeployArtifacts ? 'true' : 'false'};`,
    'let state = {};',
    'if (stateFile && fs.existsSync(stateFile)) {',
    "  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));",
    '}',
    'if (all.includes("@offckb/cli transfer")) {',
    "  console.log('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');",
    '  process.exit(0);',
    '}',
    'if (all.includes("@offckb/cli balance")) {',
    "  console.log('mock balance output');",
    '  process.exit(0);',
    '}',
    'if (all.includes("@offckb/cli clean")) {',
    "  console.log('clean ok');",
    '  process.exit(0);',
    '}',
    'if (all.includes("@offckb/cli node")) {',
    "  console.log('node started');",
    '  process.exit(0);',
    '}',
    'if (all.includes("@offckb/cli deploy")) {',
    '  const attempts = Number(state.deployAttempts || 0) + 1;',
    '  state.deployAttempts = attempts;',
    '  if (failDeployOnce && attempts === 1) {',
    "    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));",
    "    console.error('PoolRejectedRBF: simulated');",
    '    process.exit(1);',
    '  }',
    '  if (withDeployArtifacts) {',
    '    const netMatch = all.match(/--network\\s+([^\\s]+)/);',
    "    const network = netMatch ? netMatch[1] : 'devnet';",
    '    const targetMatch = all.match(/--target\\s+([^\\s]+)/);',
    "    const targetPath = targetMatch ? targetMatch[1] : '';",
    "    const scriptName = path.basename(targetPath || 'script').trim() || 'script';",
    '    const scriptsPath = path.join(outputDir, "scripts.json");',
    '    fs.mkdirSync(outputDir, { recursive: true });',
    '    let scripts = {};',
    '    if (fs.existsSync(scriptsPath)) {',
    "      scripts = JSON.parse(fs.readFileSync(scriptsPath, 'utf8'));",
    '    }',
    '    if (!scripts[network]) scripts[network] = {};',
    '    scripts[network][scriptName] = {',
    "      codeHash: '0x' + '12'.repeat(32),",
    "      hashType: 'type',",
    '      cellDeps: [{',
    '        cellDep: {',
    '          outPoint: {',
    "            txHash: '0x' + '34'.repeat(32),",
    "            index: '0x0',",
    '          },',
    "          depType: 'code',",
    '        },',
    '      }],',
    '    };',
    "    fs.writeFileSync(scriptsPath, JSON.stringify(scripts, null, 2));",
    '    const scriptDir = path.join(outputDir, network, scriptName);',
    '    fs.mkdirSync(scriptDir, { recursive: true });',
    '    fs.writeFileSync(path.join(scriptDir, "deployment.toml"), `file = "placeholder"`);',
    '  }',
    "  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));",
    "  console.log('deploy via npx shim');",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(npxRunnerPath, runner);
}

async function runCli(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, ...(options.env || {}) };
  line(`[cli] ${command} ${args.join(' ')} cwd=${cwd}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function prependPath(dirPath, existingPath = process.env.PATH || '') {
  return [dirPath, existingPath].filter(Boolean).join(path.delimiter);
}

function startRpcServer() {
  const state = { tipCalls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }

      if (body.method === 'get_tip_block_number') {
        state.tipCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: '0x10' }));
        return;
      }

      if (body.method === 'get_cells') {
        const cursor = body.params?.[3];
        let result;
        if (!cursor) {
          result = {
            objects: [
              {
                output: { capacity: '0x174876e800' },
                output_data: '0x',
              },
              {
                output: { capacity: '0x174876e800' },
                output_data: '0x1234',
              },
            ],
            last_cursor: 'cursor-1',
          };
        } else {
          result = {
            objects: [
              {
                output: { capacity: '0x174876e800' },
                output_data: '0x',
              },
            ],
            last_cursor: '',
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        state,
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function startGraphqlWsTestServer(options = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    path: '/graphql',
  });
  const state = {
    connections: 0,
    subscriptions: 0,
    authHeaders: [],
  };

  wss.on('connection', (socket) => {
    state.connections += 1;
    let authorized = !options.requiredBearerToken;
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'connection_init') {
        const authHeader = message?.payload?.headers?.authorization || '';
        state.authHeaders.push(authHeader);
        if (options.requiredBearerToken) {
          authorized = authHeader === `Bearer ${options.requiredBearerToken}`;
          if (!authorized) {
            socket.send(JSON.stringify({
              type: 'error',
              payload: {
                message: 'Unauthorized',
              },
            }));
            socket.close(4401, 'Unauthorized');
            return;
          }
        }
        socket.send(JSON.stringify({ type: 'connection_ack' }));
        return;
      }
      if (message.type === 'subscribe') {
        if (!authorized) return;
        state.subscriptions += 1;
        const query = String(message?.payload?.query || '');
        const variables = message?.payload?.variables || {};
        let payload;
        if (query.includes('devnetBalance')) {
          payload = {
            data: {
              devnetBalance: {
                address: variables.address,
                balanceShannons: '4200000000',
                balanceCkb: '42',
                updatedAt: nowIso(),
              },
            },
          };
        } else if (query.includes('devnetFundWallet')) {
          payload = {
            data: {
              devnetFundWallet: {
                requestId: 'fund-req-1',
                status: 'broadcasted',
                txHash: `0x${'ab'.repeat(32)}`,
                error: null,
                updatedAt: nowIso(),
              },
            },
          };
        } else if (query.includes('devnetCreateWallet')) {
          payload = {
            data: {
              devnetCreateWallet: {
                address: makeAddress('devnet'),
                lockArg: `0x${'11'.repeat(20)}`,
                publicKey: `0x${'22'.repeat(33)}`,
                privateKey: null,
                mnemonic: null,
                network: 'devnet',
              },
            },
          };
        } else if (query.includes('buildRequest')) {
          payload = {
            data: {
              buildRequest: {
                requestId: 'build-req-1',
                action: variables.action,
                network: variables.network,
                status: 'ready',
                contractPath: variables.contractPath,
                tx: variables.network === 'devnet' ? `0x${'cd'.repeat(32)}` : null,
                unsignedTx: variables.network === 'devnet' ? null : { witnesses: [] },
                updatedAt: nowIso(),
              },
            },
          };
        } else {
          payload = {
            data: {
              streamEvent: {
                tick: state.subscriptions,
              },
            },
          };
        }
        socket.send(JSON.stringify({
          id: message.id,
          type: 'next',
          payload,
        }));
        socket.send(JSON.stringify({
          id: message.id,
          type: 'complete',
        }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        wss,
        state,
        wsUrl: `ws://127.0.0.1:${addr.port}/graphql`,
      });
    });
  });
}

function makeAddress(network) {
  const cfg = network === 'mainnet'
    ? lumosConfig.predefined.LINA
    : lumosConfig.predefined.AGGRON4;
  return helpers.encodeToAddress(
    {
      codeHash: cfg.SCRIPTS.SECP256K1_BLAKE160.CODE_HASH,
      hashType: cfg.SCRIPTS.SECP256K1_BLAKE160.HASH_TYPE,
      args: `0x${'11'.repeat(20)}`,
    },
    { config: cfg },
  );
}

async function testCliScaffold() {
  const tmp = mkTmp('orbkit-cli-');
  line(`[test] temp dir created: ${tmp}`);
  try {
    const res = await runCli(
      process.execPath,
      [path.join(BIN_ROOT, 'orbital.js'), 'init', 'my-proj', '--dir', tmp],
      { cwd: ORBKIT_ROOT },
    );
    assert.equal(res.code, 0, `init command failed: ${res.stderr}`);

    const root = path.join(tmp, 'my-proj');
    const contractRoot = path.join(root, 'contract', 'my-proj');
    assert.equal(fs.existsSync(path.join(root, 'orbkit', 'orbital.config.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'orbkit', 'mod', 'fund.mjs')), true);
    assert.equal(fs.existsSync(path.join(root, 'orbkit', 'mod', 'balance-worker.mjs')), true);
    assert.equal(fs.existsSync(path.join(root, 'orbkit', 'mod', 'serverevents.mjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.env')), true);
    assert.equal(fs.existsSync(contractRoot), true);
    assert.equal(fs.existsSync(path.join(contractRoot, 'Cargo.toml')), true);
    assert.equal(fs.existsSync(path.join(contractRoot, '.cargo', 'config.toml')), true);
    assert.equal(fs.existsSync(path.join(contractRoot, 'src', 'main.rs')), true);

    const confText = fs.readFileSync(path.join(root, 'orbkit', 'orbital.config.js'), 'utf8');
    const cargoText = fs.readFileSync(path.join(contractRoot, 'Cargo.toml'), 'utf8');
    const rustText = fs.readFileSync(path.join(contractRoot, 'src', 'main.rs'), 'utf8');
    const readmeText = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(confText, /path: "contract\/my-proj"/);
    assert.match(confText, /script: "my-proj"/);
    assert.match(cargoText, /name = "my-proj"/);
    assert.match(rustText, /fn program_entry\(\) -> i8/);
    assert.doesNotMatch(rustText, /first script arg must be 0x2a/);
    assert.match(readmeText, /## Requirements/);
    assert.match(readmeText, /## Environment/);
    assert.match(readmeText, /## Commands/);
    assert.match(readmeText, /Orbital requires WSL on Windows/);
    assert.match(readmeText, /npx <package-name> init <project-name>/);
    assert.match(readmeText, /npm run dev/);
    assert.match(readmeText, /npm run orbkit/);
    assert.match(readmeText, /npm run channels/);
    assert.match(readmeText, /npm run wallet:create/);
    assert.match(readmeText, /npm run graphql:ws/);
    assert.match(readmeText, /Orbkit manages its own transport endpoints internally/);
    assert.match(readmeText, /Wallet signing can stay on the frontend/);
    assert.doesNotMatch(readmeText, /npm install/);
    assert.doesNotMatch(readmeText, /npx @offckb\/cli node/);
    assert.doesNotMatch(readmeText, /## What This Workspace Includes/);
    assert.match(envText, /# Orbital environment template/);
    assert.doesNotMatch(envText, /ORBITAL_GRAPHQL_URL=/);
    assert.doesNotMatch(envText, /ORBITAL_GRAPHQL_WS_URL=/);
    assert.doesNotMatch(envText, /FUNDER_PRIVKEY=/);
    assert.doesNotMatch(envText, /CKB_PRIVATE_KEY=/);
    assert.doesNotMatch(envText, /DEPLOYER_PRIVKEY=/);
    assert.equal(pkg.scripts.dev, 'npm run devnet:setup');
    assert.equal(pkg.scripts['devnet:setup'], 'node ./orbkit/mod/setup.js');
    assert.equal(pkg.scripts.orbkit, 'node ./orbkit/mod/orbkit.mjs');
    assert.equal(pkg.scripts['balance:worker'], 'node ./orbkit/mod/balance-worker.mjs');
  } finally {
    removeDirSafe(tmp);
  }
}

async function testCliAliasScaffold() {
  const tmp = mkTmp('orbkit-cli-alias-');
  line(`[test] temp dir created: ${tmp}`);
  try {
    const res = await runCli(
      process.execPath,
      [path.join(BIN_ROOT, 'orbital.js'), 'start', 'orbital', 'alias-proj', '--dir', tmp],
      { cwd: ORBKIT_ROOT },
    );
    assert.equal(res.code, 0, `start alias failed: ${res.stderr}`);
    const confPath = path.join(tmp, 'alias-proj', 'orbkit', 'orbital.config.js');
    assert.equal(fs.existsSync(confPath), true);
  } finally {
    removeDirSafe(tmp);
  }
}

async function testCreateWalletModule() {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const privateKey = `0x${'11'.repeat(32)}`;

  const generatedRes = await runCli(
    process.execPath,
    [path.join(MOD_ROOT, 'create.mjs')],
    { cwd: ORBKIT_ROOT },
  );
  assert.equal(generatedRes.code, 0, `create generated wallet failed: ${generatedRes.stderr}`);
  const generated = extractJsonFromOutput(generatedRes.stdout);
  assert.equal(generated.ok, true);
  assert.equal(generated.source, 'generated');
  assert.match(generated.address, /^ckt1/i);
  assert.match(generated.addresses.devnet, /^ckt1/i);
  assert.match(generated.addresses.testnet, /^ckt1/i);
  assert.match(generated.addresses.mainnet, /^ckb1/i);
  assert.match(generated.privateKey, /^0x[a-f0-9]{64}$/i);
  assert.equal(typeof generated.mnemonic, 'string');

  const mnemonicRes = await runCli(
    process.execPath,
    [path.join(MOD_ROOT, 'create.mjs'), '--mnemonic', mnemonic],
    { cwd: ORBKIT_ROOT },
  );
  assert.equal(mnemonicRes.code, 0, `create mnemonic wallet failed: ${mnemonicRes.stderr}`);
  const mnemonicOut = extractJsonFromOutput(mnemonicRes.stdout);
  assert.equal(mnemonicOut.ok, true);
  assert.equal(mnemonicOut.source, 'mnemonic');
  assert.equal(mnemonicOut.mnemonic, mnemonic);
  assert.match(mnemonicOut.privateKey, /^0x[a-f0-9]{64}$/i);
  assert.match(mnemonicOut.address, /^ckt1/i);
  assert.match(mnemonicOut.addresses.devnet, /^ckt1/i);
  assert.match(mnemonicOut.addresses.testnet, /^ckt1/i);
  assert.match(mnemonicOut.addresses.mainnet, /^ckb1/i);

  const privkeyRes = await runCli(
    process.execPath,
    [path.join(MOD_ROOT, 'create.mjs'), '--privkey', privateKey],
    { cwd: ORBKIT_ROOT },
  );
  assert.equal(privkeyRes.code, 0, `create private-key wallet failed: ${privkeyRes.stderr}`);
  const privkeyOut = extractJsonFromOutput(privkeyRes.stdout);
  assert.equal(privkeyOut.ok, true);
  assert.equal(privkeyOut.source, 'private-key');
  assert.equal(privkeyOut.privateKey, privateKey);
  assert.match(privkeyOut.address, /^ckt1/i);
  assert.match(privkeyOut.addresses.devnet, /^ckt1/i);
  assert.match(privkeyOut.addresses.testnet, /^ckt1/i);
  assert.match(privkeyOut.addresses.mainnet, /^ckb1/i);
}

async function testGraphqlWsModule() {
  const wsServer = await startGraphqlWsTestServer();
  const received = [];
  try {
    const client = getGraphqlWebSocketClient({
      wsUrl: wsServer.wsUrl,
      lazyDisconnectMs: 100,
    });

    const sub1 = await subscribeGraphqlStream({
      wsUrl: wsServer.wsUrl,
      query: 'subscription StreamOne { streamEvent { tick } }',
      onNext: (payload) => received.push(payload?.data?.streamEvent?.tick ?? null),
    });
    await sub1.completed;

    const sub2 = await subscribeGraphqlStream({
      wsUrl: wsServer.wsUrl,
      query: 'subscription StreamTwo { streamEvent { tick } }',
      onNext: (payload) => received.push(payload?.data?.streamEvent?.tick ?? null),
    });
    await sub2.completed;

    assert.equal(client, getGraphqlWebSocketClient({ wsUrl: wsServer.wsUrl }), 'client should be reused for the same URL');
    assert.deepEqual(received, [1, 2]);
    assert.equal(wsServer.state.connections, 1, 'should use a single persistent websocket connection');
    assert.equal(wsServer.state.subscriptions, 2, 'should stream multiple subscriptions through the same connection');
  } finally {
    closeAllGraphqlWebSocketClients();
    wsServer.wss.close();
    await closeServer(wsServer.server);
  }
}

async function testGraphqlWsAuthAndChannels() {
  const wsServer = await startGraphqlWsTestServer({
    requiredBearerToken: 'orbital-secret',
  });
  try {
    const params = buildGraphqlConnectionParams({
      authToken: 'orbital-secret',
      connectionParams: {
        client: 'orbkit-test',
      },
    });
    assert.equal(params.headers.authorization, 'Bearer orbital-secret');
    assert.equal(params.client, 'orbkit-test');

    const events = {
      balance: null,
      fund: null,
      wallet: null,
      deployDevnet: null,
      deployMainnet: null,
    };

    const balanceSub = await subscribeDevnetBalance({
      wsUrl: wsServer.wsUrl,
      authToken: 'orbital-secret',
      address: makeAddress('devnet'),
      onNext: (payload) => {
        events.balance = payload?.data?.devnetBalance || null;
      },
    });
    await balanceSub.completed;

    const fundSub = await subscribeDevnetFundWallet({
      wsUrl: wsServer.wsUrl,
      authToken: 'orbital-secret',
      address: makeAddress('devnet'),
      amountCkb: 42,
      onNext: (payload) => {
        events.fund = payload?.data?.devnetFundWallet || null;
      },
    });
    await fundSub.completed;

    const walletSub = await subscribeDevnetCreateWallet({
      wsUrl: wsServer.wsUrl,
      authToken: 'orbital-secret',
      onNext: (payload) => {
        events.wallet = payload?.data?.devnetCreateWallet || null;
      },
    });
    await walletSub.completed;

    const deployDevnetSub = await subscribeBuildDeploy({
      wsUrl: wsServer.wsUrl,
      authToken: 'orbital-secret',
      network: 'devnet',
      contractPath: 'contract/demo',
      action: 'deploy',
      onNext: (payload) => {
        events.deployDevnet = payload;
      },
    });
    await deployDevnetSub.completed;

    const deployMainnetSub = await subscribeBuildDeploy({
      wsUrl: wsServer.wsUrl,
      authToken: 'orbital-secret',
      network: 'mainnet',
      contractPath: 'contract/demo',
      action: 'deploy',
      onNext: (payload) => {
        events.deployMainnet = payload;
      },
    });
    await deployMainnetSub.completed;

    assert.equal(wsServer.state.authHeaders[0], 'Bearer orbital-secret');
    assert.equal(events.balance.address.startsWith('ckt1'), true);
    assert.equal(events.balance.balanceCkb, '42');
    assert.equal(events.fund.status, 'broadcasted');
    assert.equal(events.wallet.network, 'devnet');
    assert.equal(events.wallet.privateKey, null);
    assert.equal(events.wallet.mnemonic, null);
    assert.equal(events.deployDevnet.mode, 'devnet-local-sign-and-broadcast');
    assert.equal(events.deployDevnet.shouldOrbkitBroadcast, true);
    assert.match(events.deployDevnet.tx, /^0x[a-f0-9]{64}$/i);
    assert.equal(events.deployMainnet.mode, 'remote-build-return-tx');
    assert.equal(events.deployMainnet.shouldServerHandleSigning, true);
    assert.deepEqual(events.deployMainnet.unsignedTx, { witnesses: [] });
  } finally {
    closeAllGraphqlWebSocketClients();
    wsServer.wss.close();
    await closeServer(wsServer.server);
  }
}

async function testChannelModule() {
  assert.equal(classifyBuildDeployMode('devnet', 'build'), 'devnet-local-build');
  assert.equal(classifyBuildDeployMode('devnet', 'deploy'), 'devnet-local-sign-and-broadcast');
  assert.equal(classifyBuildDeployMode('testnet', 'build'), 'remote-build-return-result');
  assert.equal(classifyBuildDeployMode('testnet', 'deploy'), 'remote-build-return-tx');
  assert.equal(classifyBuildDeployMode('mainnet', 'deploy'), 'remote-build-return-tx');

  const normalized = normalizeBuildDeployEvent({
    data: {
      buildRequest: {
        requestId: 'req-1',
        action: 'deploy',
        network: 'devnet',
        contractPath: 'contract/demo',
      },
    },
  });
  assert.equal(normalized.mode, 'devnet-local-sign-and-broadcast');
  assert.equal(normalized.shouldOrbkitBroadcast, true);
  assert.equal(normalized.shouldServerHandleSigning, false);

  const tmp = mkTmp('orbkit-channel-structure-');
  line(`[test] temp dir created: ${tmp}`);
  try {
    const workspace = path.join(tmp, 'workspace');
    const modDir = path.join(workspace, 'orbkit', 'mod');
    const contractDir = path.join(workspace, 'contract', 'demo', 'src');
    fs.mkdirSync(modDir, { recursive: true });
    fs.mkdirSync(contractDir, { recursive: true });

    const cfg = makeTestConfig({
      workspaceRoot: workspace,
      deploymentOutput: path.join(workspace, 'deployment'),
      contractsSourceFile: '../orbital.config.js',
      rpcUrl: 'http://127.0.0.1:8114',
    });
    writeJson(path.join(modDir, 'config.json'), cfg);
    fs.writeFileSync(path.join(workspace, 'contract', 'demo', 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(contractDir, 'main.rs'), 'fn main() {}\n');

    let payload = null;
    const sub = await subscribeStructure({
      contractPath: 'contract/demo',
      configPath: path.join(modDir, 'config.json'),
      onNext: (value) => {
        payload = value;
      },
    });
    await sub.completed;
    assert.equal(payload?.data?.structure?.ok, true);
    assert.equal(payload?.data?.structure?.contractPath, 'contract/demo');
  } finally {
    removeDirSafe(tmp);
  }
}

async function testServerTodoDoc() {
  const todoPath = path.join(ORBKIT_ROOT, 'SERVER_TODO.md');
  assert.equal(fs.existsSync(todoPath), true);
  const text = fs.readFileSync(todoPath, 'utf8');
  assert.match(text, /## Authentication/);
  assert.match(text, /Bearer <api-key>/);
  assert.match(text, /devnetBalance/);
  assert.match(text, /buildRequest/);
}

async function testSetupFlow() {
  const tmp = mkTmp('orbkit-setup-');
  line(`[test] temp dir created: ${tmp}`);
  const rpc = await startRpcServer();
  try {
    line(`[rpc] started: ${rpc.url}`);
    const workspace = path.join(tmp, 'workspace');
    const modDir = path.join(workspace, 'orbkit', 'mod');
    fs.mkdirSync(modDir, { recursive: true });

    const cfg = makeTestConfig({
      workspaceRoot: workspace,
      deploymentOutput: path.join(workspace, 'deployment'),
      contractsSourceFile: '../orbital.config.js',
      rpcUrl: rpc.url,
    });
    writeJson(path.join(modDir, 'config.json'), cfg);
    writeJson(path.join(modDir, 'genesis.json'), []);

    const res = await runCli(
      process.execPath,
      [path.join(MOD_ROOT, 'setup.js'), '--config', path.join(modDir, 'config.json'), '--network', 'devnet'],
      { cwd: workspace },
    );
    assert.equal(res.code, 0, `setup failed: ${res.stderr}`);
    const out = extractJsonFromOutput(res.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.network, 'devnet');
  } finally {
    await closeServer(rpc.server);
    removeDirSafe(tmp);
  }
}

async function testSetupFailsWithoutWslOnWindows() {
  if (process.platform !== 'win32') {
    line('[test] skipping Windows-only WSL guard test on non-Windows host');
    return;
  }

  const tmp = mkTmp('orbkit-setup-wsl-');
  line(`[test] temp dir created: ${tmp}`);
  const rpc = await startRpcServer();
  try {
    line(`[rpc] started: ${rpc.url}`);
    const workspace = path.join(tmp, 'workspace');
    const modDir = path.join(workspace, 'orbkit', 'mod');
    fs.mkdirSync(modDir, { recursive: true });

    const cfg = makeTestConfig({
      workspaceRoot: workspace,
      deploymentOutput: path.join(workspace, 'deployment'),
      contractsSourceFile: '../orbital.config.js',
      rpcUrl: 'http://127.0.0.1:1',
    });
    writeJson(path.join(modDir, 'config.json'), cfg);
    writeJson(path.join(modDir, 'genesis.json'), []);

    const res = await runCli(
      process.execPath,
      [path.join(MOD_ROOT, 'setup.js'), '--config', path.join(modDir, 'config.json'), '--network', 'devnet'],
      {
        cwd: workspace,
        env: {
          ORBKIT_FORCE_WSL_UNAVAILABLE: '1',
        },
      },
    );
    assert.equal(res.code, 1, 'setup should fail when WSL is unavailable on Windows');
    assert.match(res.stderr, /Devnet setup requires WSL on Windows/);
  } finally {
    await closeServer(rpc.server);
    removeDirSafe(tmp);
  }
}

async function testFundFlow() {
  const tmp = mkTmp('orbkit-fund-');
  line(`[test] temp dir created: ${tmp}`);
  const rpc = await startRpcServer();
  try {
    line(`[rpc] started: ${rpc.url}`);
    const workspace = path.join(tmp, 'workspace');
    const modDir = path.join(workspace, 'orbkit', 'mod');
    fs.mkdirSync(modDir, { recursive: true });
    const fakeBin = path.join(tmp, 'fakebin');
    fs.mkdirSync(fakeBin, { recursive: true });

    const cfg = makeTestConfig({
      workspaceRoot: workspace,
      deploymentOutput: path.join(workspace, 'deployment'),
      contractsSourceFile: '../orbital.config.js',
      rpcUrl: rpc.url,
    });
    cfg.funder.defaultPrivateKey = `0x${'22'.repeat(32)}`;
    writeJson(path.join(modDir, 'config.json'), cfg);
    writeJson(path.join(modDir, 'genesis.json'), ['ckt1test']);

    writeNpxShim(fakeBin, { scriptsTemplatePath: path.join(fakeBin, 'npx-shim.js') });

    const wallet = makeAddress('devnet');
    const res = await runCli(
      process.execPath,
      [path.join(MOD_ROOT, 'fund.mjs'), wallet, '62', '--config', path.join(modDir, 'config.json')],
      {
        cwd: workspace,
        env: {
          PATH: prependPath(fakeBin),
        },
      },
    );
    assert.equal(res.code, 0, `fund failed: ${res.stderr}`);
    const out = extractJsonFromOutput(res.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.network, 'devnet');
    assert.equal(out.walletAddress, wallet);
    assert.match(out.txHash, /^0x[a-f0-9]{64}$/i);
  } finally {
    await closeServer(rpc.server);
    removeDirSafe(tmp);
  }
}

async function testBalanceFlow() {
  const tmp = mkTmp('orbkit-balance-');
  line(`[test] temp dir created: ${tmp}`);
  const rpc = await startRpcServer();
  try {
    line(`[rpc] started: ${rpc.url}`);
    const workspace = path.join(tmp, 'workspace');
    const modDir = path.join(workspace, 'orbkit', 'mod');
    fs.mkdirSync(modDir, { recursive: true });

    const cfg = makeTestConfig({
      workspaceRoot: workspace,
      deploymentOutput: path.join(workspace, 'deployment'),
      contractsSourceFile: '../orbital.config.js',
      rpcUrl: rpc.url,
    });
    writeJson(path.join(modDir, 'config.json'), cfg);

    const wallet = makeAddress('devnet');
    const res = await runCli(
      process.execPath,
      [
        path.join(MOD_ROOT, 'balance.mjs'),
        wallet,
        '--config',
        path.join(modDir, 'config.json'),
        '--network',
        'devnet',
        '--scan-mode',
        'full',
        '--page-limit',
        '2',
      ],
      { cwd: workspace },
    );
    assert.equal(res.code, 0, `balance failed: ${res.stderr}`);
    const out = extractJsonFromOutput(res.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.network, 'devnet');
    assert.equal(out.totalCellCount, 3);
    assert.equal(out.emptyCellCount, 2);
    assert.equal(out.dataCellCount, 1);
  } finally {
    await closeServer(rpc.server);
    removeDirSafe(tmp);
  }
}

async function testDeployFlowWithRetry() {
  const tmp = mkTmp('orbkit-deploy-');
  line(`[test] temp dir created: ${tmp}`);
  const rpc = await startRpcServer();
  try {
    line(`[rpc] started: ${rpc.url}`);
    const workspace = path.join(tmp, 'workspace');
    const orbkitDir = path.join(workspace, 'orbkit');
    const modDir = path.join(orbkitDir, 'mod');
    const contractDir = path.join(workspace, 'contract', 'demo');
    const deployOut = path.join(workspace, 'deployment');
    const fakeBin = path.join(tmp, 'fakebin');
    const stateFile = path.join(tmp, 'state.json');

    fs.mkdirSync(modDir, { recursive: true });
    fs.mkdirSync(contractDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });

    fs.writeFileSync(
      path.join(contractDir, 'Cargo.toml'),
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    fs.mkdirSync(path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release'), { recursive: true });
    fs.writeFileSync(
      path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release', 'demo'),
      'binary',
    );

    const cfg = makeTestConfig({
      workspaceRoot: workspace,
      deploymentOutput: deployOut,
      contractsSourceFile: '../orbital.config.js',
      rpcUrl: rpc.url,
    });
    cfg.deployment.build = false;
    cfg.deployment.concurrency = 1;
    cfg.deployment.migrationsMode = 'latest-only';
    writeJson(path.join(modDir, 'config.json'), cfg);

    fs.mkdirSync(path.join(orbkitDir), { recursive: true });
    fs.writeFileSync(
      path.join(orbkitDir, 'orbital.config.js'),
      'export default { contracts: [{ path: "contract/demo", script: "demo", build: false }] };',
    );

    writeNpxShim(fakeBin, {
      scriptsTemplatePath: path.join(fakeBin, 'npx-shim.js'),
      failDeployOnce: true,
      withDeployArtifacts: true,
    });

    const res = await runCli(
      process.execPath,
      [path.join(MOD_ROOT, 'buildeploy.mjs'), '--config', path.join(modDir, 'config.json'), '--network', 'devnet', '--no-build'],
      {
        cwd: workspace,
        env: {
          PATH: prependPath(fakeBin),
          TEST_STATE_FILE: stateFile,
          TEST_DEPLOYMENT_OUTPUT: deployOut,
          CKB_PRIVATE_KEY: `0x${'44'.repeat(32)}`,
        },
      },
    );
    assert.equal(res.code, 0, `buildeploy failed: ${res.stderr}`);
    const out = extractJsonFromOutput(res.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].scriptName, 'demo');

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.deployAttempts, 2, 'deploy should retry exactly once after RBF rejection');

    const generatedConfig = path.join(deployOut, 'devnet', 'demo', 'demo.devnet.config.json');
    assert.equal(fs.existsSync(generatedConfig), true);
  } finally {
    await closeServer(rpc.server);
    removeDirSafe(tmp);
  }
}

async function testContractStructureAnalysis() {
  const tmp = mkTmp('orbkit-structure-');
  line(`[test] temp dir created: ${tmp}`);
  try {
    const workspace = path.join(tmp, 'workspace');
    const orbkitDir = path.join(workspace, 'orbkit');
    const modDir = path.join(orbkitDir, 'mod');
    const contractDir = path.join(workspace, 'contract', 'demo');

    fs.mkdirSync(modDir, { recursive: true });
    fs.mkdirSync(path.join(contractDir, 'src', 'nested'), { recursive: true });

    const cfg = makeTestConfig({
      workspaceRoot: workspace,
      deploymentOutput: path.join(workspace, 'deployment'),
      contractsSourceFile: '../orbital.config.js',
      rpcUrl: 'http://127.0.0.1:8114',
    });
    writeJson(path.join(modDir, 'config.json'), cfg);
    writeJson(path.join(modDir, 'genesis.json'), []);

    fs.writeFileSync(
      path.join(contractDir, 'Cargo.toml'),
      [
        '[package]',
        'name = "demo"',
        'version = "0.1.0"',
        '',
        '[dependencies]',
        'ckb-std = "0.15"',
        'serde = "1"',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(contractDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          lodash: '^1.0.0',
        },
      }, null, 2),
    );

    fs.writeFileSync(
      path.join(contractDir, 'src', 'main.rs'),
      [
        'mod helpers;',
        'mod nested;',
        '',
        'use ckb_std::ckb_constants::Source;',
        'use ckb_std::high_level::{load_cell_data, load_witness};',
        'use crate::helpers::shared_check;',
        'use crate::nested::verify_extra;',
        '',
        'ckb_std::entry!(program_entry);',
        '',
        'const ERROR_ARGS: i8 = 5;',
        '',
        'pub fn program_entry() -> i8 {',
        '    let script = 1;',
        '    let args = [script];',
        '    if args[0] != 1 {',
        '        return Err(ERROR_ARGS).unwrap_err();',
        '    }',
        '    let _ = load_witness(0, Source::Input);',
        '    let _ = load_cell_data(0, Source::Output);',
        '    shared_check();',
        '    verify_extra();',
        '    0',
        '}',
        '',
        'fn duplicate_logic() {',
        '}',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(contractDir, 'src', 'helpers.rs'),
      [
        'pub fn shared_check() {',
        '}',
        '',
        'fn duplicate_logic() {',
        '}',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(contractDir, 'src', 'nested', 'mod.rs'),
      [
        'pub fn verify_extra() {',
        '}',
        '',
      ].join('\n'),
    );

    const res = await runCli(
      process.execPath,
      [path.join(MOD_ROOT, 'structure.mjs'), 'contract/demo', '--config', path.join(modDir, 'config.json')],
      { cwd: workspace },
    );

    assert.equal(res.code, 0, `structure failed: ${res.stderr}`);
    const out = extractJsonFromOutput(res.stdout);

    assert.equal(out.ok, true);
    assert.equal(out.contractPath, 'contract/demo');
    assert.equal(out.manifest.packageName, 'demo');
    assert.equal(out.manifest.binaryName, 'demo');
    assert.equal(out.manifest.role, 'ckb-script');
    assert.deepEqual(out.manifest.dependencies, ['ckb-std', 'serde']);
    assert.equal(out.stats.fileCount, 5);
    assert.equal(out.stats.sourceFileCount, 3);
    assert.equal(out.stats.rustFileCount, 3);
    assert.equal(out.stats.codeLines, 28);
    assert.equal(out.stats.functions, 5);
    assert.equal(out.stats.deps, 4);
    assert.equal(out.stats.entrypointCount, 1);
    assert.equal(out.stats.sharedFunctionGroups, 1);
    assert.equal(out.stats.behaviorCounts['type-like'], 1);
    assert.equal(out.stats.behaviorCounts['mixed-or-unknown'], 2);
    assert.deepEqual(out.entrypointFiles, ['contract/demo/src/main.rs']);

    assert.deepEqual(out.sharedFunctions, [
      {
        name: 'duplicate_logic',
        files: [
          'contract/demo/src/helpers.rs',
          'contract/demo/src/main.rs',
        ],
      },
    ]);

    const mainMetrics = out.perFile['contract/demo/src/main.rs'];
    assert.equal(mainMetrics.lines, 22);
    assert.equal(mainMetrics.functions, 2);
    assert.equal(mainMetrics.analysis.behaviorClassification, 'type-like');
    assert.equal(typeof mainMetrics.analysis.vmApiCatalogCount, 'number');
    assert.deepEqual(mainMetrics.imports, [
      'ckb_std::ckb_constants::Source',
      'ckb_std::high_level',
      'contract/demo/src/helpers.rs',
      'contract/demo/src/nested/mod.rs',
    ]);
    assert.deepEqual(mainMetrics.relatedFiles, [
      'contract/demo/src/helpers.rs',
      'contract/demo/src/nested/mod.rs',
    ]);
    assert.deepEqual(mainMetrics.sharedFunctionNames, ['duplicate_logic']);
    assert.deepEqual(mainMetrics.sharedFunctionalityWith, ['contract/demo/src/helpers.rs']);
    assert.deepEqual(mainMetrics.analysis.features, [
      'entrypoint-validation',
      'script-args-validation',
      'custom-error-codes',
      'ckb-vm-syscalls',
      'input-state-checks',
      'output-state-checks',
      'cell-data-checks',
      'witness-access',
    ]);

    const helperMetrics = out.perFile['contract/demo/src/helpers.rs'];
    assert.equal(helperMetrics.lines, 4);
    assert.equal(helperMetrics.functions, 2);
    assert.deepEqual(helperMetrics.importedBy, ['contract/demo/src/main.rs']);
    assert.deepEqual(helperMetrics.sharedFunctionNames, ['duplicate_logic']);
    assert.deepEqual(helperMetrics.relatedFiles, ['contract/demo/src/main.rs']);

    const nestedMetrics = out.perFile['contract/demo/src/nested/mod.rs'];
    assert.equal(nestedMetrics.lines, 2);
    assert.deepEqual(nestedMetrics.importedBy, ['contract/demo/src/main.rs']);

    const cargoMetrics = out.perFile['contract/demo/Cargo.toml'];
    assert.equal(cargoMetrics.lines, 0);
    assert.equal(cargoMetrics.functions, 0);

    const packageMetrics = out.perFile['contract/demo/package.json'];
    assert.equal(packageMetrics.lines, 0);
    assert.equal(packageMetrics.functions, 0);
  } finally {
    removeDirSafe(tmp);
  }
}

async function run(name, fn) {
  line(`[test:start] ${name}`);
  try {
    await fn();
    line(`${PASS} ${name}`);
    line(`[test:end] ${name}`);
    return true;
  } catch (error) {
    line(`${FAIL} ${name}`);
    line(`  ${error instanceof Error ? error.stack || error.message : String(error)}`);
    line(`[test:end] ${name}`);
    return false;
  }
}

async function main() {
  line(`Orbkit test run started at ${nowIso()}`);
  line(`Log file: ${LOG_PATH}`);
  const tests = [
    ['CLI init scaffolds orbkit workspace', testCliScaffold],
    ['CLI start alias scaffolds orbkit workspace', testCliAliasScaffold],
    ['create.mjs creates generated and custom wallets', testCreateWalletModule],
    ['graphqlws.mjs reuses one persistent websocket connection', testGraphqlWsModule],
    ['graphqlws.mjs authenticates and streams planned channels', testGraphqlWsAuthAndChannels],
    ['channels.mjs routes network actions and returns structure', testChannelModule],
    ['server todo doc tracks pending backend work', testServerTodoDoc],
    ['setup.js handles devnet readiness flow', testSetupFlow],
    ['setup.js hard-fails without WSL on Windows', testSetupFailsWithoutWslOnWindows],
    ['fund.mjs executes transfer flow', testFundFlow],
    ['balance.mjs computes wallet totals', testBalanceFlow],
    ['buildeploy.mjs deploys and retries on RBF rejection', testDeployFlowWithRetry],
    ['structure.mjs analyzes contract files and shared functionality', testContractStructureAnalysis],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await run(name, fn);
    if (ok) passed += 1;
  }

  const total = tests.length;
  line(`\nSummary: ${passed}/${total} passed`);
  line(`Orbkit test run completed at ${nowIso()}`);
  flushLog();
  process.exit(passed === total ? 0 : 1);
}

main();
