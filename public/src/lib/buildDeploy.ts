import { getStoredAccessToken, getStoredDeviceId, setDeviceCookie, setSessionCookie } from './session'
import type { Network } from './wallets'
import { apiPath } from './api'

export type BuildDeployAction = 'build' | 'deploy'

export type BuildDeployEvent = {
  type?: string
  requestId?: string
  action?: BuildDeployAction | string
  phase?: string
  status?: string
  service?: string
  target?: string | null
  network?: Network | string | null
  contractPath?: string | null
  scriptName?: string | null
  message?: string
  error?: string | null
  result?: BuildDeployResult | string | null
  build?: boolean
  deployKind?: string
  deployAddress?: string | null
  createdAt?: string
}

export type BuildDeployResult = {
    ok?: boolean
    action?: string
    network?: string
    concurrency?: number
    contractsSource?: string
    results?: Array<{
      scriptName?: string
      contractPath?: string
      binaryPath?: string
    }>
    binaryPath?: string | null
    binaryBytes?: number | null
    deployKind?: string | null
    address?: string | null
    deployAddress?: string | null
    sponsored?: boolean
    sponsorMode?: string | null
    sponsorAddress?: string | null
    sponsorSigningEntryCount?: number | null
    signingEntryCount?: number | null
    signingEntries?: Array<{ type?: string; index?: number; message?: string }>
    unsignedTx?: unknown
    txHash?: string | null
    walletAddress?: string | null
    walletBalance?: string | number | null
    balanceRefreshed?: boolean
    balanceRefreshAttempts?: number
    scriptConfig?: Record<string, unknown> | null
    typeId?: string | null
    typeScript?: Record<string, unknown> | null
    deployMode?: string | null
    redeploy?: boolean
    broadcast?: unknown
    deployment?: DeploymentSummary | null
    hint?: string | null
    error?: string | null
}

export type DeployEstimate = {
  ok?: boolean
  contractPath: string
  network: Network | string
  scriptName?: string
  binaryPath: string | null
  binaryBytes?: number | null
  binarySizeBytes: number | null
  deployKind?: string | null
  cells?: {
    inputCount: number | null
    outputCount: number
    codeCellCount: number
    changeCellCount: number
  }
  capacity?: {
    codeCellCkb: number | null
    codeCellShannons?: string
    codeCellBytes?: number
    changeCellCkb: number
    changeCellShannons?: string
    feeCkb: number
    safetyBufferCkb: number
    estimatedTotalCkb: number | null
    estimatedTotalShannons?: string
  }
  requiredCapacity?: {
    requestedCkb: number | null
    estimatedMinimumCkb: number | null
    adjustedRequiredCkb: number
    autoOverheadApplied: boolean
    autoOverheadCkb: number
  }
  note?: string
  fee?: {
    feeCkb?: string | number
    feeShannons?: string
    txSizeBytes?: number
    txWeight?: number
  }
  simulatedFee?: {
    ok: boolean
    feeCkb: number
    feeShannons: string
    txSizeBytes: number
    txWeight: number
  } | null
  deployWallet?: {
    username: string
    address: string
    network: Network
  }
}

export type DeploymentSummary = {
  contractName: string
  contractPath: string
  scriptName?: string | null
  network: string
  walletAddress: string | null
  walletLabel: string | null
  service: string | null
  txHash: string | null
  deployAddress: string | null
  binaryBytes: number | null
  binaryPath: string | null
  deployKind: string | null
  sponsored: boolean
  sponsorMode: string | null
  sponsorAddress: string | null
  scriptConfig: Record<string, unknown> | null
  typeId: string | null
  typeScript?: Record<string, unknown> | null
  deployMode?: string | null
  redeploy?: boolean
  deployedAt: string
  source?: string | null
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

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { message?: string; error?: string }
  return payload.message || payload.error || `Build request failed (${response.status})`
}

function normalizeEvent(event: BuildDeployEvent): BuildDeployEvent {
  if (typeof event.result !== 'string') return event
  try {
    return {
      ...event,
      result: JSON.parse(event.result) as BuildDeployResult,
    }
  } catch {
    return event
  }
}

export function eventResult(event?: BuildDeployEvent | null): BuildDeployResult | null {
  if (!event?.result) return null
  if (typeof event.result === 'string') {
    try {
      return JSON.parse(event.result) as BuildDeployResult
    } catch {
      return null
    }
  }
  return event.result
}

async function readNdjsonStream(response: Response, onEvent: (event: BuildDeployEvent) => void) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Build stream did not include a response body.')

  const decoder = new TextDecoder()
  let buffer = ''

  function handleLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    onEvent(normalizeEvent(JSON.parse(trimmed) as BuildDeployEvent))
  }

  while (true) {
    const { done, value } = await reader.read()
    if (value) {
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) handleLine(line)
    }
    if (done) break
  }

  if (buffer.trim()) handleLine(buffer)
}

export async function streamContractBuild(input: {
  contractPath: string
  network: Network
  retryCount?: number
  signal?: AbortSignal
  onEvent: (event: BuildDeployEvent) => void
}) {
  const response = await fetch(apiPath('/contracts/build'), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      contractPath: input.contractPath,
      network: input.network,
      retryCount: input.retryCount ?? 2,
      build: true,
    }),
    signal: input.signal,
  })

  refreshSessionFromResponse(response)
  if (!response.ok) {
    throw new Error(await readError(response))
  }

  await readNdjsonStream(response, input.onEvent)
}

export async function simulateDeploy(input: {
  contractPath: string
  network: Network
  walletAddress?: string | null
  build?: boolean
  deployKind?: 'typeid' | 'data'
}) {
  const response = await fetch(apiPath('/contracts/deploy/simulate'), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      contractPath: input.contractPath,
      network: input.network,
      walletAddress: input.walletAddress || undefined,
      build: Boolean(input.build),
      deployKind: input.deployKind || 'typeid',
    }),
  })
  refreshSessionFromResponse(response)
  const payload = (await response.json().catch(() => ({}))) as DeployEstimate & { message?: string; error?: string }
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Deploy simulation failed (${response.status})`)
  }
  return payload
}

export async function streamContractDeploy(input: {
  contractPath: string
  network: Network
  walletAddress: string
  passkeyProof: string
  build?: boolean
  deployKind?: 'typeid' | 'data'
  retryCount?: number
  signal?: AbortSignal
  onEvent: (event: BuildDeployEvent) => void
}) {
  const response = await fetch(apiPath('/contracts/deploy'), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      contractPath: input.contractPath,
      network: input.network,
      walletAddress: input.walletAddress,
      passkeyProof: input.passkeyProof,
      build: input.build ?? false,
      deployKind: input.deployKind || 'typeid',
      retryCount: input.retryCount ?? 2,
    }),
    signal: input.signal,
  })

  refreshSessionFromResponse(response)
  if (!response.ok) {
    throw new Error(await readError(response))
  }

  await readNdjsonStream(response, input.onEvent)
}

export async function fetchLatestDeployment(input: {
  network: Network
  contractPath?: string | null
  service?: string | null
  walletAddress?: string | null
}) {
  const params = new URLSearchParams({ network: input.network })
  if (input.contractPath) params.set('contractPath', input.contractPath)
  if (input.service) params.set('service', input.service)
  if (input.walletAddress) params.set('walletAddress', input.walletAddress)
  const response = await fetch(apiPath(`/contracts/deployments/latest?${params.toString()}`), {
    cache: 'no-store',
    headers: authHeaders(),
  })
  refreshSessionFromResponse(response)
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    deployment?: DeploymentSummary | null
    message?: string
    error?: string
  }
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Deployment lookup failed (${response.status})`)
  }
  return payload.deployment ?? null
}
