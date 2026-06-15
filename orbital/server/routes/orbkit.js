function getBearerToken(headers = {}) {
  const value = String(headers.authorization || headers.Authorization || '').trim();
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
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

function orbkitServices(fastify) {
  return fastify.serviceBridge.getState().connectedServices
    .filter((service) => String(service.role || '').trim() === 'orbkit')
    .map((service) => ({
      ...service,
      parsedMetadata: parseMetadata(service.metadata),
    }));
}

function requireSession(fastify, request, reply) {
  const token = getBearerToken(request.headers);
  if (!token) {
    reply.code(401);
    return null;
  }

  try {
    const session = fastify.walletAccessService.resolveSession({
      headers: request.headers,
    });
    if (!session?.user?.username) {
      reply.code(401);
      return null;
    }
    return session;
  } catch {
    reply.code(401);
    return null;
  }
}

export default async function orbkitRoutes(fastify) {
  fastify.get('/orbkit/status', async (request, reply) => {
    const session = requireSession(fastify, request, reply);
    if (!session) {
      return {
        ok: false,
        connected: false,
        message: 'Authentication required',
      };
    }

    const services = orbkitServices(fastify);
    const primary = services[0] || null;
    return {
      ok: true,
      connected: services.length > 0,
      connectedCount: services.length,
      service: primary?.service || null,
      status: primary?.status || 'offline',
      updatedAt: primary?.updatedAt || null,
      workspaceRoot: primary?.parsedMetadata?.workspaceRoot || null,
      configPath: primary?.parsedMetadata?.configPath || null,
      contracts: primary?.parsedMetadata?.contracts || [],
      services: services.map((service) => ({
        service: service.service,
        role: service.role,
        status: service.status,
        connectedAt: service.connectedAt,
        updatedAt: service.updatedAt,
        capabilities: Array.isArray(service.parsedMetadata.capabilities)
          ? service.parsedMetadata.capabilities
          : [],
      })),
    };
  });

  fastify.post('/orbkit/reconnect', async (request, reply) => {
    const session = requireSession(fastify, request, reply);
    if (!session) {
      return {
        ok: false,
        message: 'Authentication required',
      };
    }

    const requestedService = String(request.body?.service || request.query?.service || '').trim();
    const services = orbkitServices(fastify);
    const targetService = requestedService
      ? services.find((service) => service.service === requestedService)
      : services[0];

    if (!targetService) {
      reply.code(503);
      return {
        ok: false,
        connected: false,
        message: 'No connected orbkit runtime is available to reconnect.',
      };
    }

    const requestId = `orbkit_reconnect_${Math.random().toString(36).slice(2, 10)}`;
    const event = await fastify.internalPublishServiceEvent({
      channel: 'orbkit-control',
      service: 'orbital-server',
      target: targetService.service,
      direction: 'outbound',
      body: JSON.stringify({
        requestId,
        command: 'reconnect',
        username: session.user.username,
        reason: 'manual-ui',
        createdAt: new Date().toISOString(),
      }),
    });

    return {
      ok: true,
      requestId,
      service: targetService.service,
      event,
      message: `Reconnect requested for ${targetService.service}.`,
    };
  });
}
