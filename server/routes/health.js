export default async function healthRoutes(fastify) {
  fastify.get('/health', async () => ({
    ok: true,
    service: 'orbital',
  }));
}
