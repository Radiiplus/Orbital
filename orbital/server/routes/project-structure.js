export default async function projectStructureRoutes(fastify) {
  function optionalSession(request) {
    try {
      return fastify.walletAccessService.resolveSession({
        headers: request.headers,
      });
    } catch {
      return null;
    }
  }

  fastify.post('/projects/structure/sync', async (request) => (
    fastify.projectStructureService.syncProjectStructure({
      body: request.body,
      session: optionalSession(request),
    })
  ));

  fastify.post('/projects/structure/live', async (request) => (
    fastify.projectStructureService.configureLiveSync({
      body: request.body,
      session: optionalSession(request),
    })
  ));

  fastify.get('/projects/structure/latest', async (request) => (
    fastify.projectStructureService.latestProjectStructure({
      query: request.query,
      session: optionalSession(request),
    })
  ));

  fastify.get('/projects/structure/stream', async (request, reply) => (
    fastify.projectStructureService.streamProjectStructure({
      reply,
      query: request.query,
      session: optionalSession(request),
    })
  ));
}
