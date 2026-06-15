function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!/^(ckt|ckb)1[0-9a-z]+$/i.test(value)) {
    throw new Error('address must be a ckt1... or ckb1... address.');
  }
  return value;
}

function normalizeAmount(amountInCKB) {
  const value = Number(amountInCKB);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('amountInCKB must be a positive number.');
  }
  if (value < 62) {
    throw new Error('amountInCKB must be at least 62.');
  }
  return String(value);
}

function normalizeRetryCount(value) {
  if (value === undefined || value === null || value === '') return 3;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('retryCount must be a positive integer.');
  }
  return Math.max(1, Math.floor(parsed));
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

function hasFundingCapability(service) {
  const metadata = parseMetadata(service?.metadata);
  const capabilities = Array.isArray(metadata.capabilities) ? metadata.capabilities : [];
  return capabilities
    .map((capability) => String(capability || '').trim())
    .includes('devnet-fund-wallet');
}

function resolveOrbkitService(bridge) {
  const state = bridge.getState();
  const orbkits = state.connectedServices.filter((service) => String(service.role || '').trim() === 'orbkit');
  if (orbkits.length === 0) {
    throw new Error('No connected orbkit service is available.');
  }
  return orbkits.find(hasFundingCapability) || orbkits[0];
}

function writeNdjson(reply, payload) {
  reply.raw.write(`${JSON.stringify(payload)}\n`);
}

function buildUserLog(event) {
  return {
    requestId: event.requestId,
    phase: event.phase,
    status: event.status,
    service: event.service,
    address: event.address,
    amountInCKB: event.amountInCKB,
    txHash: event.txHash,
    message: event.message,
    error: event.error,
    createdAt: event.createdAt,
    result: event.result,
  };
}

export function createFundingService({ bridge, devnetService, publishServiceEvent }) {
  return {
    async streamDevnetFunding({ reply, body, session }) {
      const requestId = `fund_${randomId()}`;
      const address = normalizeAddress(body?.address);
      const amountInCKB = normalizeAmount(body?.amountInCKB);
      const retryCount = normalizeRetryCount(body?.retryCount);
      const targetService = resolveOrbkitService(bridge);
      const ownerKey = String(session?.user?.uuid || session?.user?.username || 'runtime').trim() || 'runtime';

      reply.raw.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.hijack();

      writeNdjson(reply, {
        type: 'funding-started',
        requestId,
        address,
        amountInCKB,
        service: targetService.service,
        createdAt: nowIso(),
      });

      let closed = false;
      const unsubscribe = bridge.subscribeFundingEvents((event) => {
        if (!event || event.requestId !== requestId) return;
        writeNdjson(reply, {
          type: 'funding-log',
          ...buildUserLog(event),
        });
        if (event.phase === 'completed' || event.phase === 'failed') {
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

      try {
        const devnet = await devnetService.assertReachable({
          retryCount,
        });
        bridge.publishFundingEvent(null, {
          requestId,
          phase: 'devnet-check',
          status: 'running',
          address,
          amountInCKB,
          ownerKey,
          service: 'orbital-server',
          target: targetService.service,
          message: `Devnet reachable at ${devnet.rpcUrl} on attempt ${devnet.attempt}/${devnet.attempts}.`,
        }).catch(() => {
          // ignore secondary event publication failures
        });
      } catch (error) {
        bridge.publishFundingEvent(null, {
          requestId,
          phase: 'failed',
          status: 'failed',
          address,
          amountInCKB,
          ownerKey,
          service: 'orbital-server',
          target: targetService.service,
          message: 'Devnet is not reachable.',
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {
          // ignore secondary event publication failures
        });
        return;
      }

      bridge.publishFundingEvent(null, {
        requestId,
        phase: 'queued',
        status: 'queued',
        address,
        amountInCKB,
        ownerKey,
        service: 'orbital-server',
        target: targetService.service,
        message: `Queued devnet funding request for ${targetService.service}.`,
      }).catch((error) => {
        writeNdjson(reply, {
          type: 'funding-log',
          requestId,
          phase: 'failed',
          status: 'failed',
          service: 'orbital-server',
          address,
          amountInCKB,
          message: 'Failed to enqueue funding request.',
          error: error instanceof Error ? error.message : String(error),
          createdAt: nowIso(),
        });
        close();
      });

      try {
        await publishServiceEvent({
          channel: 'devnet-fund-wallet-request',
          service: 'orbital-server',
          target: targetService.service,
          direction: 'outbound',
          network: 'devnet',
          ownerKey,
          body: JSON.stringify({
            requestId,
            ownerKey,
            address,
            amountInCKB,
            retryCount,
          }),
        });
      } catch (error) {
        bridge.publishFundingEvent(null, {
          requestId,
          phase: 'failed',
          status: 'failed',
          address,
          amountInCKB,
          ownerKey,
          service: 'orbital-server',
          target: targetService.service,
          message: 'Failed to send funding request to orbkit.',
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {
          // ignore secondary publish failures
        });
      }
    },
  };
}
