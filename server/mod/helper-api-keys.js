function normalizeUsername(username) {
  const value = String(username || '').trim().toLowerCase();
  if (!value) {
    throw new Error('username is required.');
  }
  return value;
}

function applySessionRefresh(reply, session) {
  if (!reply?.raw || !session?.refreshed || !session?.token) return;
  reply.raw.setHeader('x-access-token', session.token);
  reply.raw.setHeader('x-session-refreshed', '1');
}

export function createHelperApiKeyService({ db, walletAccessService }) {
  function resolveAuthorizedUser(auth = {}) {
    const session = walletAccessService.resolveSession({
      headers: auth.headers || {},
      accessToken: auth.accessToken,
      deviceId: auth.deviceId,
    });
    if (!session?.user?.uuid) {
      throw new Error('Invalid session.');
    }
    const user = db.getUserByUuid(session.user.uuid);
    if (!user) {
      throw new Error('User not found for session.');
    }
    applySessionRefresh(auth.reply, session);
    return { user, session };
  }

  return {
    getHelperApiKey(input = {}, auth = {}) {
      const { user } = resolveAuthorizedUser(auth);
      return db.getHelperApiKey(user.username);
    },
    createHelperApiKey(input = {}, auth = {}) {
      const { user } = resolveAuthorizedUser(auth);
      return db.createHelperApiKey(user.username);
    },
  };
}
