import {
  getStoredAccessToken,
  getStoredDeviceId,
  setDeviceCookie,
  setSessionCookie,
} from './session'
import { loadAccountBalances, type Network } from './wallets'
import { apiPath } from './api'

type SessionPayload = {
  ok?: boolean
  accessToken?: string
  deviceId?: string
  user?: {
    username?: string | null
  }
}

async function readSessionUsername() {
  const accessToken = getStoredAccessToken()
  const deviceId = getStoredDeviceId()
  if (!accessToken || !deviceId) return ''

  const response = await fetch(apiPath('/session'), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-device-id': deviceId,
    },
  })
  const refreshedToken = response.headers.get('x-access-token')
  if (refreshedToken) {
    setSessionCookie(refreshedToken)
  }
  const payload = (await response.json().catch(() => ({}))) as SessionPayload
  if (!response.ok || payload.ok !== true) {
    throw new Error('Could not read active session.')
  }
  if (payload.accessToken) {
    setSessionCookie(payload.accessToken)
  }
  if (payload.deviceId) {
    setDeviceCookie(payload.deviceId)
  }
  return payload.user?.username?.trim() ?? ''
}

export async function fetchWalletBalances(addresses: string[], network: Network): Promise<Record<string, number>> {
  if (addresses.length === 0) return {}

  const username = await readSessionUsername()
  if (!username) return {}

  const balances = await loadAccountBalances(username)
  return Object.fromEntries(
    addresses.map((address) => [
      address,
      balances.get(`${network}:${address}`) ?? 0,
    ]),
  )
}
