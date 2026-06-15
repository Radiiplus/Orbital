function getBearerToken(headers = {}) {
  const value = String(headers.authorization || headers.Authorization || '').trim();
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

export default async function fundingRoutes(fastify) {
  fastify.post('/wallets/devnet/fund', async (request, reply) => {
    // Validate user is authenticated
    const token = getBearerToken(request.headers);
    if (!token) {
      reply.code(401);
      return {
        ok: false,
        message: 'Authentication required',
        error: 'Missing authorization token',
      };
    }

    let session;
    try {
      session = fastify.walletAccessService.resolveSession({
        headers: request.headers,
      });
    } catch (error) {
      reply.code(401);
      return {
        ok: false,
        message: 'Invalid or expired session',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!session?.user?.username) {
      reply.code(401);
      return {
        ok: false,
        message: 'Invalid session',
      };
    }

    // Stream the funding request through the service
    // The funding service will validate the wallet address and process the request
    try {
      return await fastify.fundingService.streamDevnetFunding({
        reply,
        body: request.body || {},
        session,
      });
    } catch (error) {
      fastify.log.error({
        area: 'funding-route',
        error: error instanceof Error ? error.message : String(error),
      });
      reply.code(500);
      return {
        ok: false,
        message: 'Funding request failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
