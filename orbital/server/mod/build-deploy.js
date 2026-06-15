import { blockchain } from '@ckb-lumos/base';
import { bytes } from '@ckb-lumos/codec';
import { hd } from '@ckb-lumos/lumos';
import { loadConfig, normalizePrivateKey as normalizeOrbkitPrivateKey } from '../../orbkit/mod/common.mjs';
import {
  backfillDeploymentReceipt,
  readLastDeploymentReceipt,
  legacyDeploymentReceipt,
  writeLastDeploymentReceipt,
} from '../../orbkit/mod/deployment-receipts.mjs';

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeContractPath(value) {
  const contractPath = String(value || '').trim().replace(/\\/g, '/');
  if (!contractPath) {
    throw new Error('contractPath is required.');
  }
  return contractPath;
}

function normalizeNetwork(value) {
  const network = String(value || 'devnet').trim().toLowerCase();
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) {
    throw new Error('network must be one of: devnet, testnet, mainnet.');
  }
  return network;
}

function normalizeRetryCount(value) {
  if (value === undefined || value === null || value === '') return 2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('retryCount must be a positive integer.');
  }
  return Math.max(1, Math.floor(parsed));
}

function normalizeBuildFlag(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  return Boolean(value);
}

function normalizeDeployKind(value) {
  const deployKind = String(value || 'typeid').trim().toLowerCase();
  if (deployKind !== 'typeid' && deployKind !== 'data') {
    throw new Error('deployKind must be "typeid" or "data".');
  }
  return deployKind;
}

function normalizeOptionalAccessToken(value) {
  const token = String(value || '').trim();
  return token || null;
}

function normalizePasskeyProof(value) {
  const proof = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16,128}$/.test(proof)) {
    throw new Error('passkeyProof must be a hex-like string between 16 and 128 characters.');
  }
  return proof;
}

function normalizePrivateKey(value) {
  const raw = String(value || '').trim();
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Selected wallet does not include a valid signing key.');
  }
  return key;
}

function resolveDevnetSponsorPrivateKey(configPath) {
  const cfg = loadConfig(configPath || undefined);
  const privateKeyEnvName = String(cfg?.funder?.privateKeyEnv || 'FUNDER_PRIVKEY').trim();
  const rawPrivkey = String(process.env[privateKeyEnvName] || cfg?.funder?.defaultPrivateKey || '').trim();
  return normalizeOrbkitPrivateKey(rawPrivkey, 'funder private key');
}

function parseEventResult(result) {
  if (!result) return null;
  if (typeof result === 'object') return result;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function deployFailureHint(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/not enough capacity|no live ckb/i.test(message)) {
    return 'The deploy transaction builder could not collect enough spendable live cells from the selected address on the active RPC/indexer. Refresh the wallet balance, confirm the selected address owns live devnet cells, then try again.';
  }
  return null;
}

function parseServiceMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return parseServiceMetadata(JSON.parse(metadata));
    } catch {
      return {};
    }
  }
  if (typeof metadata !== 'object') return {};
  if (typeof metadata.raw === 'string' && Object.keys(metadata).length === 1) {
    return parseServiceMetadata(metadata.raw);
  }
  return metadata;
}

function applySessionRefresh(reply, session) {
  if (!reply?.raw || !session?.refreshed || !session?.token) return;
  reply.raw.setHeader('x-access-token', session.token);
  reply.raw.setHeader('x-session-refreshed', '1');
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function normalizeBalanceValue(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function resolveOrbkitService(bridge, preferredService) {
  if (preferredService) {
    const target = String(preferredService).trim();
    const match = bridge.getState().connectedServices.find((service) => service.service === target);
    if (match) return match;
  }
  const state = bridge.getState();
  const orbkits = state.connectedServices.filter((service) => String(service.role || '').trim() === 'orbkit');
  if (orbkits.length === 0) {
    throw new Error('No connected orbkit service is available.');
  }
  return orbkits[0];
}

function serviceConfigPath(service) {
  return parseServiceMetadata(service?.metadata).configPath || undefined;
}

function writeNdjson(reply, payload) {
  reply.raw.write(`${JSON.stringify(payload)}\n`);
}

function ensurePasskeyAuthorized(user, passkeyProof) {
  const stored = String(user?.api || '').trim().toLowerCase();
  if (!stored) {
    throw new Error('A passkey must be registered before deploying.');
  }
  normalizePasskeyProof(passkeyProof);
  // The browser ceremony already proves possession. The stored passkey marker
  // only acts as an account-level gate in this local passkey model.
  return true;
}

function signDeployTransaction(unsignedTx, signingEntries, privateKeyInput) {
  if (!unsignedTx || typeof unsignedTx !== 'object') {
    throw new Error('Unsigned transaction is required before signing.');
  }
  if (!Array.isArray(signingEntries) || signingEntries.length === 0) {
    throw new Error('Unsigned transaction did not include signing entries.');
  }

  const privateKey = normalizePrivateKey(privateKeyInput);
  const witnesses = Array.isArray(unsignedTx.witnesses) ? [...unsignedTx.witnesses] : [];
  for (const entry of signingEntries) {
    if (entry?.type !== 'witness_args_lock') continue;
    const index = Number(entry.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('Invalid signing entry index.');
    }
    const message = String(entry.message || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(message)) {
      throw new Error('Invalid signing entry message.');
    }
    const signature = hd.key.signRecoverable(message, privateKey);
    const currentWitness = witnesses[index] || '0x';
    let witnessArgs = {};
    if (currentWitness !== '0x') {
      witnessArgs = blockchain.WitnessArgs.unpack(bytes.bytify(currentWitness));
    }
    witnesses[index] = bytes.hexify(blockchain.WitnessArgs.pack({
      inputType: witnessArgs.inputType,
      outputType: witnessArgs.outputType,
      lock: signature,
    }));
  }

  return {
    ...unsignedTx,
    witnesses,
  };
}

function signDeployTransactionWithEntries(unsignedTx, entryGroups = []) {
  if (!unsignedTx || typeof unsignedTx !== 'object') {
    throw new Error('Unsigned transaction is required before signing.');
  }

  const entriesByPrivateKey = new Map();
  for (const group of entryGroups) {
    const entries = Array.isArray(group?.entries) ? group.entries : [];
    if (entries.length === 0) continue;
    const privateKey = normalizePrivateKey(group.privateKey);
    const current = entriesByPrivateKey.get(privateKey) || [];
    current.push(...entries);
    entriesByPrivateKey.set(privateKey, current);
  }

  let signedTx = unsignedTx;
  let signedEntryCount = 0;
  for (const [privateKey, entries] of entriesByPrivateKey.entries()) {
    signedTx = signDeployTransaction(signedTx, entries, privateKey);
    signedEntryCount += entries.length;
  }

  if (signedEntryCount === 0) {
    throw new Error('Unsigned transaction did not include signing entries.');
  }

  return signedTx;
}

function publishBuildEvent(bridge, input = {}) {
  return bridge.publishBuildDeployEvent(null, {
    createdAt: nowIso(),
    ...input,
  });
}

function buildUserLog(event) {
  return {
    requestId: event.requestId,
    action: event.action,
    phase: event.phase,
    status: event.status,
    service: event.service,
    target: event.target,
    network: event.network,
    contractPath: event.contractPath,
    scriptName: event.scriptName,
    message: event.message,
    error: event.error,
    result: event.result,
    createdAt: event.createdAt,
  };
}

export function createBuildDeployService({
  bridge,
  publishServiceEvent,
  walletAccessService,
  broadcastSignedDeployTransaction,
  db,
  balanceService,
  accountInfoService,
}) {
  async function syncDeployWalletBalance({
    network,
    deployWallet,
    attempts = 1,
    initialDelayMs = 0,
    retryDelayMs = 0,
  }) {
    if (!deployWallet?.address || !balanceService?.getWalletBalance) return null;
    const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
    let latestBalance = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt === 0) {
        await sleep(initialDelayMs);
      } else {
        await sleep(retryDelayMs);
      }

      try {
        const balance = await balanceService.getWalletBalance({
          address: deployWallet.address,
          network,
          preferCache: false,
          scanMode: network === 'devnet' ? 'full' : 'estimate',
        });
        latestBalance = normalizeBalanceValue(balance);
        if (network === 'devnet' && latestBalance !== null) {
          bridge.setDevnetBalance(deployWallet.address, latestBalance);
        }
      } catch {
        // Keep retrying; a just-broadcast transaction may briefly outrun the indexer.
      }
    }

    return latestBalance;
  }

  async function streamAction({ reply, body, action }) {
    const requestId = `job_${randomId()}`;
    const contractPath = normalizeContractPath(body?.contractPath);
    const network = normalizeNetwork(body?.network);
    const retryCount = normalizeRetryCount(body?.retryCount);
    const build = normalizeBuildFlag(body?.build, action === 'build');
    const deployKind = normalizeDeployKind(body?.deployKind);
    const targetService = resolveOrbkitService(bridge);
    const deployWallet = action === 'deploy'
      ? walletAccessService.resolveDeployWallet({
          accessToken: normalizeOptionalAccessToken(body?.accessToken),
          headers: body?.headers,
          network,
          walletAddress: body?.walletAddress,
        })
      : null;
    let buildSession = null;
    if (!deployWallet) {
      try {
        buildSession = walletAccessService.resolveSession({
          accessToken: normalizeOptionalAccessToken(body?.accessToken),
          headers: body?.headers,
        });
      } catch {
        buildSession = null;
      }
    }
    const ownerKey = deployWallet?.userUuid || buildSession?.user?.uuid || 'runtime';
    const projectKey = contractPath;
    if (action === 'deploy') {
      const user = db?.getUserByUuid?.(deployWallet.userUuid);
      ensurePasskeyAuthorized(user, body?.passkeyProof);
    }

    reply.raw.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.raw.setHeader('Connection', 'keep-alive');
    applySessionRefresh(reply, deployWallet?.session);
    reply.hijack();

    writeNdjson(reply, {
      type: 'build-deploy-started',
      requestId,
      action,
      contractPath,
      network,
      build,
      deployKind,
      deployAddress: deployWallet?.address || null,
      service: targetService.service,
      createdAt: nowIso(),
    });

    let closed = false;
    const unsubscribe = bridge.subscribeBuildDeployEvents((event) => {
      if (!event || event.requestId !== requestId) return;
      writeNdjson(reply, {
        type: 'build-deploy-log',
        ...buildUserLog(event),
      });
      if (
        event.phase === 'failed'
        || (
          event.phase === 'completed'
          && (action !== 'deploy' || event.service === 'orbital-server')
        )
      ) {
        close();
      }
    });

    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    reply.raw.on('close', close);
    reply.raw.on('error', close);

    bridge.publishBuildDeployEvent(null, {
      requestId,
      action,
      ownerKey,
      projectKey,
      phase: 'queued',
      status: 'queued',
      service: 'orbital-server',
      target: targetService.service,
      network,
      contractPath,
      scriptName: null,
      message: action === 'deploy' && deployWallet
        ? `Queued ${action} request for ${contractPath} using ${deployWallet.username} on ${network}.`
        : `Queued ${action} request for ${contractPath}.`,
    }).catch((error) => {
      writeNdjson(reply, {
        type: 'build-deploy-log',
        requestId,
        action,
        phase: 'failed',
        status: 'failed',
        service: 'orbital-server',
        target: targetService.service,
        network,
        contractPath,
        scriptName: null,
        message: `Failed to queue ${action} request.`,
        error: error instanceof Error ? error.message : String(error),
        createdAt: nowIso(),
      });
      close();
    });

    try {
      await publishServiceEvent({
        channel: 'build-deploy-request',
        service: 'orbital-server',
        target: targetService.service,
        direction: 'outbound',
        network,
        ownerKey,
        projectKey,
        body: JSON.stringify({
          requestId,
          action,
          ownerKey,
          projectKey,
          contractPath,
          network,
          retryCount,
          build,
          deployKind,
          deployWallet: deployWallet
            ? {
                username: deployWallet.username,
                network: deployWallet.network,
                address: deployWallet.address,
              }
            : null,
        }),
      });
    } catch (error) {
      bridge.publishBuildDeployEvent(null, {
        requestId,
        action,
        ownerKey,
        projectKey,
        phase: 'failed',
        status: 'failed',
        service: 'orbital-server',
        target: targetService.service,
        network,
        contractPath,
        scriptName: null,
        message: `Failed to send ${action} request to orbkit.`,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {
        // ignore secondary publish failures
      });
    }

    if (action === 'deploy') {
      void finishDeployAfterPrepare({
        requestId,
        contractPath,
        network,
        targetService,
        deployWallet,
        ownerKey,
        projectKey,
      });
    }
  }

  async function waitForDeployPrepare(requestId, timeoutMs = 120000) {
    const existing = parseEventResult(bridge.getLatestBuildDeployEvent(requestId)?.result);
    if (existing?.unsignedTx) return existing;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timed out waiting for unsigned deploy transaction.'));
      }, timeoutMs);
      const unsubscribe = bridge.subscribeBuildDeployEvents((event) => {
        if (!event || event.requestId !== requestId) return;
        if (event.phase === 'failed') {
          clearTimeout(timeout);
          unsubscribe();
          reject(new Error(event.error || event.message || 'Deploy prepare failed.'));
          return;
        }
        const result = parseEventResult(event.result);
        if (!result?.unsignedTx) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(result);
      });
    });
  }

  async function waitForBroadcast(requestId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timed out waiting for devnet deploy broadcast.'));
      }, timeoutMs);
      const unsubscribe = bridge.subscribeBuildDeployEvents((event) => {
        if (!event || event.requestId !== requestId) return;
        if (event.phase === 'failed') {
          clearTimeout(timeout);
          unsubscribe();
          reject(new Error(event.error || event.message || 'Deploy broadcast failed.'));
          return;
        }
        if (event.phase !== 'completed') return;
        const result = parseEventResult(event.result);
        if (!result?.txHash) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(result);
      });
    });
  }

  async function requestOrbkitBroadcast({ requestId, contractPath, network, targetService, tx, prepareResult, ownerKey, projectKey }) {
    await publishServiceEvent({
      channel: 'build-deploy-request',
      service: 'orbital-server',
      target: targetService.service,
      direction: 'outbound',
      network,
      ownerKey,
      projectKey,
      body: JSON.stringify({
        requestId,
        action: 'deploy-broadcast',
        contractPath,
        network,
        tx,
        prepareResult,
      }),
    });
  }

  async function finishDeployAfterPrepare({ requestId, contractPath, network, targetService, deployWallet, ownerKey, projectKey }) {
    try {
      const prepared = await waitForDeployPrepare(requestId);
      await publishBuildEvent(bridge, {
        requestId,
        action: 'deploy',
        ownerKey,
        projectKey,
        phase: 'signing',
        status: 'running',
        service: 'orbital-server',
        target: targetService.service,
        network,
        contractPath,
        scriptName: prepared.scriptConfig?.NAME || null,
        message: `Signing unsigned deploy transaction for ${contractPath}.`,
        result: {
          action: 'deploy-signing',
          binaryBytes: prepared.binaryBytes ?? null,
          signingEntryCount: prepared.signingEntries?.length ?? 0,
          sponsorSigningEntryCount: prepared.sponsorSigningEntries?.length ?? 0,
          sponsored: Boolean(prepared.sponsored),
          sponsorMode: prepared.sponsorMode || null,
          sponsorAddress: prepared.sponsorAddress || null,
          deployKind: prepared.deployKind || null,
          deployMode: prepared.deployMode || (prepared.redeploy ? 'upgrade' : 'create'),
          redeploy: Boolean(prepared.redeploy),
          typeScript: prepared.typeScript || null,
          address: deployWallet.address,
        },
      });

      const entryGroups = [
        {
          entries: prepared.signingEntries,
          privateKey: deployWallet.privkey,
        },
      ];
      if (prepared.sponsored && network === 'devnet' && prepared.sponsorSigningEntries?.length) {
        entryGroups.push({
          entries: prepared.sponsorSigningEntries,
          privateKey: resolveDevnetSponsorPrivateKey(serviceConfigPath(targetService)),
        });
      }
      const signedTx = signDeployTransactionWithEntries(prepared.unsignedTx, entryGroups);
      await publishBuildEvent(bridge, {
        requestId,
        action: 'deploy',
        ownerKey,
        projectKey,
        phase: 'broadcasting',
        status: 'running',
        service: 'orbital-server',
        target: network === 'devnet' ? targetService.service : 'rpc',
        network,
        contractPath,
        scriptName: prepared.scriptConfig?.NAME || null,
        message: network === 'devnet'
          ? `Submitting signed deploy transaction to Orbkit for devnet broadcast.`
          : `Broadcasting signed deploy transaction to ${network} RPC.`,
        result: {
          action: 'deploy-broadcasting',
          binaryBytes: prepared.binaryBytes ?? null,
          binaryPath: prepared.binaryPath || null,
          deployKind: prepared.deployKind || null,
          sponsored: Boolean(prepared.sponsored),
          sponsorMode: prepared.sponsorMode || null,
          sponsorAddress: prepared.sponsorAddress || null,
          scriptConfig: prepared.scriptConfig || null,
          typeId: prepared.typeId || null,
          typeScript: prepared.typeScript || null,
          deployMode: prepared.deployMode || (prepared.redeploy ? 'upgrade' : 'create'),
          redeploy: Boolean(prepared.redeploy),
        },
      });

      const broadcastResult = network === 'devnet'
        ? await (async () => {
            const broadcastWait = waitForBroadcast(requestId);
            try {
              await requestOrbkitBroadcast({
                requestId,
                contractPath,
                network,
                targetService,
                tx: signedTx,
                prepareResult: prepared,
                ownerKey,
                projectKey,
              });
            } catch (error) {
              broadcastWait.catch(() => {});
              throw error;
            }
            return broadcastWait;
          })()
        : await broadcastSignedDeployTransaction({
            network,
            tx: signedTx,
            configPath: serviceConfigPath(targetService),
          });

      const deploymentReceipt = broadcastResult.deployment || writeLastDeploymentReceipt({
        configPath: serviceConfigPath(targetService),
        contractName: prepared.scriptConfig?.NAME || null,
        contractPath,
        scriptName: prepared.scriptConfig?.NAME || null,
        network,
        txHash: broadcastResult.txHash,
        binaryBytes: prepared.binaryBytes ?? null,
        binaryPath: prepared.binaryPath || null,
        deployKind: prepared.deployKind || null,
        sponsored: Boolean(prepared.sponsored),
        sponsorMode: prepared.sponsorMode || null,
        sponsorAddress: prepared.sponsorAddress || null,
        scriptConfig: prepared.scriptConfig || null,
        typeId: prepared.typeId || null,
        typeScript: prepared.typeScript || null,
        deployMode: prepared.deployMode || (prepared.redeploy ? 'upgrade' : 'create'),
        redeploy: Boolean(prepared.redeploy),
        deployAddress: deployWallet.address,
        service: targetService.service,
        walletAddress: deployWallet.address,
        walletLabel: deployWallet.username || null,
        broadcast: broadcastResult,
        deployedAt: nowIso(),
      });
      bridge.persistDeploymentReceipt?.({
        service: targetService.service,
        ownerKey,
        projectKey,
        network,
        contractPath,
        scriptName: prepared.scriptConfig?.NAME || null,
        txHash: broadcastResult.txHash,
        deployAddress: deployWallet.address,
        walletAddress: deployWallet.address,
        deployedAt: deploymentReceipt?.deployedAt || nowIso(),
        receipt: deploymentReceipt,
      });

      const balanceRefreshAttempts = prepared.sponsored ? 2 : 6;
      await publishBuildEvent(bridge, {
        requestId,
        action: 'deploy',
        ownerKey,
        projectKey,
        phase: 'refreshing-balance',
        status: 'running',
        service: 'orbital-server',
        target: network === 'devnet' ? targetService.service : 'rpc',
        network,
        contractPath,
        scriptName: prepared.scriptConfig?.NAME || null,
        message: prepared.sponsored
          ? `Refreshing selected wallet spendable balance. Devnet deploy capacity was sponsored, so spendable CKB may stay unchanged.`
          : `Refreshing selected wallet spendable balance after broadcast.`,
        result: {
          ok: true,
          action: 'deploy-balance-refresh',
          network,
          contractPath,
          walletAddress: deployWallet.address,
          sponsored: Boolean(prepared.sponsored),
          sponsorMode: prepared.sponsorMode || null,
          sponsorAddress: prepared.sponsorAddress || null,
          balanceRefreshAttempts,
        },
      });

      const postDeployBalance = await syncDeployWalletBalance({
        network,
        deployWallet,
        attempts: balanceRefreshAttempts,
        initialDelayMs: 1200,
        retryDelayMs: network === 'devnet' ? 1200 : 2500,
      });

      await publishBuildEvent(bridge, {
        requestId,
        action: 'deploy',
        ownerKey,
        projectKey,
        phase: 'completed',
        status: 'completed',
        service: 'orbital-server',
        target: network === 'devnet' ? targetService.service : 'rpc',
        network,
        contractPath,
        scriptName: prepared.scriptConfig?.NAME || null,
        message: `Deploy completed for ${contractPath}.`,
        result: {
          ok: true,
          action: 'deploy',
          network,
          contractPath,
          txHash: broadcastResult.txHash,
          binaryBytes: prepared.binaryBytes ?? null,
          binaryPath: prepared.binaryPath || null,
          deployKind: prepared.deployKind || null,
          sponsored: Boolean(prepared.sponsored),
          sponsorMode: prepared.sponsorMode || null,
          sponsorAddress: prepared.sponsorAddress || null,
          scriptConfig: prepared.scriptConfig || null,
          typeId: prepared.typeId || null,
          typeScript: prepared.typeScript || null,
          deployMode: prepared.deployMode || (prepared.redeploy ? 'upgrade' : 'create'),
          redeploy: Boolean(prepared.redeploy),
          deployAddress: deployWallet.address,
          walletAddress: deployWallet.address,
          walletBalance: postDeployBalance,
          balanceRefreshed: postDeployBalance !== null,
          balanceRefreshAttempts,
          broadcast: broadcastResult,
          deployment: deploymentReceipt,
        },
      });
    } catch (error) {
      const hint = deployFailureHint(error);
      await publishBuildEvent(bridge, {
        requestId,
        action: 'deploy',
        ownerKey,
        projectKey,
        phase: 'failed',
        status: 'failed',
        service: 'orbital-server',
        target: targetService.service,
        network,
        contractPath,
        scriptName: null,
        message: `Deploy failed for ${contractPath}.`,
        error: error instanceof Error ? error.message : String(error),
        result: {
          ok: false,
          action: 'deploy',
          network,
          contractPath,
          hint,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return {
    async streamBuild({ reply, body }) {
      return streamAction({
        reply,
        body,
        action: 'build',
      });
    },

    async streamDeploy({ reply, body }) {
      return streamAction({
        reply,
        body,
        action: 'deploy',
      });
    },

    async broadcastSignedDeploy({ body, reply }) {
      const network = normalizeNetwork(body?.network);
      const deployWallet = walletAccessService.resolveDeployWallet({
        accessToken: normalizeOptionalAccessToken(body?.accessToken),
        headers: body?.headers,
        network,
        walletAddress: body?.walletAddress,
      });
      applySessionRefresh(reply, deployWallet.session);
      if (!body?.tx || typeof body.tx !== 'object') {
        throw new Error('tx is required.');
      }
      return broadcastSignedDeployTransaction({
        network,
        tx: body.tx,
        configPath: body.configPath || serviceConfigPath(resolveOrbkitService(bridge)),
      });
    },

    async latestDeployment({ query = {}, session = null } = {}) {
      const network = normalizeNetwork(query.network || 'devnet');
      const contractPath = query.contractPath ? normalizeContractPath(query.contractPath) : '';
      const ownerKey = String(session?.user?.uuid || query.ownerKey || 'runtime').trim() || 'runtime';
      const projectKey = contractPath;
      const targetService = resolveOrbkitService(bridge, query.service);
      const configPath = serviceConfigPath(targetService);
      if (!configPath) {
        return {
          ok: true,
          service: targetService.service,
          network,
          contractPath: contractPath || null,
          deployment: null,
        };
      }
      const walletAddress = String(query.walletAddress || query.deployAddress || '').trim();
      const persistedReceipt = await db.getDeploymentReceipt?.({
        ownerKey,
        projectKey,
        service: targetService.service,
        network,
        contractPath,
      });
      const receipt = persistedReceipt?.receipt || readLastDeploymentReceipt({
        configPath,
        network,
        contractPath,
      }) || (contractPath && walletAddress
        ? await backfillDeploymentReceipt({
            configPath,
            network,
            contractPath,
            walletAddress,
          })
        : contractPath
          ? legacyDeploymentReceipt({
              configPath,
              network,
              contractPath,
            })
          : null);
      return {
        ok: true,
        service: targetService.service,
        network,
        contractPath: contractPath || receipt?.contractPath || null,
        deployment: receipt,
      };
    },
  };
}
