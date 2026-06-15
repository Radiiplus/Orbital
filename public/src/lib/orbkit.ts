import { getStoredAccessToken, getStoredDeviceId, setDeviceCookie, setSessionCookie } from './session'
import { apiPath } from './api'

export type OrbkitConnectionStatus = {
  ok: boolean
  connected: boolean
  connectedCount: number
  service: string | null
  status: string
  updatedAt: string | null
  workspaceRoot: string | null
  configPath: string | null
  contracts: unknown[]
  services: Array<{
    service: string
    role: string
    status: string
    connectedAt: string
    updatedAt: string
    capabilities: string[]
  }>
  message?: string
}

function authHeaders() {
  const token = getStoredAccessToken()
  const deviceId = getStoredDeviceId()
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
  }
}

function refreshSessionFromResponse(response: Response) {
  const refreshedToken = response.headers.get('x-access-token')
  const refreshedDevice = response.headers.get('x-device-id')
  if (refreshedToken) setSessionCookie(refreshedToken)
  if (refreshedDevice) setDeviceCookie(refreshedDevice)
}

async function readJson<T>(response: Response): Promise<T> {
  refreshSessionFromResponse(response)
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Orbkit request failed (${response.status})`)
  }
  return payload
}

export async function fetchOrbkitStatus(signal?: AbortSignal) {
  const response = await fetch(apiPath('/orbkit/status'), {
    cache: 'no-store',
    headers: authHeaders(),
    signal,
  })
  return readJson<OrbkitConnectionStatus>(response)
}

export async function reconnectOrbkit(service?: string | null) {
  const response = await fetch(apiPath('/orbkit/reconnect'), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      ...(service ? { service } : {}),
    }),
  })
  return readJson<{
    ok: boolean
    requestId: string
    service: string
    message: string
  }>(response)
}
