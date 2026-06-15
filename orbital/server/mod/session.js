function randomToken() {
  return `sess_${Math.random().toString(36).slice(2, 12)}`;
}

function nowMs() {
  return Date.now();
}

function cloneUser(user) {
  return user ? { ...user } : null;
}

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  if (!deviceId) return '';
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(deviceId)) {
    throw new Error('deviceId must be an 8 to 128 character device identifier.');
  }
  return deviceId;
}

function cloneSession(session) {
  if (!session) return null;
  return {
    ...session,
    user: cloneUser(session.user),
  };
}

function redactValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= 10) return `${text.slice(0, 4)}...`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function describeSession(session) {
  if (!session) return null;
  const expiresAt = Number(session.expiresAt || 0);
  return {
    uuid: redactValue(session.uuid),
    token: redactValue(session.token),
    deviceId: redactValue(session.deviceId),
    username: session.user?.username ?? null,
    expiresAt: expiresAt || null,
    expiresInMs: expiresAt ? expiresAt - nowMs() : null,
  };
}

export function createSessionManager({ db, ttlMs = 15 * 60 * 1000, rotationAliasTtlMs = 60 * 1000, logger } = {}) {
  const sessionsByToken = new Map();
  const sessionsByUuid = new Map();
  const rotatedTokenAliases = new Map();

  function logSession(level, event, context = {}) {
    const method = logger?.[level];
    if (typeof method !== 'function') return;
    method.call(logger, {
      area: 'session-manager',
      event,
      ...context,
    }, 'session event');
  }

  function pruneRotatedTokenAliases() {
    const now = nowMs();
    let pruned = 0;
    for (const [token, alias] of rotatedTokenAliases) {
      if (!alias?.expiresAt || alias.expiresAt <= now) {
        rotatedTokenAliases.delete(token);
        pruned += 1;
      }
    }
    if (pruned > 0) {
      logSession('info', 'rotation_aliases_pruned', {
        pruned,
        remaining: rotatedTokenAliases.size,
      });
    }
  }

  function rememberRotatedToken(previousToken, session) {
    const value = String(previousToken || '').trim();
    if (!value || !session?.token) return;
    pruneRotatedTokenAliases();
    const expiresAt = nowMs() + rotationAliasTtlMs;
    for (const [token, alias] of rotatedTokenAliases) {
      if (alias?.token === value) {
        rotatedTokenAliases.set(token, {
          token: session.token,
          expiresAt: alias.expiresAt,
        });
      }
    }
    rotatedTokenAliases.set(value, {
      token: session.token,
      expiresAt,
    });
    logSession('info', 'rotation_alias_remembered', {
      previousToken: redactValue(value),
      nextToken: redactValue(session.token),
      aliasExpiresInMs: expiresAt - nowMs(),
      aliases: rotatedTokenAliases.size,
      session: describeSession(session),
    });
  }

  function resolveRotatedTokenAlias(token, options = {}, { requireDevice = false } = {}) {
    const value = String(token || '').trim();
    if (!value) return null;
    pruneRotatedTokenAliases();
    const alias = rotatedTokenAliases.get(value);
    if (!alias?.token) return null;
    const session = sessionsByToken.get(alias.token);
    if (!session) {
      rotatedTokenAliases.delete(value);
      logSession('warn', 'rotation_alias_missing_session', {
        previousToken: redactValue(value),
        aliasedToken: redactValue(alias.token),
      });
      return null;
    }
    assertDevice(session, options.deviceId, { require: requireDevice || Boolean(session.deviceId) });
    logSession('info', 'rotation_alias_resolved', {
      previousToken: redactValue(value),
      deviceId: redactValue(options.deviceId),
      session: describeSession(session),
    });
    return {
      ...cloneSession(session),
      refreshed: true,
      previousToken: value,
    };
  }

  function loadSessionByToken(token) {
    const value = String(token || '').trim();
    if (!value) return null;
    let session = sessionsByToken.get(value);
    if (session) {
      logSession('info', 'token_cache_hit', {
        token: redactValue(value),
        session: describeSession(session),
      });
    }
    if (!session && db?.getSessionByToken) {
      const fromDb = db.getSessionByToken(value);
      if (fromDb?.uuid && fromDb?.token) {
        session = {
          uuid: String(fromDb.uuid).trim(),
          token: String(fromDb.token).trim(),
          deviceId: normalizeDeviceId(fromDb.deviceId),
          expiresAt: Number(fromDb.expiresAt || 0),
          createdAt: fromDb.createdAt || new Date().toISOString(),
          updatedAt: fromDb.updatedAt || new Date().toISOString(),
          user: cloneUser(fromDb.user),
        };
        setSession(session);
        logSession('info', 'token_db_rehydrated', {
          token: redactValue(value),
          session: describeSession(session),
        });
      }
    }
    if (!session) {
      logSession('warn', 'token_not_found', {
        token: redactValue(value),
      });
    }
    return session;
  }

  function hydrateFromDb() {
    sessionsByToken.clear();
    sessionsByUuid.clear();
    rotatedTokenAliases.clear();
    if (!db?.listSessions) return;
    for (const record of db.listSessions()) {
      if (!record?.token || !record?.uuid) continue;
      const session = {
        uuid: String(record.uuid).trim(),
        token: String(record.token).trim(),
        deviceId: normalizeDeviceId(record.deviceId),
        expiresAt: Number(record.expiresAt || 0),
        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: record.updatedAt || new Date().toISOString(),
        user: cloneUser(record.user),
      };
      sessionsByToken.set(session.token, session);
      sessionsByUuid.set(session.uuid, session);
    }
    logSession('info', 'hydrate_from_db', {
      sessions: sessionsByToken.size,
    });
  }

  function persist(session) {
    if (!db?.upsertSession) return;
    db.upsertSession({
      uuid: session.uuid,
      token: session.token,
      deviceId: session.deviceId || null,
      expiresAt: session.expiresAt,
      user: cloneUser(session.user),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  }

  function setSession(session) {
    const previous = sessionsByUuid.get(session.uuid);
    if (previous?.token && previous.token !== session.token) {
      sessionsByToken.delete(previous.token);
    }
    sessionsByUuid.set(session.uuid, session);
    sessionsByToken.set(session.token, session);
    persist(session);
    return session;
  }

  function assertDevice(session, deviceId, { require = false } = {}) {
    const expected = normalizeDeviceId(session?.deviceId);
    const actual = normalizeDeviceId(deviceId);
    if (require && !actual) {
      throw new Error('deviceId is required to refresh this session.');
    }
    if (expected && actual && expected !== actual) {
      throw new Error('deviceId does not match this session.');
    }
    if (expected && require && !actual) {
      throw new Error('deviceId is required to refresh this session.');
    }
    return expected || actual || '';
  }

  function buildSession(user, { token = randomToken(), deviceId } = {}) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
      throw new Error('deviceId is required.');
    }
    const iso = new Date().toISOString();
    return {
      uuid: String(user.uuid || '').trim(),
      token,
      deviceId: normalizedDeviceId,
      expiresAt: nowMs() + ttlMs,
      createdAt: iso,
      updatedAt: iso,
      user: {
        uuid: user.uuid,
        username: user.username ?? null,
        api: user.api ?? null,
      },
    };
  }

  function rotateSession(existing, options = {}) {
    const deviceId = assertDevice(existing, options.deviceId, {
      require: Boolean(existing.deviceId),
    });
    const previousToken = existing.token;
    const next = {
      ...existing,
      token: randomToken(),
      deviceId: existing.deviceId || deviceId || null,
      expiresAt: nowMs() + ttlMs,
      updatedAt: new Date().toISOString(),
    };
    sessionsByToken.delete(previousToken);
    const rotated = setSession(next);
    rememberRotatedToken(previousToken, rotated);
    logSession('info', 'session_rotated', {
      previousToken: redactValue(previousToken),
      nextToken: redactValue(rotated.token),
      deviceId: redactValue(deviceId),
      session: describeSession(rotated),
    });
    return rotated;
  }

  hydrateFromDb();

  return {
    rehydrateFromDb() {
      hydrateFromDb();
      return {
        sessionCount: sessionsByToken.size,
      };
    },
    getSessionSnapshotByUuid(uuid) {
      const session = sessionsByUuid.get(String(uuid || '').trim());
      return cloneSession(session);
    },
    upsertCachedSession(input = {}) {
      const uuid = String(input.uuid || '').trim();
      const token = String(input.token || '').trim();
      if (!uuid || !token) {
        throw new Error('uuid and token are required.');
      }
      const existing = sessionsByUuid.get(uuid);
      const session = {
        ...(existing || {}),
        uuid,
        token,
        deviceId: normalizeDeviceId(input.deviceId || existing?.deviceId),
        expiresAt: Number(input.expiresAt || existing?.expiresAt || (nowMs() + ttlMs)),
        createdAt: input.createdAt || existing?.createdAt || new Date().toISOString(),
        updatedAt: input.updatedAt || new Date().toISOString(),
        user: cloneUser(input.user || existing?.user),
      };
      return cloneSession(setSession(session));
    },
    validateToken(token, options = {}) {
      const value = String(token || '').trim();
      if (!value) return null;
      logSession('info', 'validate_start', {
        token: redactValue(value),
        deviceId: redactValue(options.deviceId),
      });
      let session = loadSessionByToken(value);
      if (!session) return resolveRotatedTokenAlias(value, options);
      if (!session) return null;
      assertDevice(session, options.deviceId);
      if (session.expiresAt <= nowMs()) {
        logSession('info', 'validate_expired_rotating', {
          token: redactValue(value),
          deviceId: redactValue(options.deviceId),
          session: describeSession(session),
        });
        const rotated = rotateSession(session, options);
        return {
          ...cloneSession(rotated),
          refreshed: true,
          previousToken: value,
        };
      }
      logSession('info', 'validate_ok', {
        token: redactValue(value),
        deviceId: redactValue(options.deviceId),
        session: describeSession(session),
      });
      return {
        ...cloneSession(session),
        refreshed: false,
        previousToken: null,
      };
    },
    refreshToken(token, options = {}) {
      const value = String(token || '').trim();
      if (!value) return null;
      logSession('info', 'refresh_start', {
        token: redactValue(value),
        deviceId: redactValue(options.deviceId),
      });
      let session = loadSessionByToken(value);
      if (!session) {
        return resolveRotatedTokenAlias(value, options, { requireDevice: true });
      }
      if (!session) return null;
      assertDevice(session, options.deviceId, { require: true });
      if (session.expiresAt <= nowMs()) {
        logSession('info', 'refresh_expired_rotating', {
          token: redactValue(value),
          deviceId: redactValue(options.deviceId),
          session: describeSession(session),
        });
        const rotated = rotateSession(session, options);
        return {
          ...cloneSession(rotated),
          refreshed: true,
          previousToken: value,
        };
      }
      logSession('info', 'refresh_ok_existing_token', {
        token: redactValue(value),
        deviceId: redactValue(options.deviceId),
        session: describeSession(session),
      });
      return {
        ...cloneSession(session),
        refreshed: false,
        previousToken: null,
      };
    },
    createSession(user, options = {}) {
      const deviceId = normalizeDeviceId(options.deviceId);
      if (!deviceId) {
        throw new Error('deviceId is required.');
      }
      const existing = sessionsByUuid.get(String(user?.uuid || '').trim());
      const session = existing
        ? {
            ...existing,
            token: randomToken(),
            deviceId,
            expiresAt: nowMs() + ttlMs,
            updatedAt: new Date().toISOString(),
            user: {
              uuid: user.uuid,
              username: user.username ?? null,
              api: user.api ?? null,
            },
          }
        : buildSession(user, { deviceId });
      logSession('info', 'session_created', {
        reusedExistingSession: Boolean(existing),
        deviceId: redactValue(deviceId),
        session: describeSession(session),
      });
      return cloneSession(setSession(session));
    },
  };
}
