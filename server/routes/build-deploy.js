export default async function buildDeployRoutes(fastify) {
  function optionalSession(request) {
    try {
      return fastify.walletAccessService.resolveSession({
        headers: request.headers,
      });
    } catch {
      return null;
    }
  }

  fastify.get('/contracts/deployments/latest', async (request) => (
    fastify.buildDeployService.latestDeployment({
      query: request.query,
      session: optionalSession(request),
    })
  ));

  fastify.post('/contracts/build', async (request, reply) => (
    fastify.buildDeployService.streamBuild({
      reply,
      body: {
        ...request.body,
        headers: request.headers,
      },
    })
  ));

  fastify.post('/contracts/deploy', async (request, reply) => (
    fastify.buildDeployService.streamDeploy({
      reply,
      body: {
        ...request.body,
        headers: request.headers,
      },
    })
  ));

  fastify.post('/contracts/deploy/broadcast', async (request, reply) => (
    fastify.buildDeployService.broadcastSignedDeploy({
      reply,
      body: {
        ...request.body,
        headers: request.headers,
      },
    })
  ));

  fastify.post('/contracts/deploy/simulate', async (request, reply) => (
    fastify.deploySimService.simulate({
      reply,
      body: {
        ...request.body,
        headers: request.headers,
      },
    })
  ));
}
