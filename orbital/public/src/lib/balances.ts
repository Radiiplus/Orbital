import {
  getStoredAccessToken,
  getStoredDeviceId,
  setDeviceCookie,
  setSessionCookie,
} from './session'
import { loadAccountBalances, type Network } from './wallets'
import { apiPath } from './api'
import { parseAddress } from '@ckb-lumos/helpers'
import { predefined } from '@ckb-lumos/config-manager'

type SessionPayload = {
  ok?: boolean
  accessToken?: string
  deviceId?: string
  user?: {
    username?: string | null
  }
}

type CkbScript = {
  codeHash: string
  hashType: string
  args: string
}

type RpcCell = {
  output?: {
    capacity?: string
  }
  cell_output?: {
    capacity?: string
  }
  output_data?: string
  data?: string
}

type RpcCellsResult = {
  objects?: RpcCell[]
  last_cursor?: string
}

const PUBLIC_RPC_URLS: Record<Exclude<Network, 'devnet'>, string> = {
  testnet: import.meta.env.VITE_CKB_TESTNET_RPC_URL || 'https://testnet.ckb.dev/rpc',
  mainnet: import.meta.env.VITE_CKB_MAINNET_RPC_URL || 'https://mainnet.ckb.dev/rpc',
}

const LUMOS_CONFIG_BY_NETWORK = {
  testnet: predefined.AGGRON4,
  mainnet: predefined.LINA,
} as const

function configForAddress(address: string, network: Exclude<Network, 'devnet'>) {
  const lower = address.toLowerCase()
  if (lower.startsWith('ckb1')) return predefined.LINA
  if (lower.startsWith('ckt1')) return predefined.AGGRON4
  return LUMOS_CONFIG_BY_NETWORK[network]
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

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    result?: T
    error?: { message?: string }
  }
  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error(payload.error?.message || `RPC request failed (${response.status})`)
  }
  return payload.result
}

function toRpcScript(script: CkbScript) {
  return {
    code_hash: script.codeHash,
    hash_type: script.hashType,
    args: script.args,
  }
}

async function fetchPublicNetworkBalance(address: string, network: Exclude<Network, 'devnet'>): Promise<number | null> {
  const config = configForAddress(address, network)
  const script = parseAddress(address, { config }) as CkbScript
  const rpcUrl = PUBLIC_RPC_URLS[network]
  const pageLimit = 100
  const maxPages = 8
  let afterCursor: string | null = null
  let totalShannons = 0n
  const seenCursors = new Set<string>()

  for (let page = 0; page < maxPages; page += 1) {
    const result: RpcCellsResult = await rpcCall<RpcCellsResult>(rpcUrl, 'get_cells', [
      {
        script: toRpcScript(script),
        script_type: 'lock',
      },
      'asc',
      `0x${pageLimit.toString(16)}`,
      afterCursor,
    ])

    const cells = Array.isArray(result.objects) ? result.objects : []
    for (const cell of cells) {
      const capacity = cell.output?.capacity || cell.cell_output?.capacity
      if (capacity) totalShannons += BigInt(capacity)
    }

    if (cells.length < pageLimit) break
    const cursor: string = typeof result.last_cursor === 'string' ? result.last_cursor : ''
    if (!cursor || seenCursors.has(cursor)) break
    seenCursors.add(cursor)
    afterCursor = cursor
  }

  return Number(totalShannons) / 100000000
}

export async function fetchPublicNetworkBalances(addresses: string[], network: Network): Promise<Record<string, number>> {
  if (network === 'devnet' || addresses.length === 0) return {}

  const entries = await Promise.all(
    addresses.map(async (address) => {
      try {
        const balance = await fetchPublicNetworkBalance(address, network)
        return balance === null ? null : [address, balance] as const
      } catch {
        return null
      }
    }),
  )

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, number] => Boolean(entry)))
}

export async function fetchWalletBalances(addresses: string[], network: Network): Promise<Record<string, number>> {
  if (addresses.length === 0) return {}

  if (network !== 'devnet') {
    return fetchPublicNetworkBalances(addresses, network)
  }

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
