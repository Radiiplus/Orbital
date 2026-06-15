export default async function walletRoutes(fastify) {
  async function ensureDbReady() {
    if (typeof fastify.db?.ready === 'function') {
      await fastify.db.ready();
    }
  }

  fastify.post('/wallets/export/mnemonic', async (request, reply) => {
    try {
      await ensureDbReady();
      return fastify.accountWalletService.exportWalletMnemonic(request.body || {}, {
        headers: request.headers,
        reply,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mnemonic export failed.';
      const statusCode = /accessToken|Invalid access token|session|restricted/i.test(message) ? 401 : 400;
      return reply.code(statusCode).send({ ok: false, message });
    }
  });
}
