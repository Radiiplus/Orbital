import { getStoredAccessToken, getStoredDeviceId, setDeviceCookie, setSessionCookie } from './session'
import { apiPath } from './api'

export type ContractConfigItem = {
  id: string
  name: string
  path: string
  script: string
  build: boolean | null
}

export type ContractStructureMetrics = {
  lines: number
  functions: number
  functionNames: string[]
  imports: string[]
  importedBy: string[]
  relatedFiles?: string[]
  sharedFunctionNames?: string[]
  sharedFunctionalityWith?: string[]
  analysis?: {
    language: string
    entrypoints: string[]
    exports: string[]
    errorConstants: Array<{ name: string; value: string }>
    returnedErrors: { symbols: string[]; literals: string[]; named: string[] }
    errorCodes: Array<{ name: string; value: string }>
    vmApiImports: string[]
    vmApiCalls: string[]
    sourceVariants: string[]
    behaviorClassification: string
    stateTransitionChecks: {
      checksInputs: boolean
      checksOutputs: boolean
      readsWitness: boolean
      readsCellData: boolean
      validatesScriptArgs: boolean
      usesWitnessArgs?: boolean
    }
    features: string[]
    featureCount: number
  }
}

export type ContractStructureItem = {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: ContractStructureItem[]
  metrics?: ContractStructureMetrics
}

export type ContractStructureSnapshot = {
  ok?: boolean
  workspaceRoot?: string
  contractPath: string
  contractDir?: string
  manifest?: {
    packageName?: string | null
    crateTypes?: string[]
    dependencies?: string[]
    role?: string
    binaryName?: string
  }
  items: ContractStructureItem[]
  stats: {
    codeLines: number
    functions: number
    deps: number
    fileCount?: number
    sourceFileCount?: number
    rustFileCount?: number
    entrypointCount?: number
    sharedFunctionGroups?: number
    behaviorCounts?: Record<string, number>
  }
  entrypointFiles?: string[]
  sharedFunctions?: Array<{ name: string; files: string[] }>
}

export type ProjectStructureEvent = {
  type?: string
  streamId?: string
  contractPath?: string
  service?: string
  status?: string
  liveSyncEnabled?: boolean
  syncMode?: string
  changeType?: string
  sequence?: number
  message?: string
  error?: string | null
  snapshot?: ContractStructureSnapshot | string | null
  createdAt?: string
}

function authHeaders() {
  const token = getStoredAccessToken()
  const deviceId = getStoredDeviceId()
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const refreshedToken = response.headers.get('x-access-token')
  const refreshedDevice = response.headers.get('x-device-id')
  if (refreshedToken) setSessionCookie(refreshedToken)
  if (refreshedDevice) setDeviceCookie(refreshedDevice)

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Request failed (${response.status})`)
  }
  return payload
}

export async function fetchContractConfig() {
  const response = await fetch(apiPath('/contracts/config'), {
    cache: 'no-store',
    headers: authHeaders(),
  })
  return readJson<{
    source?: string
    service?: string
    workspaceRoot?: string | null
    configPath?: string | null
    contractsSourcePath?: string | null
    contracts?: ContractConfigItem[]
  }>(response)
}

export async function syncProjectStructure(contractPath: string, liveSyncEnabled: boolean, service?: string | null) {
  const response = await fetch(apiPath('/projects/structure/sync'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      contractPath,
      liveSyncEnabled,
      ...(service ? { service } : {}),
    }),
  })
  return readJson<ProjectStructureEvent & { ok?: boolean; latest?: ProjectStructureEvent | null }>(response)
}

export async function fetchLatestProjectStructure(contractPath: string, service?: string | null) {
  const params = new URLSearchParams({ contractPath })
  if (service) params.set('service', service)
  const response = await fetch(apiPath(`/projects/structure/latest?${params.toString()}`), {
    cache: 'no-store',
    headers: authHeaders(),
  })
  return readJson<{
    ok?: boolean
    contractPath?: string
    service?: string
    latest?: ProjectStructureEvent | null
  }>(response)
}

export async function configureProjectStructureLive(contractPath: string, liveSyncEnabled: boolean, service?: string | null) {
  const response = await fetch(apiPath('/projects/structure/live'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      contractPath,
      liveSyncEnabled,
      ...(service ? { service } : {}),
    }),
  })
  return readJson<ProjectStructureEvent & { ok?: boolean }>(response)
}

export function normalizeStructureSnapshot(value: ProjectStructureEvent['snapshot']) {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ContractStructureSnapshot
    } catch {
      return null
    }
  }
  return value
}

export async function readProjectStructureStream(
  contractPath: string,
  onEvent: (event: ProjectStructureEvent) => void,
  service?: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ contractPath })
  if (service) params.set('service', service)
  const response = await fetch(apiPath(`/projects/structure/stream?${params.toString()}`), {
    cache: 'no-store',
    headers: authHeaders(),
    signal,
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
    throw new Error(payload.message || payload.error || `Structure stream failed (${response.status})`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Structure stream did not include a response body.')

  const decoder = new TextDecoder()
  let buffer = ''

  function handleLine(line: string) {
    if (!line.trim()) return
    onEvent(JSON.parse(line) as ProjectStructureEvent)
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
