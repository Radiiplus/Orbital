import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { buildServer } from './index.js';
import { publishOrbkitBalanceUpdate as publishOrbkitBalanceUpdateClient } from '../orbkit/mod/serverevents.mjs';
import { startBalanceWorker } from '../orbkit/mod/balance-worker.mjs';
import { startBuildDeployWorker } from '../orbkit/mod/build-deploy-worker.mjs';
import { startFundingWorker } from '../orbkit/mod/funding-worker.mjs';
import { startStructureWorker } from '../orbkit/mod/structure-worker.mjs';

process.env.ORBITAL_DB_PROVIDER = 'stub';

function waitFor(predicate, timeoutMs = 3000, intervalMs = 25) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error('Timed out waiting for condition.'));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, intervalMs);
  });
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function pasteFormattedMnemonic(mnemonic) {
  return String(mnemonic || '')
    .split(' ')
    .map((word, index) => `${index + 1}. ${word}`)
    .join('\r\n\u200B');
}

function removeDirSafe(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function makeTestConfig({ workspaceRoot, deploymentOutput, rpcUrl }) {
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
      defaultPrivateKey: `0x${'22'.repeat(32)}`,
      requireKnownGenesisAddress: false,
    },
    deployment: {
      contractsSourceFile: '../orbital.config.js',
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

function prependPath(dirPath, existingPath = process.env.PATH || '') {
  return [dirPath, existingPath].filter(Boolean).join(path.delimiter);
}

function writeNpxShim(binDir, { scriptsTemplatePath, withDeployArtifacts = false }) {
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
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const all = process.argv.slice(2).join(' ');",
    "const stateFile = process.env.TEST_STATE_FILE || '';",
    "const outputDir = process.env.TEST_DEPLOYMENT_OUTPUT || '';",
    `const withDeployArtifacts = ${withDeployArtifacts ? 'true' : 'false'};`,
    'let state = {};',
    'if (stateFile && fs.existsSync(stateFile)) {',
    "  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));",
    '}',
    'if (all.includes("@offckb/cli transfer")) {',
    '  const attempts = Number(state.transferAttempts || 0) + 1;',
    '  state.transferAttempts = attempts;',
    "  if (process.env.TEST_FAIL_FIRST_TRANSFER === '1' && attempts === 1) {",
    "    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));",
    "    console.error('simulated transfer failure');",
    '    process.exit(1);',
    '  }',
    "  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));",
    "  console.log('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');",
    '  process.exit(0);',
    '}',
    'if (all.includes("@offckb/cli balance")) {',
    "  console.log('wallet total: 6200000000');",
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
    "  console.log('deploy via npx shim');",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(npxRunnerPath, runner);
}

function startRpcServer(options = {}) {
  const deployCellsEnabled = options.deployCells === true;
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

      if (Array.isArray(body)) {
        const responses = body.map((item, index) => {
          if (item?.method === 'get_cells') {
            const searchKey = item.params?.[0] || {};
            const script = searchKey.script || {};
            return {
              jsonrpc: '2.0',
              id: item.id ?? 0,
              result: {
                objects: [
                  {
                    block_number: '0x1',
                    out_point: {
                      tx_hash: `0x${'11'.repeat(32)}`,
                      index: '0x0',
                    },
                    output: {
                      capacity: '0x174876e800',
                      lock: {
                        code_hash: script.code_hash || '0x00',
                        hash_type: script.hash_type || 'type',
                        args: script.args || '0x',
                      },
                      type: null,
                    },
                    output_data: '0x',
                    tx_index: '0x0',
                  },
                ],
                last_cursor: '',
              },
            };
          }
          return {
            jsonrpc: '2.0',
            id: item.id ?? 0,
            result: null,
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responses));
        return;
      }

      if (body.method === 'get_tip_block_number') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 0, result: '0x10' }));
        return;
      }

      if (body.method === 'get_cells') {
        if (!deployCellsEnabled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? 0,
            result: {
              objects: [
                {
                  output: { capacity: '0x171f4d5c00' },
                  output_data: '0x',
                },
              ],
              last_cursor: '',
            },
          }));
          return;
        }

        const searchKey = body.params?.[0] || {};
        const script = searchKey.script || {};
        const afterCursor = body.params?.[3] || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 0,
          result: {
            objects: afterCursor ? [] : [
              {
                block_number: '0x1',
                out_point: {
                  tx_hash: `0x${'11'.repeat(32)}`,
                  index: '0x0',
                },
                output: {
                  capacity: '0x174876e800',
                  lock: {
                    code_hash: script.code_hash || '0x00',
                    hash_type: script.hash_type || 'type',
                    args: script.args || '0x',
                  },
                  type: null,
                },
                output_data: '0x',
                tx_index: '0x0',
              },
            ],
            last_cursor: afterCursor ? '' : 'cursor-1',
          },
        }));
        return;
      }

      if (body.method === 'send_transaction') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 0,
          result: `0x${'56'.repeat(32)}`,
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 0, result: null }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
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

async function readNdjsonResponse(url, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        const events = raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          events,
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function readNdjsonResponseWithHeaders(url, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        const events = raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          events,
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function httpJsonRequest(method, url, payload) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: body
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          }
        : {},
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: raw ? JSON.parse(raw) : null,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function httpJsonRequestWithHeaders(method, url, payload, headers = {}) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: body
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...headers,
          }
        : {
            ...headers,
          },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: raw ? JSON.parse(raw) : null,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function openNdjsonStream(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      let buffer = '';
      const events = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          events.push(JSON.parse(trimmed));
        }
      });
      resolve({
        events,
        close: () => {
          req.destroy();
        },
        waitFor: async (predicate, timeoutMs = 4000, intervalMs = 25) => {
          await waitFor(() => predicate(events), timeoutMs, intervalMs);
          return events;
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function openSubscriptionClient({ port, query, variables, onNext }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
  const received = [];

  return new Promise((resolve, reject) => {
    let acknowledged = false;
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'connection_init',
        payload: {},
      }));
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'connection_ack') {
        acknowledged = true;
        socket.send(JSON.stringify({
          id: 'sub-1',
          type: 'subscribe',
          payload: {
            query,
            variables,
          },
        }));
        return;
      }
      if (message.type === 'next') {
        received.push(message.payload);
        onNext?.(message.payload);
      }
    });

    socket.on('error', reject);
    socket.on('close', () => {
      if (!acknowledged) reject(new Error('Subscription socket closed before ack.'));
    });

    resolve({
      socket,
      received,
      close: () => {
        try {
          socket.close();
        } catch {
          // ignore
        }
      },
    });
  });
}

async function run() {
  let app;

  try {
    app = buildServer({
      logger: false,
      orbkitApiKey: 'test-orbkit-key',
      balanceService: {
        getWalletBalance: async ({ address, network }) => (
          network === 'devnet'
            ? (app.serviceBridge.getDevnetBalance(address)?.balance ?? null)
            : null
        ),
      },
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = address.port;
    const healthRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: '{ health { ok service } }',
      },
    });
    const healthBody = healthRes.json();
    assert.equal(healthBody.data.health.ok, true);
    assert.equal(healthBody.data.health.service, 'orbital-server');

    const usernameRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'query Check($username: String!) { validateUsername(username: $username) { ok available normalized reason } }',
        variables: {
          username: 'fresh_user',
        },
      },
    });
    const usernameBody = usernameRes.json();
    assert.equal(usernameBody.data.validateUsername.ok, true);
    assert.equal(usernameBody.data.validateUsername.available, true);
    assert.equal(usernameBody.data.validateUsername.normalized, 'fresh_user');

    const takenRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'query Check($username: String!) { validateUsername(username: $username) { ok available normalized reason } }',
        variables: {
          username: 'demo-user',
        },
      },
    });
    const takenBody = takenRes.json();
    assert.equal(takenBody.data.validateUsername.ok, true);
    assert.equal(takenBody.data.validateUsername.available, false);

    const createAccountRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'mutation Create($username: String!, $network: String!) { createAccount(username: $username, network: $network) { ok owner { uuid username } wallet { uuid address addresses { devnet testnet mainnet } label mnemonic privkey pubkey } } }',
        variables: {
          username: 'creator-user',
          network: 'devnet',
        },
      },
    });
    const createAccountBody = createAccountRes.json();
    assert.equal(createAccountBody.data.createAccount.ok, true);
    assert.equal(typeof createAccountBody.data.createAccount.owner.uuid, 'string');
    assert.equal(createAccountBody.data.createAccount.owner.username, 'creator-user');
    assert.equal(createAccountBody.data.createAccount.wallet.uuid, createAccountBody.data.createAccount.owner.uuid);
    assert.equal(createAccountBody.data.createAccount.wallet.label, 'creator-user');
    assert.match(createAccountBody.data.createAccount.wallet.address, /^ckt1/i);
    assert.match(createAccountBody.data.createAccount.wallet.addresses.devnet, /^ckt1/i);
    assert.match(createAccountBody.data.createAccount.wallet.addresses.testnet, /^ckt1/i);
    assert.match(createAccountBody.data.createAccount.wallet.addresses.mainnet, /^ckb1/i);

    const createStandaloneRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'mutation Create($username: String!, $network: String!) { createAccount(username: $username, network: $network) { ok owner { uuid username } wallet { uuid label address addresses { devnet testnet mainnet } } } }',
        variables: {
          username: 'standalone_user',
          network: 'mainnet',
        },
      },
    });
    const createStandaloneBody = createStandaloneRes.json();
    assert.equal(createStandaloneBody.data.createAccount.ok, true);
    assert.equal(typeof createStandaloneBody.data.createAccount.owner.uuid, 'string');
    assert.equal(createStandaloneBody.data.createAccount.owner.username, 'standalone_user');
    assert.equal(createStandaloneBody.data.createAccount.wallet.uuid, createStandaloneBody.data.createAccount.owner.uuid);
    assert.equal(createStandaloneBody.data.createAccount.wallet.label, 'standalone_user');
    assert.match(createStandaloneBody.data.createAccount.wallet.address, /^ckb1/i);
    assert.match(createStandaloneBody.data.createAccount.wallet.addresses.devnet, /^ckt1/i);
    assert.match(createStandaloneBody.data.createAccount.wallet.addresses.testnet, /^ckt1/i);
    assert.match(createStandaloneBody.data.createAccount.wallet.addresses.mainnet, /^ckb1/i);

    const accountInfoBeforeBalanceRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'query Info($username: String!) { accountInfo(username: $username) { username wallets { address network balance } } }',
        variables: {
          username: 'creator-user',
        },
      },
    });
    const accountInfoBeforeBalanceBody = accountInfoBeforeBalanceRes.json();
    assert.equal(accountInfoBeforeBalanceBody.data.accountInfo.username, 'creator-user');
    assert.equal(accountInfoBeforeBalanceBody.data.accountInfo.wallets.length, 3);
    const devnetWalletBeforeBalance = accountInfoBeforeBalanceBody.data.accountInfo.wallets.find((item) => item.network === 'devnet');
    const testnetWalletBeforeBalance = accountInfoBeforeBalanceBody.data.accountInfo.wallets.find((item) => item.network === 'testnet');
    const mainnetWalletBeforeBalance = accountInfoBeforeBalanceBody.data.accountInfo.wallets.find((item) => item.network === 'mainnet');
    assert.equal(devnetWalletBeforeBalance.balance, null);
    assert.equal(testnetWalletBeforeBalance.balance, null);
    assert.equal(mainnetWalletBeforeBalance.balance, null);

    const subscriptionPayloads = [];
    const subscription = await openSubscriptionClient({
      port,
      query: 'subscription Stream($username: String!) { accountInfoStream(username: $username) { username wallets { address network balance } } }',
      variables: {
        username: 'creator-user',
      },
      onNext: (payload) => {
        subscriptionPayloads.push(payload);
      },
    });

    await waitFor(() => subscriptionPayloads.length >= 1);
    assert.equal(subscriptionPayloads[0].data.accountInfoStream.username, 'creator-user');
    assert.equal(subscriptionPayloads[0].data.accountInfoStream.wallets.length, 3);
    assert.equal(
      subscriptionPayloads[0].data.accountInfoStream.wallets.find((item) => item.network === 'devnet').balance,
      null,
    );

    const loginRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'mutation Login($username: String!, $passkeyProof: String!, $deviceId: String!) { login(username: $username, passkeyProof: $passkeyProof, deviceId: $deviceId) { ok accessToken owner { uuid username } wallet { uuid address addresses { devnet testnet mainnet } label pubkey } } }',
        variables: {
          username: 'creator-user',
          passkeyProof: 'a1b2c3d4e5f67890',
          deviceId: 'device_creator_001',
        },
      },
    });
    const loginBody = loginRes.json();
    assert.equal(loginBody.data.login.ok, true);
    assert.match(loginBody.data.login.accessToken, /^sess_/);
    assert.equal(loginBody.data.login.owner.username, 'creator-user');
    assert.equal(loginBody.data.login.wallet.label, 'creator-user');
    assert.match(loginBody.data.login.wallet.addresses.mainnet, /^ckb1/i);
    assert.equal(app.db.listSessions().length, 1);
    assert.equal(app.db.listSessions()[0].user.username, 'creator-user');

    const secondLoginRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'mutation Login($username: String!, $passkeyProof: String!, $deviceId: String!) { login(username: $username, passkeyProof: $passkeyProof, deviceId: $deviceId) { ok accessToken owner { uuid username } } }',
        variables: {
          username: 'creator-user',
          passkeyProof: '0f1e2d3c4b5a6978',
          deviceId: 'device_creator_001',
        },
      },
    });
    const secondLoginBody = secondLoginRes.json();
    assert.equal(secondLoginBody.data.login.ok, true);
    assert.match(secondLoginBody.data.login.accessToken, /^sess_/);
    assert.notEqual(secondLoginBody.data.login.accessToken, loginBody.data.login.accessToken);
    assert.equal(app.db.listSessions().length, 1);
    assert.equal(app.db.listSessions()[0].token, secondLoginBody.data.login.accessToken);

    const sessionInfoRes = await app.inject({
      method: 'GET',
      url: '/session',
      headers: {
        Authorization: `Bearer ${secondLoginBody.data.login.accessToken}`,
        'x-device-id': 'device_creator_001',
      },
    });
    const sessionInfoBody = sessionInfoRes.json();
    assert.equal(sessionInfoBody.ok, true);
    assert.equal(sessionInfoBody.user.username, 'creator-user');
    assert.equal(sessionInfoBody.refreshed, false);

    const helperKeyRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: {
        Authorization: `Bearer ${secondLoginBody.data.login.accessToken}`,
        'x-device-id': 'device_creator_001',
      },
      payload: {
        query: 'mutation CreateHelperApiKey($passkeyProof: String!) { createHelperApiKey(passkeyProof: $passkeyProof) { username key createdAt } }',
        variables: {
          passkeyProof: '11112222333344445555666677778888',
        },
      },
    });
    const helperKeyBody = helperKeyRes.json();
    assert.equal(helperKeyBody.data.createHelperApiKey.username, 'creator-user');
    assert.equal(helperKeyBody.data.createHelperApiKey.key, '11112222333344445555666677778888');

    const rotatedHelperKeyRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: {
        Authorization: `Bearer ${secondLoginBody.data.login.accessToken}`,
        'x-device-id': 'device_creator_001',
      },
      payload: {
        query: 'mutation CreateHelperApiKey($passkeyProof: String!) { createHelperApiKey(passkeyProof: $passkeyProof) { username key createdAt } }',
        variables: {
          passkeyProof: '9999aaaabbbbccccddddeeeeffff0000',
        },
      },
    });
    const rotatedHelperKeyBody = rotatedHelperKeyRes.json();
    assert.equal(rotatedHelperKeyBody.data.createHelperApiKey.username, 'creator-user');
    assert.equal(rotatedHelperKeyBody.data.createHelperApiKey.key, '9999aaaabbbbccccddddeeeeffff0000');
    assert.notEqual(rotatedHelperKeyBody.data.createHelperApiKey.key, helperKeyBody.data.createHelperApiKey.key);

    const sessionInfoWithKeyRes = await app.inject({
      method: 'GET',
      url: '/session',
      headers: {
        Authorization: `Bearer ${secondLoginBody.data.login.accessToken}`,
        'x-device-id': 'device_creator_001',
      },
    });
    const sessionInfoWithKeyBody = sessionInfoWithKeyRes.json();
    assert.equal(sessionInfoWithKeyBody.ok, true);
    assert.equal(sessionInfoWithKeyBody.user.api, rotatedHelperKeyBody.data.createHelperApiKey.key);
    assert.equal(sessionInfoWithKeyBody.user.helperApiKey, rotatedHelperKeyBody.data.createHelperApiKey.key);

    const creatorUser = app.db.getUserByUsername('creator-user');
    const creatorSession = app.db.getSessionByUuid(creatorUser.uuid);
    app.db.upsertSession({
      ...creatorSession,
      uuid: creatorUser.uuid,
      token: secondLoginBody.data.login.accessToken,
      user: creatorSession.user,
      createdAt: creatorSession.createdAt,
      expiresAt: Date.now() - 1000,
    });
    app.sessions.upsertCachedSession({
      uuid: creatorUser.uuid,
      token: secondLoginBody.data.login.accessToken,
      user: creatorSession.user,
      createdAt: creatorSession.createdAt,
      expiresAt: Date.now() - 1000,
    });

    const refreshedSessionRes = await app.inject({
      method: 'GET',
      url: '/session',
      headers: {
        Authorization: `Bearer ${secondLoginBody.data.login.accessToken}`,
        'x-device-id': 'device_creator_001',
      },
    });
    const refreshedSessionBody = refreshedSessionRes.json();
    assert.equal(refreshedSessionBody.ok, true);
    assert.equal(refreshedSessionBody.refreshed, true);
    assert.match(String(refreshedSessionRes.headers['x-access-token'] || ''), /^sess_/);
    const firstRotatedToken = String(refreshedSessionRes.headers['x-access-token']);

    const duplicateExpiredSessionRes = await app.inject({
      method: 'GET',
      url: '/session',
      headers: {
        Authorization: `Bearer ${secondLoginBody.data.login.accessToken}`,
        'x-device-id': 'device_creator_001',
      },
    });
    const duplicateExpiredSessionBody = duplicateExpiredSessionRes.json();
    assert.equal(duplicateExpiredSessionBody.ok, true);
    assert.equal(duplicateExpiredSessionBody.refreshed, true);
    assert.equal(duplicateExpiredSessionBody.accessToken, firstRotatedToken);
    assert.equal(String(duplicateExpiredSessionRes.headers['x-session-refreshed'] || ''), '1');
    assert.equal(String(duplicateExpiredSessionRes.headers['x-access-token'] || ''), firstRotatedToken);

    const duplicateExpiredRefreshRes = await app.inject({
      method: 'POST',
      url: '/session/refresh',
      headers: {
        Authorization: `Bearer ${secondLoginBody.data.login.accessToken}`,
        'x-device-id': 'device_creator_001',
      },
      payload: {
        deviceId: 'device_creator_001',
      },
    });
    const duplicateExpiredRefreshBody = duplicateExpiredRefreshRes.json();
    assert.equal(duplicateExpiredRefreshBody.ok, true);
    assert.equal(duplicateExpiredRefreshBody.refreshed, true);
    assert.equal(duplicateExpiredRefreshBody.accessToken, firstRotatedToken);
    assert.equal(String(duplicateExpiredRefreshRes.headers['x-access-token'] || ''), firstRotatedToken);

    const explicitSession = app.db.getSessionByUuid(creatorUser.uuid);
    app.db.upsertSession({
      ...explicitSession,
      uuid: creatorUser.uuid,
      token: firstRotatedToken,
      user: explicitSession.user,
      deviceId: explicitSession.deviceId,
      createdAt: explicitSession.createdAt,
      expiresAt: Date.now() - 1000,
    });
    app.sessions.upsertCachedSession({
      uuid: creatorUser.uuid,
      token: firstRotatedToken,
      user: explicitSession.user,
      deviceId: explicitSession.deviceId,
      createdAt: explicitSession.createdAt,
      expiresAt: Date.now() - 1000,
    });

    const explicitRefreshRes = await app.inject({
      method: 'POST',
      url: '/session/refresh',
      headers: {
        Authorization: `Bearer ${firstRotatedToken}`,
        'x-device-id': 'device_creator_001',
      },
      payload: {
        deviceId: 'device_creator_001',
      },
    });
    const explicitRefreshBody = explicitRefreshRes.json();
    assert.equal(explicitRefreshBody.ok, true);
    assert.equal(explicitRefreshBody.refreshed, true);
    assert.equal(explicitRefreshBody.deviceId, 'device_creator_001');
    assert.match(String(explicitRefreshBody.accessToken || ''), /^sess_/);
    assert.match(String(explicitRefreshRes.headers['x-access-token'] || ''), /^sess_/);

    const coldStartApp = buildServer({
      logger: false,
      db: app.db,
      orbkitApiKey: 'test-orbkit-key',
    });
    await coldStartApp.listen({ port: 0, host: '127.0.0.1' });
    try {
      const coldSessionRes = await coldStartApp.inject({
        method: 'GET',
        url: '/session',
      headers: {
          Authorization: `Bearer ${explicitRefreshBody.accessToken}`,
          'x-device-id': 'device_creator_001',
        },
    });
      const coldSessionBody = coldSessionRes.json();
      assert.equal(coldSessionBody.ok, true);
      assert.equal(coldSessionBody.user.username, 'creator-user');
    } finally {
      await coldStartApp.close();
    }

    const unauthorizedBalanceRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'mutation Publish($address: String!, $balance: String!) { publishOrbkitBalanceUpdate(address: $address, balance: $balance) { address balance } }',
        variables: {
          address: createAccountBody.data.createAccount.wallet.address,
          balance: '12500000000',
        },
      },
    });
    const unauthorizedBalanceBody = unauthorizedBalanceRes.json();
    assert.equal(unauthorizedBalanceBody.data, null);
    assert.match(unauthorizedBalanceBody.errors[0].message, /Unauthorized orbkit client/);

    const publishedBalance = await publishOrbkitBalanceUpdateClient({
      url: `http://127.0.0.1:${port}/graphql`,
      apiKey: 'test-orbkit-key',
      address: createAccountBody.data.createAccount.wallet.address,
      balance: '12500000000',
    });
    assert.equal(publishedBalance.address, createAccountBody.data.createAccount.wallet.address);
    assert.equal(publishedBalance.balance, '12500000000');

    await waitFor(() => (
      subscriptionPayloads.some((payload) => payload?.data?.accountInfoStream?.wallets?.[0]?.balance === '12500000000')
    ));

    const accountInfoAfterBalanceRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'query Info($username: String!) { accountInfo(username: $username) { username wallets { address network balance } } }',
        variables: {
          username: 'creator-user',
        },
      },
    });
    const accountInfoAfterBalanceBody = accountInfoAfterBalanceRes.json();
    assert.equal(
      accountInfoAfterBalanceBody.data.accountInfo.wallets.find((item) => item.network === 'devnet').balance,
      '12500000000',
    );
    assert.equal(
      accountInfoAfterBalanceBody.data.accountInfo.wallets.find((item) => item.network === 'testnet').balance,
      null,
    );
    assert.equal(
      accountInfoAfterBalanceBody.data.accountInfo.wallets.find((item) => item.network === 'mainnet').balance,
      null,
    );

    const recoverRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'mutation Recover($username: String!, $mnemonic: String!, $passkeyProof: String, $deviceId: String!) { recoverAccount(username: $username, mnemonic: $mnemonic, passkeyProof: $passkeyProof, deviceId: $deviceId) { ok accessToken passkeyProof owner { uuid username } wallet { uuid address addresses { devnet testnet mainnet } label pubkey } } }',
        variables: {
          username: 'creator-user',
          mnemonic: createAccountBody.data.createAccount.wallet.mnemonic,
          passkeyProof: '1234abcd5678ef90',
          deviceId: 'device_creator_001',
        },
      },
    });
    const recoverBody = recoverRes.json();
    assert.equal(recoverBody.data.recoverAccount.ok, true);
    assert.match(recoverBody.data.recoverAccount.accessToken, /^sess_/);
    assert.equal(recoverBody.data.recoverAccount.owner.username, 'creator-user');
    assert.equal(recoverBody.data.recoverAccount.wallet.address, createAccountBody.data.createAccount.wallet.address);
    assert.equal(recoverBody.data.recoverAccount.wallet.addresses.devnet, createAccountBody.data.createAccount.wallet.addresses.devnet);
    assert.equal(recoverBody.data.recoverAccount.passkeyProof, createAccountBody.data.createAccount.wallet.privkey);

    const formattedRecoverRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: 'mutation Recover($username: String!, $mnemonic: String!, $passkeyProof: String, $deviceId: String!) { recoverAccount(username: $username, mnemonic: $mnemonic, passkeyProof: $passkeyProof, deviceId: $deviceId) { ok wallet { address addresses { devnet } } } }',
        variables: {
          username: 'creator-user',
          mnemonic: pasteFormattedMnemonic(createAccountBody.data.createAccount.wallet.mnemonic),
          passkeyProof: '90ef7856cd34ab12',
          deviceId: 'device_creator_002',
        },
      },
    });
    const formattedRecoverBody = formattedRecoverRes.json();
    assert.equal(formattedRecoverBody.data.recoverAccount.ok, true);
    assert.equal(formattedRecoverBody.data.recoverAccount.wallet.address, createAccountBody.data.createAccount.wallet.address);
    assert.equal(formattedRecoverBody.data.recoverAccount.wallet.addresses.devnet, createAccountBody.data.createAccount.wallet.addresses.devnet);

    const schemaRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: '{ dbSchema }',
      },
    });
    const schemaBody = schemaRes.json();
    const schema = JSON.parse(schemaBody.data.dbSchema);
    assert.equal(typeof schema.users.columns.uuid, 'string');
    assert.equal(typeof schema.wallets.columns.address, 'string');

    subscription.close();

    const tmp = mkTmp('orbital-funding-e2e-');
    const rpc = await startRpcServer();
    let worker;
    const originalPath = process.env.PATH;
    let fundingApp;

    try {
      fundingApp = buildServer({
        logger: false,
        orbkitApiKey: 'test-orbkit-key',
        devnetRpcUrl: rpc.url,
        balanceService: {
          getWalletBalance: async ({ address, network }) => (
            network === 'devnet'
              ? (fundingApp.serviceBridge.getDevnetBalance(address)?.balance ?? null)
              : null
          ),
        },
      });
      await fundingApp.listen({ port: 0, host: '127.0.0.1' });
      const fundingPort = fundingApp.server.address().port;

      const workspace = path.join(tmp, 'workspace');
      const modDir = path.join(workspace, 'orbkit', 'mod');
      const fakeBin = path.join(tmp, 'fakebin');
      const stateFile = path.join(tmp, 'shim-state.json');
      fs.mkdirSync(modDir, { recursive: true });
      fs.mkdirSync(fakeBin, { recursive: true });

      const cfg = makeTestConfig({
        workspaceRoot: workspace,
        deploymentOutput: path.join(workspace, 'deployment'),
        rpcUrl: rpc.url,
      });
      writeJson(path.join(modDir, 'config.json'), cfg);
      writeJson(path.join(modDir, 'genesis.json'), []);
      writeNpxShim(fakeBin, { scriptsTemplatePath: path.join(fakeBin, 'npx-shim.js') });

      const e2eUsername = 'funding-user';
      const createFundingAccountRes = await fundingApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: 'mutation Create($username: String!, $network: String!) { createAccount(username: $username, network: $network) { ok wallet { address } } }',
          variables: {
            username: e2eUsername,
            network: 'devnet',
          },
        },
      });
      const createFundingAccountBody = createFundingAccountRes.json();
      const e2eAddress = createFundingAccountBody.data.createAccount.wallet.address;
      const fundingLoginRes = await fundingApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: 'mutation Login($username: String!, $passkeyProof: String!, $deviceId: String!) { login(username: $username, passkeyProof: $passkeyProof, deviceId: $deviceId) { accessToken } }',
          variables: {
            username: e2eUsername,
            passkeyProof: 'cafefeed1234abcd',
            deviceId: 'device_funding_001',
          },
        },
      });
      const fundingLoginBody = fundingLoginRes.json();
      const fundingAccessToken = fundingLoginBody.data.login.accessToken;

      worker = await startFundingWorker({
        serviceName: 'orbkit-e2e',
        url: `http://127.0.0.1:${fundingPort}/graphql`,
        wsUrl: `ws://127.0.0.1:${fundingPort}/graphql`,
        apiKey: 'test-orbkit-key',
        configPath: path.join(modDir, 'config.json'),
        progressDelayMs: 5,
        retryDelayMs: 5,
      });

      process.env.PATH = prependPath(fakeBin, process.env.PATH || '');
      process.env.TEST_STATE_FILE = stateFile;
      process.env.TEST_FAIL_FIRST_TRANSFER = '1';

      await waitFor(() => fundingApp.serviceBridge.getState().connectedServices.some((item) => item.service === 'orbkit-e2e'));

      const fundingResponse = await readNdjsonResponseWithHeaders(
        `http://127.0.0.1:${fundingPort}/wallets/devnet/fund`,
        {
          address: e2eAddress,
          amountInCKB: 62,
          retryCount: 2,
        },
        {
          Authorization: `Bearer ${fundingAccessToken}`,
          'x-device-id': 'device_funding_001',
        },
      );

      assert.equal(fundingResponse.statusCode, 200);
      assert.ok(fundingResponse.events.length >= 4);
      assert.equal(fundingResponse.events[0].type, 'funding-started');
      assert.ok(fundingResponse.events.some((event) => event.phase === 'devnet-check'));
      assert.ok(fundingResponse.events.some((event) => event.phase === 'queued'));
      assert.ok(fundingResponse.events.some((event) => event.phase === 'transfer-attempt'));
      assert.ok(fundingResponse.events.some((event) => event.phase === 'retrying'));
      assert.ok(fundingResponse.events.some((event) => event.phase === 'transferring'));
      const completedEvent = fundingResponse.events.find((event) => event.phase === 'completed');
      assert.ok(completedEvent);
      assert.equal(completedEvent.status, 'completed');
      assert.match(completedEvent.txHash, /^0x[a-f0-9]{64}$/i);

      const shimState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(shimState.transferAttempts, 2);

      const accountInfoAfterFundingRes = await fundingApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: 'query Info($username: String!) { accountInfo(username: $username) { wallets { network balance } } }',
          variables: {
            username: e2eUsername,
          },
        },
      });
      const accountInfoAfterFundingBody = accountInfoAfterFundingRes.json();
      assert.equal(
        accountInfoAfterFundingBody.data.accountInfo.wallets.find((item) => item.network === 'devnet').balance,
        '99309411328',
      );
    } finally {
      process.env.PATH = originalPath;
      delete process.env.TEST_STATE_FILE;
      delete process.env.TEST_FAIL_FIRST_TRANSFER;
      if (worker) {
        await worker.stop();
      }
      if (fundingApp) {
        await fundingApp.close();
      }
      await closeServer(rpc.server);
      removeDirSafe(tmp);
    }

    const balanceTmp = mkTmp('orbital-balance-e2e-');
    const balanceRpc = await startRpcServer();
    let balanceApp;
    let balanceWorker;

    try {
      const workspace = path.join(balanceTmp, 'workspace');
      const orbkitModDir = path.join(workspace, 'orbkit', 'mod');
      fs.mkdirSync(orbkitModDir, { recursive: true });

      const cfg = makeTestConfig({
        workspaceRoot: workspace,
        deploymentOutput: path.join(workspace, 'deployment'),
        rpcUrl: balanceRpc.url,
      });
      writeJson(path.join(orbkitModDir, 'config.json'), cfg);
      writeJson(path.join(orbkitModDir, 'genesis.json'), []);

      balanceApp = buildServer({
        logger: false,
        orbkitApiKey: 'test-orbkit-key',
        balanceConfigPath: path.join(orbkitModDir, 'config.json'),
      });
      await balanceApp.listen({ port: 0, host: '127.0.0.1' });
      const balancePort = balanceApp.server.address().port;

      const registerNonBalanceServiceRes = await balanceApp.inject({
        method: 'POST',
        url: '/graphql',
        headers: {
          authorization: 'Bearer test-orbkit-key',
        },
        payload: {
          query: 'mutation Register($service: String!, $role: String, $metadata: String) { registerService(service: $service, role: $role, metadata: $metadata) { connectedCount } }',
          variables: {
            service: 'orbkit-aaa-not-balance',
            role: 'orbkit',
            metadata: JSON.stringify({ capabilities: ['project-structure-sync'] }),
          },
        },
      });
      assert.equal(registerNonBalanceServiceRes.json().data.registerService.connectedCount, 1);

      const createBalanceAccountRes = await balanceApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: 'mutation Create($username: String!, $network: String!) { createAccount(username: $username, network: $network) { ok wallet { address addresses { devnet testnet mainnet } } } }',
          variables: {
            username: 'balance-user',
            network: 'devnet',
          },
        },
      });
      assert.equal(createBalanceAccountRes.json().data.createAccount.ok, true);

      balanceWorker = await startBalanceWorker({
        serviceName: 'orbkit-balance-e2e',
        url: `http://127.0.0.1:${balancePort}/graphql`,
        wsUrl: `ws://127.0.0.1:${balancePort}/graphql`,
        apiKey: 'test-orbkit-key',
        configPath: path.join(orbkitModDir, 'config.json'),
      });

      await waitFor(() => balanceApp.serviceBridge.getState().connectedServices.some((item) => item.service === 'orbkit-balance-e2e'));
      const registeredBalanceService = balanceApp.serviceBridge.getState().connectedServices.find((item) => item.service === 'orbkit-balance-e2e');
      assert.ok(JSON.parse(registeredBalanceService.metadata).capabilities.includes('wallet-balance'));

      const accountInfoWithBalancesRes = await balanceApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: 'query Info($username: String!) { accountInfo(username: $username) { wallets { network balance } } }',
          variables: {
            username: 'balance-user',
          },
        },
      });
      const accountInfoWithBalancesBody = accountInfoWithBalancesRes.json();
      const walletsWithBalances = accountInfoWithBalancesBody.data.accountInfo.wallets;
      assert.equal(walletsWithBalances.find((item) => item.network === 'devnet').balance, '99309411328');
      assert.equal(walletsWithBalances.find((item) => item.network === 'testnet').balance, '99309411328');
      assert.equal(walletsWithBalances.find((item) => item.network === 'mainnet').balance, '99309411328');
    } finally {
      if (balanceWorker) {
        await balanceWorker.stop();
      }
      if (balanceApp) {
        await balanceApp.close();
      }
      await closeServer(balanceRpc.server);
      removeDirSafe(balanceTmp);
    }

    const structureTmp = mkTmp('orbital-structure-e2e-');
    let structureApp;
    let structureWorker;

    try {
      structureApp = buildServer({
        logger: false,
        orbkitApiKey: 'test-orbkit-key',
      });
      await structureApp.listen({ port: 0, host: '127.0.0.1' });
      const structurePort = structureApp.server.address().port;

      const workspace = path.join(structureTmp, 'workspace');
      const orbkitModDir = path.join(workspace, 'orbkit', 'mod');
      const contractSrcDir = path.join(workspace, 'contract', 'demo', 'src');
      fs.mkdirSync(orbkitModDir, { recursive: true });
      fs.mkdirSync(contractSrcDir, { recursive: true });

      const cfg = makeTestConfig({
        workspaceRoot: workspace,
        deploymentOutput: path.join(workspace, 'deployment'),
        rpcUrl: 'http://127.0.0.1:8114',
      });
      writeJson(path.join(orbkitModDir, 'config.json'), cfg);
      writeJson(path.join(orbkitModDir, 'genesis.json'), []);
      fs.writeFileSync(path.join(workspace, 'contract', 'demo', 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
      fs.writeFileSync(path.join(contractSrcDir, 'main.rs'), 'fn main() {}\n');

      structureWorker = await startStructureWorker({
        serviceName: 'orbkit-structure-e2e',
        url: `http://127.0.0.1:${structurePort}/graphql`,
        wsUrl: `ws://127.0.0.1:${structurePort}/graphql`,
        apiKey: 'test-orbkit-key',
        configPath: path.join(orbkitModDir, 'config.json'),
        workspaceRoot: workspace,
        watchDebounceMs: 20,
      });

      await waitFor(() => structureApp.serviceBridge.getState().connectedServices.some((item) => item.service === 'orbkit-structure-e2e'));

      const stream = await openNdjsonStream(`http://127.0.0.1:${structurePort}/projects/structure/stream?service=orbkit-structure-e2e&contractPath=contract/demo`);

      const manualSync = await httpJsonRequest('POST', `http://127.0.0.1:${structurePort}/projects/structure/sync`, {
        service: 'orbkit-structure-e2e',
        contractPath: 'contract/demo',
        liveSyncEnabled: false,
      });
      assert.equal(manualSync.statusCode, 200);
      assert.equal(manualSync.body.ok, true);
      assert.equal(manualSync.body.liveSyncEnabled, false);

      await stream.waitFor((events) => events.some((event) => (
        event.type === 'project-structure-log'
        && event.contractPath === 'contract/demo'
        && event.changeType === 'snapshot'
        && typeof event.snapshot === 'string'
      )));

      const manualSnapshotEvent = stream.events.find((event) => (
        event.type === 'project-structure-log'
        && event.contractPath === 'contract/demo'
        && event.changeType === 'snapshot'
      ));
      assert.ok(manualSnapshotEvent);
      const manualSnapshot = JSON.parse(manualSnapshotEvent.snapshot);
      assert.equal(manualSnapshot.ok, true);
      assert.equal(manualSnapshot.contractPath, 'contract/demo');

      const liveEnable = await httpJsonRequest('POST', `http://127.0.0.1:${structurePort}/projects/structure/live`, {
        service: 'orbkit-structure-e2e',
        contractPath: 'contract/demo',
        liveSyncEnabled: true,
      });
      assert.equal(liveEnable.statusCode, 200);
      assert.equal(liveEnable.body.liveSyncEnabled, true);

      await stream.waitFor((events) => events.some((event) => (
        event.type === 'project-structure-log'
        && event.contractPath === 'contract/demo'
        && event.changeType === 'config'
        && event.liveSyncEnabled === true
      )));

      fs.writeFileSync(path.join(contractSrcDir, 'lib.rs'), 'pub fn added() {}\n');

      await stream.waitFor((events) => events.some((event) => (
        event.type === 'project-structure-log'
        && event.contractPath === 'contract/demo'
        && event.changeType === 'change'
      )));

      const changeEvent = [...stream.events].reverse().find((event) => (
        event.type === 'project-structure-log'
        && event.contractPath === 'contract/demo'
        && event.changeType === 'change'
      ));
      assert.ok(changeEvent);
      const changedSnapshot = JSON.parse(changeEvent.snapshot);
      assert.ok(changedSnapshot.perFile['contract/demo/src/lib.rs']);

      const liveDisable = await httpJsonRequest('POST', `http://127.0.0.1:${structurePort}/projects/structure/live`, {
        service: 'orbkit-structure-e2e',
        contractPath: 'contract/demo',
        liveSyncEnabled: false,
      });
      assert.equal(liveDisable.statusCode, 200);
      assert.equal(liveDisable.body.liveSyncEnabled, false);

      stream.close();
    } finally {
      if (structureWorker) {
        await structureWorker.stop();
      }
      if (structureApp) {
        await structureApp.close();
      }
      removeDirSafe(structureTmp);
    }

    const buildDeployTmp = mkTmp('orbital-build-deploy-e2e-');
    let buildDeployApp;
    let buildDeployWorker;
    let buildDeployRpc;

    try {
      buildDeployRpc = await startRpcServer({ deployCells: true });
      buildDeployApp = buildServer({
        logger: false,
        orbkitApiKey: 'test-orbkit-key',
      });
      await buildDeployApp.listen({ port: 0, host: '127.0.0.1' });
      const buildDeployPort = buildDeployApp.server.address().port;

      const workspace = path.join(buildDeployTmp, 'workspace');
      const orbkitDir = path.join(workspace, 'orbkit');
      const orbkitModDir = path.join(orbkitDir, 'mod');
      const contractDir = path.join(workspace, 'contract', 'demo');
      const deployOut = path.join(workspace, 'deployment');
      const fakeBin = path.join(buildDeployTmp, 'fakebin');
      const stateFile = path.join(buildDeployTmp, 'state.json');
      fs.mkdirSync(orbkitModDir, { recursive: true });
      fs.mkdirSync(path.join(contractDir, 'src'), { recursive: true });
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release'), { recursive: true });
      fs.mkdirSync(path.join(contractDir, 'target-windows', 'riscv64imac-unknown-none-elf', 'release'), { recursive: true });

      const cfg = makeTestConfig({
        workspaceRoot: workspace,
        deploymentOutput: deployOut,
        rpcUrl: buildDeployRpc.url,
      });
      cfg.deployment.build = false;
      cfg.deployment.concurrency = 1;
      cfg.deployment.allowMainnetDeploy = true;
      writeJson(path.join(orbkitModDir, 'config.json'), cfg);
      writeJson(path.join(orbkitModDir, 'genesis.json'), []);
      fs.writeFileSync(
        path.join(contractDir, 'Cargo.toml'),
        '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nckb-std = "0.15"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n',
      );
      fs.writeFileSync(
        path.join(contractDir, 'src', 'main.rs'),
        '#![no_std]\n#![no_main]\n\nuse ckb_std::default_alloc;\n\nckb_std::entry!(program_entry);\ndefault_alloc!();\n\nfn program_entry() -> i8 {\n    0\n}\n',
      );
      fs.writeFileSync(path.join(contractDir, 'target', 'riscv64imac-unknown-none-elf', 'release', 'demo'), 'binary');
      fs.writeFileSync(path.join(contractDir, 'target-windows', 'riscv64imac-unknown-none-elf', 'release', 'demo'), 'binary');
      writeJson(path.join(deployOut, 'scripts.json'), {});
      fs.writeFileSync(
        path.join(orbkitDir, 'orbital.config.js'),
        'export default { contracts: [{ path: "contract/demo", script: "demo", build: false }] };',
      );

      writeNpxShim(fakeBin, {
        scriptsTemplatePath: path.join(fakeBin, 'npx-shim.js'),
        withDeployArtifacts: true,
      });

      buildDeployWorker = await startBuildDeployWorker({
        serviceName: 'orbkit-build-deploy-e2e',
        url: `http://127.0.0.1:${buildDeployPort}/graphql`,
        wsUrl: `ws://127.0.0.1:${buildDeployPort}/graphql`,
        apiKey: 'test-orbkit-key',
        configPath: path.join(orbkitModDir, 'config.json'),
        retryDelayMs: 5,
      });

      const deployAccountRes = await buildDeployApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: 'mutation Create($username: String!, $network: String!) { createAccount(username: $username, network: $network) { ok wallet { address addresses { devnet testnet mainnet } } } }',
          variables: {
            username: 'deploy-user',
            network: 'mainnet',
          },
        },
      });
      const deployAccountBody = deployAccountRes.json();
      const deployLoginRes = await buildDeployApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: 'mutation Login($username: String!, $passkeyProof: String!, $deviceId: String!) { login(username: $username, passkeyProof: $passkeyProof, deviceId: $deviceId) { accessToken } }',
          variables: {
            username: 'deploy-user',
            passkeyProof: 'feedfacecafebeef',
            deviceId: 'device_deploy_001',
          },
        },
      });
      const deployLoginBody = deployLoginRes.json();
      const deployAccessToken = deployLoginBody.data.login.accessToken;
      const deployUser = buildDeployApp.db.getUserByUsername('deploy-user');
      const storedSession = buildDeployApp.db.getSessionByUuid(deployUser.uuid);
      buildDeployApp.db.upsertSession({
        ...storedSession,
        uuid: deployUser.uuid,
        token: deployAccessToken,
        user: storedSession.user,
        createdAt: storedSession.createdAt,
        expiresAt: Date.now() - 1000,
      });
      buildDeployApp.sessions.upsertCachedSession({
        uuid: deployUser.uuid,
        token: deployAccessToken,
        user: storedSession.user,
        createdAt: storedSession.createdAt,
        expiresAt: Date.now() - 1000,
      });

      process.env.PATH = prependPath(fakeBin, process.env.PATH || '');
      process.env.TEST_STATE_FILE = stateFile;
      process.env.TEST_DEPLOYMENT_OUTPUT = deployOut;
      process.env.ORBKIT_SKIP_CARGO_BUILD = '1';

      await waitFor(() => buildDeployApp.serviceBridge.getState().connectedServices.some((item) => item.service === 'orbkit-build-deploy-e2e'));

      const buildResponse = await readNdjsonResponse(
        `http://127.0.0.1:${buildDeployPort}/contracts/build`,
        {
          contractPath: 'contract/demo',
          network: 'devnet',
        },
      );

      assert.equal(buildResponse.statusCode, 200);
      assert.equal(buildResponse.events[0].type, 'build-deploy-started');
      assert.ok(buildResponse.events.some((event) => event.phase === 'queued'));
      assert.ok(buildResponse.events.some((event) => event.phase === 'accepted'));
      assert.ok(buildResponse.events.some((event) => event.phase === 'building'));
      const buildCompleted = buildResponse.events.find((event) => event.phase === 'completed');
      assert.ok(buildCompleted);
      assert.equal(buildCompleted.action, 'build');
      assert.equal(buildCompleted.status, 'completed');

      const deployResponse = await readNdjsonResponseWithHeaders(
        `http://127.0.0.1:${buildDeployPort}/contracts/deploy`,
        {
          contractPath: 'contract/demo',
          network: 'devnet',
          retryCount: 2,
          build: false,
          passkeyProof: 'feedfacecafebeef',
        },
        {
          Authorization: `Bearer ${deployAccessToken}`,
          'x-device-id': 'device_deploy_001',
        },
      );

      assert.equal(deployResponse.statusCode, 200);
      assert.equal(deployResponse.headers['x-session-refreshed'], '1');
      assert.match(String(deployResponse.headers['x-access-token'] || ''), /^sess_/);
      assert.equal(deployResponse.events[0].type, 'build-deploy-started');
      assert.ok(deployResponse.events.some((event) => event.phase === 'queued'));
      assert.ok(deployResponse.events.some((event) => event.phase === 'accepted'));
      assert.ok(deployResponse.events.some((event) => event.phase === 'preparing'));
      const deployCompleted = deployResponse.events.find((event) => event.phase === 'completed');
      if (!deployCompleted) {
        throw new Error(`Deploy stream did not complete: ${JSON.stringify(deployResponse.events, null, 2)}`);
      }
      assert.ok(deployCompleted);
      assert.equal(deployCompleted.action, 'deploy');
      assert.equal(deployCompleted.status, 'completed');
      const deployResult = JSON.parse(deployCompleted.result);
      assert.equal(deployResult.ok, true);
      assert.equal(deployResult.action, 'deploy-prepare');
      assert.equal(deployResult.contractPath, 'contract/demo');
      assert.equal(deployResult.deployKind, 'typeid');
      assert.equal(Array.isArray(deployResult.signingEntries), true);
      assert.ok(deployResult.signingEntries.length >= 1);
      assert.equal(typeof deployResult.unsignedTx, 'object');
      assert.equal(Array.isArray(deployResult.unsignedTx.outputs), true);
      assert.equal(typeof deployResult.scriptConfig.CODE_HASH, 'string');

      const deployStarted = deployResponse.events[0];
      assert.equal(deployStarted.deployAddress, deployAccountBody.data.createAccount.wallet.addresses.devnet);
      const rotatedDeployToken = String(deployResponse.headers['x-access-token']);

      const broadcastResponse = await httpJsonRequestWithHeaders('POST', `http://127.0.0.1:${buildDeployPort}/contracts/deploy/broadcast`, {
        network: 'devnet',
        configPath: path.join(orbkitModDir, 'config.json'),
        tx: deployResult.unsignedTx,
      }, {
        Authorization: `Bearer ${rotatedDeployToken}`,
        'x-device-id': 'device_deploy_001',
      });
      assert.equal(broadcastResponse.statusCode, 200);
      assert.equal(broadcastResponse.body.ok, true);
      assert.match(broadcastResponse.body.txHash, /^0x/i);

      const simResponse = await httpJsonRequestWithHeaders('POST', `http://127.0.0.1:${buildDeployPort}/contracts/deploy/simulate`, {
        contractPath: 'contract/demo',
        network: 'devnet',
        build: false,
        configPath: path.join(orbkitModDir, 'config.json'),
      }, {
        Authorization: `Bearer ${rotatedDeployToken}`,
        'x-device-id': 'device_deploy_001',
      });
      assert.equal(simResponse.statusCode, 200);
      assert.equal(simResponse.body.ok, true);
      assert.equal(simResponse.body.contractPath, 'contract/demo');
      assert.equal(simResponse.body.deployWallet.username, 'deploy-user');
      assert.equal(simResponse.body.deployWallet.address, deployAccountBody.data.createAccount.wallet.addresses.devnet);
      assert.equal(typeof simResponse.body.binaryBytes, 'number');
      assert.ok(simResponse.body.binaryBytes > 0);
      assert.equal(typeof simResponse.body.fee.feeShannons, 'string');
      assert.equal(typeof simResponse.body.fee.feeCkb, 'string');
    } finally {
      delete process.env.TEST_DEPLOYMENT_OUTPUT;
      delete process.env.ORBKIT_SKIP_CARGO_BUILD;
      if (buildDeployWorker) {
        await buildDeployWorker.stop();
      }
      if (buildDeployApp) {
        await buildDeployApp.close();
      }
      if (buildDeployRpc) {
        await closeServer(buildDeployRpc.server);
      }
      removeDirSafe(buildDeployTmp);
    }
  } finally {
    if (app) {
      await app.close();
    }
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

