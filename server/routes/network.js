function toRetryCount(value) {
  const count = Number(value || 1);
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(5, Math.floor(count)));
}

function getBearerToken(headers = {}) {
  const value = String(headers.authorization || headers.Authorization || '').trim();
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

export default async function networkRoutes(fastify) {
  // NEW: Check if devnet is available through an authenticated orbkit connection
  fastify.get('/networks/devnet/status', async (request, reply) => {
    try {
      // Validate user is authenticated
      const token = getBearerToken(request.headers);
      if (!token) {
        reply.code(401);
        return {
          ok: false,
          network: 'devnet',
          message: 'Authentication required',
        };
      }

      const session = fastify.walletAccessService.resolveSession({
        headers: request.headers,
      });

      if (!session?.user?.username) {
        reply.code(401);
        return {
          ok: false,
          network: 'devnet',
          message: 'Invalid or expired session',
        };
      }

      // Check if orbkit service is connected to the backend
      const state = fastify.serviceBridge.getState();
      const orbkits = state.connectedServices.filter(
        (service) => String(service.role || '').trim() === 'orbkit',
      );

      if (orbkits.length === 0) {
        reply.code(503);
        return {
          ok: false,
          network: 'devnet',
          message: 'Devnet service (orbkit) is not connected',
          reachableAt: new Date().toISOString(),
        };
      }

      // Devnet is available through connected orbkit
      return {
        ok: true,
        network: 'devnet',
        message: 'Devnet is reachable through connected orbkit service',
        orbkitService: orbkits[0].service,
        username: session.user.username,
        reachableAt: new Date().toISOString(),
      };
    } catch (error) {
      fastify.log.error({
        area: 'network-status-route',
        error: error instanceof Error ? error.message : String(error),
      });
      reply.code(500);
      return {
        ok: false,
        network: 'devnet',
        message: 'Failed to check devnet status',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // LEGACY: Direct ping endpoint (kept for backward compatibility)
  // Note: This makes direct RPC calls and won't work for hosted frontends
  fastify.get('/networks/devnet/ping', async (request, reply) => {
    try {
      const result = await fastify.devnetService.assertReachable({
        retryCount: toRetryCount(request.query?.retryCount),
      });
      return {
        ok: true,
        network: 'devnet',
        rpcUrl: result.rpcUrl,
        attempt: result.attempt,
        attempts: result.attempts,
      };
    } catch (error) {
      reply.code(503);
      return {
        ok: false,
        network: 'devnet',
        message: 'Devnet is not reachable through the backend.',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
