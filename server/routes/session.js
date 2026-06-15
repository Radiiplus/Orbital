export default async function sessionRoutes(fastify) {
  fastify.get('/session', async (request, reply) => {
    try {
      return fastify.sessionInfoService.getSession({
        headers: request.headers,
        reply,
      });
    } catch (error) {
      fastify.log.warn({
        area: 'session-route',
        event: 'get_session_failed',
        message: error instanceof Error ? error.message : String(error),
      }, 'session route failed');
      throw error;
    }
  });

  fastify.post('/session/refresh', async (request, reply) => {
    try {
      return fastify.sessionInfoService.refreshSession({
        headers: request.headers,
        body: request.body || {},
        reply,
      });
    } catch (error) {
      fastify.log.warn({
        area: 'session-route',
        event: 'refresh_session_failed',
        message: error instanceof Error ? error.message : String(error),
      }, 'session route failed');
      throw error;
    }
  });
}
