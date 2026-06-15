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

function normalizeLiveSyncEnabled(value, fallback = false) {
  if (value === undefined) return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
  return Boolean(value);
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return parseMetadata(JSON.parse(metadata));
    } catch {
      return {};
    }
  }
  if (typeof metadata !== 'object') return {};
  if (typeof metadata.raw === 'string' && Object.keys(metadata).length === 1) {
    return parseMetadata(metadata.raw);
  }
  return metadata;
}

function hasStructureCapability(service) {
  const metadata = parseMetadata(service?.metadata);
  const capabilities = Array.isArray(metadata.capabilities) ? metadata.capabilities : [];
  return capabilities
    .map((capability) => String(capability || '').trim())
    .includes('project-structure-sync');
}

function serviceContractPaths(service) {
  const metadata = parseMetadata(service?.metadata);
  if (!Array.isArray(metadata.contracts)) return [];
  return metadata.contracts
    .map((contract) => String(contract?.path || '').trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function assertServiceOwnsContract(service, contractPath) {
  const contractPaths = serviceContractPaths(service);
  if (contractPaths.length === 0) return;
  if (contractPaths.includes(contractPath)) return;
  throw new Error(`${service.service} does not expose ${contractPath}. Available contracts: ${contractPaths.join(', ')}`);
}

function resolveOrbkitService(bridge, preferredService) {
  if (preferredService) {
    const target = String(preferredService).trim();
    const match = bridge.getState().connectedServices.find((service) => service.service === target);
    if (match) return match;
  }
  const orbkits = bridge.getState().connectedServices.filter((service) => String(service.role || '').trim() === 'orbkit');
  if (orbkits.length === 0) {
    throw new Error('No connected orbkit service is available.');
  }
  return orbkits.find(hasStructureCapability) || orbkits[0];
}

function writeNdjson(reply, payload) {
  reply.raw.write(`${JSON.stringify(payload)}\n`);
}

function toUserEvent(event) {
  return {
    streamId: event.streamId,
    contractPath: event.contractPath,
    service: event.service,
    status: event.status,
    liveSyncEnabled: event.liveSyncEnabled,
    syncMode: event.syncMode,
    changeType: event.changeType,
    sequence: event.sequence,
    message: event.message,
    error: event.error,
    snapshot: event.snapshot,
    createdAt: event.createdAt,
  };
}

export function createProjectStructureService({ bridge, publishServiceEvent, db }) {
  const liveSyncState = new Map();

  function buildKey(serviceName, contractPath) {
    return `${serviceName}:${contractPath}`;
  }

  function ownerFromSession(session) {
    return String(session?.user?.uuid || session?.user?.username || 'runtime').trim() || 'runtime';
  }

  function getLiveSyncEnabled(serviceName, contractPath) {
    return liveSyncState.get(buildKey(serviceName, contractPath)) ?? false;
  }

  function setLiveSyncEnabled(serviceName, contractPath, enabled) {
    liveSyncState.set(buildKey(serviceName, contractPath), Boolean(enabled));
    return Boolean(enabled);
  }

  async function dispatchStructureCommand({
    serviceName,
    contractPath,
    ownerKey,
    projectKey,
    requestType,
    liveSyncEnabled,
  }) {
    await publishServiceEvent({
      channel: 'project-structure-request',
      service: 'orbital-server',
      target: serviceName,
      direction: 'outbound',
      ownerKey,
      projectKey,
      body: JSON.stringify({
        requestId: `struct_${randomId()}`,
        ownerKey,
        projectKey,
        contractPath,
        requestType,
        liveSyncEnabled,
      }),
    });
  }

  async function latestStructureEvent({ contractPath, ownerKey, service }) {
    const fromBridge = bridge.getLatestProjectStructureEvent({
      ownerKey,
      projectKey: contractPath,
      service,
      contractPath,
    });
    if (fromBridge?.snapshot) return fromBridge;

    const fromDb = await db?.getLatestProjectStructureEvent?.({
      ownerKey,
      projectKey: contractPath,
      service,
      contractPath,
    });
    if (fromDb?.snapshot || ownerKey === 'runtime') return fromDb || fromBridge || null;

    const runtimeFallback = await db?.getLatestProjectStructureEvent?.({
      ownerKey: 'runtime',
      projectKey: contractPath,
      service,
      contractPath,
    });
    return runtimeFallback || fromDb || fromBridge || null;
  }

  return {
    getLiveSyncState({ serviceName, contractPath }) {
      return getLiveSyncEnabled(serviceName, contractPath);
    },

    async syncProjectStructure({ body = {}, session = null }) {
      const contractPath = normalizeContractPath(body.contractPath);
      const ownerKey = ownerFromSession(session);
      const targetService = resolveOrbkitService(bridge, body.service);
      assertServiceOwnsContract(targetService, contractPath);
      const liveSyncEnabled = normalizeLiveSyncEnabled(
        body.liveSyncEnabled,
        getLiveSyncEnabled(targetService.service, contractPath),
      );
      setLiveSyncEnabled(targetService.service, contractPath, liveSyncEnabled);

      await bridge.publishProjectStructureEvent(null, {
        streamId: `struct_${randomId()}`,
        ownerKey,
        projectKey: contractPath,
        contractPath,
        service: 'orbital-server',
        target: targetService.service,
        status: 'queued',
        liveSyncEnabled,
        syncMode: liveSyncEnabled ? 'live' : 'manual',
        changeType: 'request',
        sequence: 0,
        message: `Queued project structure sync for ${contractPath}.`,
      });

      await dispatchStructureCommand({
        serviceName: targetService.service,
        contractPath,
        ownerKey,
        projectKey: contractPath,
        requestType: 'sync',
        liveSyncEnabled,
      });

      const latest = await latestStructureEvent({
        ownerKey,
        service: targetService.service,
        contractPath,
      });

      return {
        ok: true,
        contractPath,
        service: targetService.service,
        liveSyncEnabled,
        queuedAt: nowIso(),
        latest,
      };
    },

    async latestProjectStructure({ query = {}, session = null }) {
      const contractPath = normalizeContractPath(query.contractPath);
      const ownerKey = ownerFromSession(session);
      const requestedService = String(query.service || '').trim();
      let targetService = null;
      try {
        targetService = resolveOrbkitService(bridge, requestedService);
        assertServiceOwnsContract(targetService, contractPath);
      } catch {
        targetService = null;
      }
      const service = targetService?.service || requestedService || null;
      const latest = await latestStructureEvent({
        ownerKey,
        service,
        contractPath,
      });

      return {
        ok: true,
        contractPath,
        service: service || latest?.service || null,
        latest: latest ? toUserEvent(latest) : null,
      };
    },

    async configureLiveSync({ body = {}, session = null }) {
      const contractPath = normalizeContractPath(body.contractPath);
      const ownerKey = ownerFromSession(session);
      const targetService = resolveOrbkitService(bridge, body.service);
      assertServiceOwnsContract(targetService, contractPath);
      const liveSyncEnabled = normalizeLiveSyncEnabled(body.liveSyncEnabled, false);
      setLiveSyncEnabled(targetService.service, contractPath, liveSyncEnabled);

      await dispatchStructureCommand({
        serviceName: targetService.service,
        contractPath,
        ownerKey,
        projectKey: contractPath,
        requestType: 'configure-live-sync',
        liveSyncEnabled,
      });

      const event = await bridge.publishProjectStructureEvent(null, {
        streamId: `struct_${randomId()}`,
        ownerKey,
        projectKey: contractPath,
        contractPath,
        service: 'orbital-server',
        target: targetService.service,
        status: 'configured',
        liveSyncEnabled,
        syncMode: liveSyncEnabled ? 'live' : 'manual',
        changeType: 'config',
        sequence: 0,
        message: liveSyncEnabled
          ? `Live project structure sync enabled for ${contractPath}.`
          : `Live project structure sync disabled for ${contractPath}.`,
      });

      return {
        ok: true,
        ...toUserEvent(event),
      };
    },

    async streamProjectStructure({ reply, query = {}, body = {}, session = null }) {
      const contractPath = normalizeContractPath(query.contractPath || body.contractPath);
      const ownerKey = ownerFromSession(session);
      const targetService = resolveOrbkitService(bridge, query.service || body.service);
      assertServiceOwnsContract(targetService, contractPath);
      const liveSyncEnabled = getLiveSyncEnabled(targetService.service, contractPath);

      reply.raw.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.hijack();

      writeNdjson(reply, {
        type: 'project-structure-started',
        streamId: `struct_${randomId()}`,
        contractPath,
        service: targetService.service,
        liveSyncEnabled,
        createdAt: nowIso(),
      });

      const latest = await latestStructureEvent({
        ownerKey,
        service: targetService.service,
        contractPath,
      });
      if (latest) {
        writeNdjson(reply, {
          type: 'project-structure-log',
          ...toUserEvent(latest),
        });
      }

      let closed = false;
      const unsubscribe = bridge.subscribeProjectStructureEvents((event) => {
        if (!event) return;
        if (event.contractPath !== contractPath) return;
        if (event.service !== targetService.service && event.target !== targetService.service) return;
        writeNdjson(reply, {
          type: 'project-structure-log',
          ...toUserEvent(event),
        });
      });

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      };

      reply.raw.on('close', close);
      reply.raw.on('error', close);
    },
  };
}
