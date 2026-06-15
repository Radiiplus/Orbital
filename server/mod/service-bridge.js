import { EventEmitter } from 'node:events';

const SERVICE_EVENT_TOPIC = 'service:event';
const ACCOUNT_INFO_TOPIC = 'account:info';
const FUNDING_EVENT_TOPIC = 'funding:event';
const PROJECT_STRUCTURE_TOPIC = 'project-structure:event';
const BUILD_DEPLOY_TOPIC = 'build-deploy:event';

const RUNTIME_TTL_MS = Number(process.env.ORBITAL_RUNTIME_EVENT_TTL_MS || 60 * 60 * 1000);
const SERVICE_TTL_MS = Number(process.env.ORBITAL_RUNTIME_SERVICE_TTL_MS || 15 * 60 * 1000);

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function expiresAt(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) return null;
  return new Date(Date.now() + duration).toISOString();
}

function ownerKey(value) {
  return String(value || 'runtime').trim() || 'runtime';
}

function projectKey(value, fallback = 'runtime') {
  return String(value || fallback || 'runtime').trim().replace(/\\/g, '/') || 'runtime';
}

function parseServiceMetadata(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return parseServiceMetadata(JSON.parse(value));
    } catch {
      return { raw: value };
    }
  }
  if (typeof value !== 'object') return null;
  if (
    typeof value.raw === 'string'
    && Object.keys(value).length === 1
  ) {
    return parseServiceMetadata(value.raw);
  }
  return { ...value };
}

function metadataCapabilities(metadata) {
  const capabilities = Array.isArray(metadata?.capabilities) ? metadata.capabilities : [];
  return capabilities
    .map((capability) => String(capability || '').trim())
    .filter(Boolean);
}

function mergeServiceMetadata(currentValue, nextValue) {
  const current = parseServiceMetadata(currentValue);
  const next = parseServiceMetadata(nextValue);
  if (!current) return next;
  if (!next) return current;

  const capabilities = new Set([
    ...metadataCapabilities(current),
    ...metadataCapabilities(next),
  ]);
  return {
    ...current,
    ...next,
    ...(capabilities.size > 0 ? { capabilities: Array.from(capabilities).sort() } : {}),
  };
}

export function createServiceBridge({ db, logger } = {}) {
  const services = new Map();
  const devnetBalances = new Map();
  const balanceWaiters = new Map();
  const fundingRequests = new Map();
  const fundingEmitter = new EventEmitter();
  const projectStructures = new Map();
  const projectStructureEmitter = new EventEmitter();
  const buildDeployRequests = new Map();
  const buildDeployEmitter = new EventEmitter();

  function persist(method, payload) {
    if (!db || typeof db[method] !== 'function') return;
    try {
      const result = db[method](payload);
      Promise.resolve(result).catch((error) => {
        logger?.debug?.(
          { err: error, method },
          'runtime persistence failed',
        );
      });
    } catch (error) {
      logger?.debug?.(
        { err: error, method },
        'runtime persistence failed',
      );
    }
  }

  function snapshotServices() {
    return Array.from(services.values()).sort((a, b) => a.service.localeCompare(b.service));
  }

  function getState() {
    return {
      connectedServices: snapshotServices(),
      connectedCount: services.size,
      updatedAt: nowIso(),
    };
  }

  function registerService(input = {}) {
    const service = String(input.service || '').trim();
    if (!service) {
      throw new Error('service is required.');
    }

    const existing = services.get(service) || null;
    const metadata = mergeServiceMetadata(existing?.metadata, input.metadata);
    const record = {
      service,
      role: String(input.role || 'client').trim() || 'client',
      status: String(input.status || 'connected').trim() || 'connected',
      metadata: metadata ? JSON.stringify(metadata) : null,
      connectedAt: existing?.connectedAt || nowIso(),
      updatedAt: nowIso(),
    };
    services.set(service, record);
    persist('upsertOrbkitService', {
      ...record,
      expiresAt: expiresAt(SERVICE_TTL_MS),
    });
    return getState();
  }

  function unregisterService(serviceName) {
    const service = String(serviceName || '').trim();
    if (service) {
      services.delete(service);
      persist('deleteOrbkitService', service);
    }
    return getState();
  }

  function normalizeEvent(input = {}) {
    return {
      id: input.id || `evt_${randomId()}`,
      channel: String(input.channel || 'service').trim() || 'service',
      service: String(input.service || 'unknown').trim() || 'unknown',
      target: input.target ? String(input.target).trim() : null,
      body: String(input.body || '').trim(),
      direction: String(input.direction || 'outbound').trim() || 'outbound',
      network: input.network ? String(input.network).trim() : null,
      createdAt: input.createdAt || nowIso(),
    };
  }

  function normalizeFundingEvent(input = {}) {
    return {
      requestId: String(input.requestId || `fund_${randomId()}`).trim(),
      phase: String(input.phase || 'progress').trim() || 'progress',
      status: String(input.status || 'pending').trim() || 'pending',
      address: String(input.address || '').trim(),
      amountInCKB: String(input.amountInCKB ?? '').trim(),
      service: String(input.service || 'unknown').trim() || 'unknown',
      target: input.target ? String(input.target).trim() : null,
      txHash: input.txHash ? String(input.txHash).trim() : null,
      message: String(input.message || '').trim(),
      error: input.error ? String(input.error).trim() : null,
      result: input.result ?? null,
      createdAt: input.createdAt || nowIso(),
    };
  }

  function normalizeProjectStructureEvent(input = {}) {
    const contractPath = String(input.contractPath || '').trim();
    const service = String(input.service || 'unknown').trim() || 'unknown';
    const snapshot = input.snapshot ?? null;
    const sequence = Number.isFinite(Number(input.sequence)) ? Number(input.sequence) : 0;
    return {
      streamId: String(input.streamId || contractPath || `structure_${randomId()}`).trim(),
      contractPath,
      service,
      target: input.target ? String(input.target).trim() : null,
      status: String(input.status || 'ready').trim() || 'ready',
      liveSyncEnabled: Boolean(input.liveSyncEnabled),
      syncMode: String(input.syncMode || 'manual').trim() || 'manual',
      changeType: String(input.changeType || 'snapshot').trim() || 'snapshot',
      sequence,
      message: String(input.message || '').trim(),
      error: input.error ? String(input.error).trim() : null,
      snapshot,
      createdAt: input.createdAt || nowIso(),
    };
  }

  function normalizeBuildDeployEvent(input = {}) {
    return {
      requestId: String(input.requestId || `job_${randomId()}`).trim(),
      action: String(input.action || 'build').trim() || 'build',
      status: String(input.status || 'pending').trim() || 'pending',
      phase: String(input.phase || 'progress').trim() || 'progress',
      service: String(input.service || 'unknown').trim() || 'unknown',
      target: input.target ? String(input.target).trim() : null,
      network: input.network ? String(input.network).trim() : null,
      contractPath: input.contractPath ? String(input.contractPath).trim() : null,
      scriptName: input.scriptName ? String(input.scriptName).trim() : null,
      message: String(input.message || '').trim(),
      error: input.error ? String(input.error).trim() : null,
      result: input.result ?? null,
      createdAt: input.createdAt || nowIso(),
    };
  }

  function normalizeBalanceResult(input = {}) {
    return {
      requestId: String(input.requestId || '').trim(),
      address: String(input.address || '').trim(),
      network: input.network ? String(input.network).trim().toLowerCase() : null,
      balance: input.balance === undefined || input.balance === null ? null : String(input.balance),
      ok: input.ok === undefined ? true : Boolean(input.ok),
      error: input.error ? String(input.error).trim() : null,
      result: input.result ?? null,
      service: input.service ? String(input.service).trim() : null,
      createdAt: input.createdAt || nowIso(),
    };
  }

  async function publishServiceEvent(pubsub, input = {}) {
    const event = normalizeEvent(input);
    persist('upsertRuntimeMessage', {
      ...event,
      ownerKey: ownerKey(input.ownerKey),
      projectKey: projectKey(input.projectKey || input.contractPath, 'runtime'),
      expiresAt: expiresAt(RUNTIME_TTL_MS),
    });
    await pubsub.publish({
      topic: SERVICE_EVENT_TOPIC,
      payload: {
        serviceEvents: event,
      },
    });
    return event;
  }

  async function publishFundingEvent(pubsub, input = {}) {
    const event = normalizeFundingEvent(input);
    fundingRequests.set(event.requestId, event);
    fundingEmitter.emit(FUNDING_EVENT_TOPIC, event);
    persist('upsertFundingState', {
      ...event,
      ownerKey: ownerKey(input.ownerKey),
      expiresAt: expiresAt(RUNTIME_TTL_MS),
    });
    if (pubsub?.publish) {
      await pubsub.publish({
        topic: FUNDING_EVENT_TOPIC,
        payload: {
          fundingEvents: event,
        },
      });
    }
    return event;
  }

  function getLatestFundingEvent(requestId) {
    const key = String(requestId || '').trim();
    if (!key) return null;
    return fundingRequests.get(key) || null;
  }

  function subscribeFundingEvents(listener) {
    fundingEmitter.on(FUNDING_EVENT_TOPIC, listener);
    return () => {
      fundingEmitter.off(FUNDING_EVENT_TOPIC, listener);
    };
  }

  async function publishProjectStructureEvent(pubsub, input = {}) {
    const owner = ownerKey(input.ownerKey);
    const project = projectKey(input.projectKey || input.contractPath);
    const key = `${owner}:${project}`;
    const previous = projectStructures.get(key) || null;
    const event = normalizeProjectStructureEvent({
      ...input,
      snapshot: input.snapshot ?? previous?.snapshot ?? null,
    });
    projectStructures.set(key, event);
    projectStructureEmitter.emit(PROJECT_STRUCTURE_TOPIC, event);
    persist('upsertProjectStructureState', {
      ...event,
      ownerKey: owner,
      projectKey: project,
      updatedAt: nowIso(),
    });
    if (pubsub?.publish) {
      await pubsub.publish({
        topic: PROJECT_STRUCTURE_TOPIC,
        payload: {
          projectStructureEvents: event,
        },
      });
    }
    return event;
  }

  function getLatestProjectStructureEvent(input = {}) {
    const owner = input.ownerKey ? ownerKey(input.ownerKey) : '';
    const project = projectKey(input.projectKey || input.contractPath, '');
    if (owner && project) {
      const exact = projectStructures.get(`${owner}:${project}`);
      if (exact) return exact;
    }
    const service = String(input.service || '').trim();
    const contractPath = String(input.contractPath || '').trim();
    if (!service || !contractPath) return null;
    return Array.from(projectStructures.values())
      .filter((event) => (
        event.contractPath === contractPath
        && (event.service === service || event.target === service)
      ))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
  }

  function subscribeProjectStructureEvents(listener) {
    projectStructureEmitter.on(PROJECT_STRUCTURE_TOPIC, listener);
    return () => {
      projectStructureEmitter.off(PROJECT_STRUCTURE_TOPIC, listener);
    };
  }

  async function publishBuildDeployEvent(pubsub, input = {}) {
    const event = normalizeBuildDeployEvent(input);
    buildDeployRequests.set(event.requestId, event);
    buildDeployEmitter.emit(BUILD_DEPLOY_TOPIC, event);
    persist('upsertBuildDeployState', {
      ...event,
      ownerKey: ownerKey(input.ownerKey),
      projectKey: projectKey(input.projectKey || event.contractPath, 'runtime'),
      expiresAt: expiresAt(RUNTIME_TTL_MS),
    });
    if (pubsub?.publish) {
      await pubsub.publish({
        topic: BUILD_DEPLOY_TOPIC,
        payload: {
          buildDeployEvents: event,
        },
      });
    }
    return event;
  }

  function getLatestBuildDeployEvent(requestId) {
    const key = String(requestId || '').trim();
    if (!key) return null;
    return buildDeployRequests.get(key) || null;
  }

  function persistDeploymentReceipt(input = {}) {
    const receipt = input.receipt || input.deployment || input;
    if (!receipt || typeof receipt !== 'object') return null;
    const record = {
      service: input.service || receipt.service || 'default',
      ownerKey: ownerKey(input.ownerKey),
      projectKey: projectKey(input.projectKey || input.contractPath || receipt.contractPath),
      network: input.network || receipt.network || null,
      contractPath: input.contractPath || receipt.contractPath || null,
      scriptName: input.scriptName || receipt.scriptName || receipt.contractName || null,
      txHash: input.txHash || receipt.txHash || receipt.scriptConfig?.TX_HASH || null,
      deployAddress: input.deployAddress || receipt.deployAddress || null,
      walletAddress: input.walletAddress || receipt.walletAddress || null,
      deployedAt: input.deployedAt || receipt.deployedAt || null,
      receipt,
      updatedAt: nowIso(),
    };
    persist('upsertDeploymentReceipt', record);
    if (record.ownerKey !== 'runtime') {
      persist('upsertDeploymentReceipt', {
        ...record,
        ownerKey: 'runtime',
      });
    }
    return record;
  }

  function subscribeBuildDeployEvents(listener) {
    buildDeployEmitter.on(BUILD_DEPLOY_TOPIC, listener);
    return () => {
      buildDeployEmitter.off(BUILD_DEPLOY_TOPIC, listener);
    };
  }

  function setDevnetBalance(address, balance) {
    const key = String(address || '').trim();
    if (!key) return null;
    const record = {
      address: key,
      balance: String(balance ?? '0'),
      updatedAt: nowIso(),
    };
    devnetBalances.set(key, record);
    return record;
  }

  function getDevnetBalance(address) {
    const key = String(address || '').trim();
    if (!key) return null;
    return devnetBalances.get(key) || null;
  }

  function waitForBalanceResult(input = {}) {
    const requestId = String(input.requestId || '').trim();
    if (!requestId) return Promise.resolve(null);
    const timeoutMs = Math.max(1, Number(input.timeoutMs || 2500));

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        balanceWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      balanceWaiters.set(requestId, {
        resolve,
        timeout,
      });
    });
  }

  function resolveBalanceRequest(input = {}) {
    const result = normalizeBalanceResult(input);
    if (!result.requestId) return result;

    const waiter = balanceWaiters.get(result.requestId);
    if (waiter) {
      clearTimeout(waiter.timeout);
      balanceWaiters.delete(result.requestId);
      waiter.resolve(result);
    }

    return result;
  }

  function cancelBalanceRequest(requestId) {
    const key = String(requestId || '').trim();
    if (!key) return false;
    const waiter = balanceWaiters.get(key);
    if (!waiter) return false;
    clearTimeout(waiter.timeout);
    balanceWaiters.delete(key);
    waiter.resolve(null);
    return true;
  }

  async function publishAccountInfo(pubsub, payload) {
    await pubsub.publish({
      topic: ACCOUNT_INFO_TOPIC,
      payload: {
        accountInfo: payload,
        accountInfoStream: payload,
      },
    });
  }

  return {
    serviceEventTopic: SERVICE_EVENT_TOPIC,
    accountInfoTopic: ACCOUNT_INFO_TOPIC,
    fundingEventTopic: FUNDING_EVENT_TOPIC,
    projectStructureTopic: PROJECT_STRUCTURE_TOPIC,
    buildDeployTopic: BUILD_DEPLOY_TOPIC,
    getState,
    registerService,
    unregisterService,
    normalizeEvent,
    normalizeFundingEvent,
    publishServiceEvent,
    publishFundingEvent,
    getLatestFundingEvent,
    subscribeFundingEvents,
    normalizeProjectStructureEvent,
    publishProjectStructureEvent,
    getLatestProjectStructureEvent,
    subscribeProjectStructureEvents,
    normalizeBuildDeployEvent,
    publishBuildDeployEvent,
    getLatestBuildDeployEvent,
    persistDeploymentReceipt,
    subscribeBuildDeployEvents,
    setDevnetBalance,
    getDevnetBalance,
    waitForBalanceResult,
    resolveBalanceRequest,
    cancelBalanceRequest,
    publishAccountInfo,
  };
}
