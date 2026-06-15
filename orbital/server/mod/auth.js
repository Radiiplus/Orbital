function parseBearerToken(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export function createAuthService(options = {}) {
  const sessions = options.sessions || null;
  const db = options.db || null;
  const internalOrbkitApiKey = String(options.orbkitApiKey || process.env.ORBKIT_API_KEY || 'orbkit-dev-key').trim();

  async function resolveOrbkitUserFromToken(token) {
    if (!db) return null;
    try {
      // Look up the user by their API key directly from the database
      // This validates that the API key belongs to an actual user
      const user = db.findUserByHelperApiKey(token);
      if (user) {
        return user;
      }
      return null;
    } catch {
      return null;
    }
  }

  return {
    getBearerToken(headers = {}) {
      return parseBearerToken(headers.authorization || headers.Authorization || '');
    },
    async requireOrbkitAuth(headers = {}) {
      const token = this.getBearerToken(headers);
      if (!token) {
        throw new Error('Unauthorized orbkit client.');
      }

      // Validate the API key exists in the database
      const user = await resolveOrbkitUserFromToken(token);
      if (user) {
        return {
          role: 'orbkit',
          token,
          user,
        };
      }

      // Allow a server-internal ORBKIT API key to authenticate for service-to-service calls
      if (internalOrbkitApiKey && token === internalOrbkitApiKey) {
        return {
          role: 'internal',
          token,
          user: null,
        };
      }

      throw new Error('Unauthorized orbkit client. Invalid API key.');
    },
  };
}
