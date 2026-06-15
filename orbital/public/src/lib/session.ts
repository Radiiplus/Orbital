import { apiPath } from './api'

const SESSION_COOKIE = 'oat'
const SESSION_STORAGE_KEY = 'oat'
const DEVICE_COOKIE = 'odi'
const DEVICE_STORAGE_KEY = 'odi'
const LEGACY_SESSION_COOKIE = 'orbital_access_token'
const LEGACY_DEVICE_COOKIE = 'orbital_device_id'
const LEGACY_DEVICE_STORAGE_KEY = 'orbital.deviceId'
const SESSION_COOKIE_MAX_AGE_SECONDS = 31536000 * 10
const SESSION_LOG_PREFIX = '[orbital:session]'
const SESSION_LOG_ENABLED = import.meta.env.VITE_SESSION_LOGS === 'true'

type RefreshPayload = {
  ok?: boolean
  accessToken?: string
  deviceId?: string
  message?: string
}

type RefreshResult = RefreshPayload & {
  accessToken: string
}

let pendingRefresh:
  | {
      key: string
      promise: Promise<RefreshResult>
    }
  | null = null

export const AUTH_PAGE_PATH = '/auth'
export const DASH_PAGE_PATH = '/dash'

function redactValue(value: string | null | undefined) {
  const text = String(value || '').trim()
  if (!text) return null
  if (text.length <= 10) return `${text.slice(0, 4)}...`
  return `${text.slice(0, 6)}...${text.slice(-4)}`
}

function logSession(event: string, detail: Record<string, unknown> = {}) {
  if (!SESSION_LOG_ENABLED) return
  console.info(SESSION_LOG_PREFIX, event, detail)
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function setSessionCookie(accessToken: string) {
  localStorage.setItem(SESSION_STORAGE_KEY, accessToken)
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(accessToken)}; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`
  logSession('set_session', {
    token: redactValue(accessToken),
  })
}

export function setDeviceCookie(deviceId: string) {
  localStorage.setItem(DEVICE_STORAGE_KEY, deviceId)
  document.cookie = `${DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; Max-Age=31536000; Path=/; SameSite=Lax`
  logSession('set_device', {
    deviceId: redactValue(deviceId),
  })
}

export function readCookie(name: string) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || ''
}

function clearCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`
}

export function clearStoredSession() {
  logSession('clear_session', {
    hadSessionCookie: Boolean(readCookie(SESSION_COOKIE)),
    hadSessionStorage: Boolean(localStorage.getItem(SESSION_STORAGE_KEY)),
  })
  localStorage.removeItem(SESSION_STORAGE_KEY)
  clearCookie(SESSION_COOKIE)
  clearCookie(LEGACY_SESSION_COOKIE)
}

export function getStoredAccessToken() {
  const cookieToken = readCookie(SESSION_COOKIE)
  const storageToken = localStorage.getItem(SESSION_STORAGE_KEY)
  const legacyToken = readCookie(LEGACY_SESSION_COOKIE)
  const token = cookieToken || storageToken || legacyToken
  logSession('read_token', {
    source: cookieToken ? 'cookie' : storageToken ? 'localStorage' : legacyToken ? 'legacyCookie' : 'missing',
    token: redactValue(token),
  })
  if (!readCookie(SESSION_COOKIE) && token) {
    setSessionCookie(decodeURIComponent(token))
  }
  clearCookie(LEGACY_SESSION_COOKIE)
  return token ? decodeURIComponent(token) : ''
}

export function getStoredDeviceId() {
  const storedDevice = localStorage.getItem(DEVICE_STORAGE_KEY)
  const legacyStoredDevice = localStorage.getItem(LEGACY_DEVICE_STORAGE_KEY)
  const cookieDevice = decodeURIComponent(readCookie(DEVICE_COOKIE) || readCookie(LEGACY_DEVICE_COOKIE))
  const stored = storedDevice || legacyStoredDevice || cookieDevice
  logSession('read_device', {
    source: storedDevice ? 'localStorage' : legacyStoredDevice ? 'legacyLocalStorage' : cookieDevice ? 'cookie' : 'missing',
    deviceId: redactValue(stored),
  })
  if (!stored) return ''
  if (!localStorage.getItem(DEVICE_STORAGE_KEY)) {
    localStorage.setItem(DEVICE_STORAGE_KEY, stored)
  }
  if (!readCookie(DEVICE_COOKIE)) {
    setDeviceCookie(stored)
  }
  localStorage.removeItem(LEGACY_DEVICE_STORAGE_KEY)
  clearCookie(LEGACY_DEVICE_COOKIE)
  return stored
}

export function getOrCreateDeviceId() {
  const existing = getStoredDeviceId()
  if (existing) return existing
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const deviceId = `dev_${bytesToHex(bytes)}`
  localStorage.setItem(DEVICE_STORAGE_KEY, deviceId)
  setDeviceCookie(deviceId)
  logSession('create_device', {
    deviceId: redactValue(deviceId),
  })
  return deviceId
}

export async function refreshSession(accessToken: string, deviceId: string): Promise<RefreshResult> {
  const key = `${accessToken}:${deviceId}`
  if (pendingRefresh?.key === key) {
    logSession('refresh_join_pending', {
      token: redactValue(accessToken),
      deviceId: redactValue(deviceId),
    })
    return pendingRefresh.promise
  }

  const promise = (async () => {
    logSession('refresh_start', {
      token: redactValue(accessToken),
      deviceId: redactValue(deviceId),
    })
    const response = await fetch(apiPath('/session/refresh'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'x-device-id': deviceId,
      },
      body: JSON.stringify({ deviceId }),
    })
    const payload = (await response.json().catch(() => ({}))) as RefreshPayload
    logSession(response.ok && payload?.ok ? 'refresh_response_ok' : 'refresh_response_failed', {
      status: response.status,
      ok: payload?.ok ?? null,
      returnedToken: redactValue(payload.accessToken),
      returnedDeviceId: redactValue(payload.deviceId),
      message: payload.message ?? null,
      refreshedHeader: response.headers.get('x-session-refreshed'),
      headerToken: redactValue(response.headers.get('x-access-token')),
    })
    if (!response.ok || !payload?.ok || !payload.accessToken) {
      throw new Error(payload?.message || 'Session refresh failed.')
    }
    setSessionCookie(payload.accessToken)
    if (payload.deviceId) {
      setDeviceCookie(payload.deviceId)
    }
    return payload as RefreshResult
  })()

  pendingRefresh = { key, promise }
  try {
    return await promise
  } finally {
    if (pendingRefresh?.promise === promise) {
      pendingRefresh = null
      logSession('refresh_pending_cleared', {
        token: redactValue(accessToken),
        deviceId: redactValue(deviceId),
      })
    }
  }
}
