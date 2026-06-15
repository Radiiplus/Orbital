function applySessionRefresh(reply, session) {
  if (!reply?.raw || !session?.refreshed || !session?.token) return;
  reply.raw.setHeader('x-access-token', session.token);
  reply.raw.setHeader('x-session-refreshed', '1');
}

function redactValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= 10) return `${text.slice(0, 4)}...`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function getBearerToken(headers = {}) {
  const value = String(headers.authorization || headers.Authorization || '').trim();
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

function getDeviceId(input = {}) {
  return String(
    input.deviceId
    || input.headers?.['x-device-id']
    || input.headers?.['X-Device-Id']
    || '',
  ).trim();
}

export function createSessionInfoService({ walletAccessService, logger }) {
  function logSessionInfo(level, event, context = {}) {
    const method = logger?.[level];
    if (typeof method !== 'function') return;
    method.call(logger, {
      area: 'session-info',
      event,
      ...context,
    }, 'session info event');
  }

  return {
    getSession({ headers = {}, reply } = {}) {
      const token = getBearerToken(headers);
      const deviceId = getDeviceId({ headers });
      logSessionInfo('info', 'get_session_start', {
        token: redactValue(token),
        deviceId: redactValue(deviceId),
      });
      const session = walletAccessService.resolveSession({
        headers,
        deviceId,
      });
      applySessionRefresh(reply, session);
      logSessionInfo('info', 'get_session_ok', {
        token: redactValue(token),
        returnedToken: redactValue(session.token),
        deviceId: redactValue(session.deviceId || deviceId),
        refreshed: Boolean(session.refreshed),
        username: session.user?.username ?? null,
        expiresInMs: Number(session.expiresAt || 0) - Date.now(),
      });
      return {
        ok: true,
        accessToken: session.token,
        deviceId: session.deviceId || null,
        expiresAt: session.expiresAt,
        refreshed: Boolean(session.refreshed),
        user: {
          username: session.user?.username ?? null,
          api: session.user?.api ?? null,
        },
      };
    },
    refreshSession({ headers = {}, body = {}, reply } = {}) {
      const token = getBearerToken(headers) || String(body?.accessToken || '').trim();
      const deviceId = getDeviceId({ headers, deviceId: body?.deviceId });
      logSessionInfo('info', 'refresh_session_start', {
        token: redactValue(token),
        deviceId: redactValue(deviceId),
      });
      const session = walletAccessService.refreshSession({
        accessToken: token,
        deviceId,
      });
      applySessionRefresh(reply, session);
      logSessionInfo('info', 'refresh_session_ok', {
        token: redactValue(token),
        returnedToken: redactValue(session.token),
        deviceId: redactValue(session.deviceId || deviceId),
        refreshed: Boolean(session.refreshed),
        username: session.user?.username ?? null,
        expiresInMs: Number(session.expiresAt || 0) - Date.now(),
      });
      return {
        ok: true,
        accessToken: session.token,
        deviceId: session.deviceId || deviceId,
        expiresAt: session.expiresAt,
        refreshed: Boolean(session.refreshed),
        user: {
          username: session.user?.username ?? null,
          api: session.user?.api ?? null,
        },
      };
    },
  };
}
