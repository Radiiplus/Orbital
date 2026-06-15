import {
  BookOpenText,
  ChevronDown,
  CircleDollarSign,
  Globe2,
  KeyRound,
  RefreshCw,
  Rotate3D,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import TopupWizard from './TopupWizard'
import {
  getStoredAccessToken,
  getStoredDeviceId,
  setDeviceCookie,
  setSessionCookie,
} from '../lib/session'
import { apiPath } from '../lib/api'
import { GRAPHQL_ENDPOINT } from '../lib/graphql'
import { authenticatePasskeyProof } from '../lib/passkey'

export type Network = 'devnet' | 'testnet' | 'mainnet'

type HeaderProps = {
  network: Network
  onNetworkChange: (network: Network) => void
  activeWalletLabel: string
  activeWalletAddress: string | null
  wallets?: Array<{ address: string; label: string }>
  onSelectWallet?: (address: string | null) => void
  orbkitConnected?: boolean | null
  orbkitService?: string | null
  orbkitReconnectStatus?: 'idle' | 'reconnecting' | 'success' | 'error'
  onReconnectOrbkit?: () => void
}

type UptimeState = {
  status: 'checking' | 'online' | 'offline'
  checkedAt: string
  latencyMs?: number
  message: string
  source: 'backend' | 'frontend'
}

const networks: Array<{ label: string; value: Network }> = [
  { label: 'Devnet', value: 'devnet' },
  { label: 'Testnet', value: 'testnet' },
  { label: 'Mainnet', value: 'mainnet' },
]

const publicRpcUrls: Record<Exclude<Network, 'devnet'>, string> = {
  testnet: import.meta.env.VITE_CKB_TESTNET_RPC_URL || 'https://testnet.ckb.dev/rpc',
  mainnet: import.meta.env.VITE_CKB_MAINNET_RPC_URL || 'https://mainnet.ckb.dev/rpc',
}

async function readJson(response: Response) {
  return response.json().catch(() => ({}))
}

async function pingDevnetThroughBackend(signal?: AbortSignal) {
  const startedAt = performance.now()
  const token = getStoredAccessToken()
  const response = await fetch(apiPath('/networks/devnet/status'), {
    cache: 'no-store',
    signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  const payload = await readJson(response)
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.message || payload?.error || `Backend returned ${response.status}`)
  }
  return {
    latencyMs: Math.round(performance.now() - startedAt),
    message: `devnet available through orbkit service`,
    source: 'backend' as const,
  }
}

async function pingPublicRpc(network: Exclude<Network, 'devnet'>, signal?: AbortSignal) {
  const rpcUrl = publicRpcUrls[network]
  const startedAt = performance.now()
  const response = await fetch(rpcUrl, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'get_tip_block_number',
      params: [],
    }),
    signal,
  })
  const payload = await readJson(response)
  if (!response.ok || payload?.error || payload?.result == null) {
    throw new Error(payload?.error?.message || `RPC returned ${response.status}`)
  }
  return {
    latencyMs: Math.round(performance.now() - startedAt),
    message: `${network} public RPC reachable from frontend`,
    source: 'frontend' as const,
  }
}

function pingNetwork(network: Network, signal?: AbortSignal) {
  if (network === 'devnet') {
    return pingDevnetThroughBackend(signal)
  }
  return pingPublicRpc(network, signal)
}

function buildCheckingState(targetNetwork: Network, current: UptimeState): UptimeState {
  return {
    ...current,
    status: 'checking',
    message: `Checking ${targetNetwork}`,
    source: targetNetwork === 'devnet' ? 'backend' : 'frontend',
  }
}

function buildOfflineState(targetNetwork: Network, error: unknown): UptimeState {
  return {
    status: 'offline',
    checkedAt: checkedAtLabel(),
    message: error instanceof Error ? error.message : `${targetNetwork} is unreachable`,
    source: targetNetwork === 'devnet' ? 'backend' : 'frontend',
  }
}

function buildOnlineState(result: Awaited<ReturnType<typeof pingNetwork>>): UptimeState {
  return {
    status: 'online',
    checkedAt: checkedAtLabel(),
    latencyMs: result.latencyMs,
    message: result.message,
    source: result.source,
  }
}

function checkedAtLabel() {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date())
}

export default function Header({
  network,
  onNetworkChange,
  activeWalletLabel,
  activeWalletAddress,
  wallets = [],
  onSelectWallet,
  orbkitConnected = null,
  orbkitService = null,
  orbkitReconnectStatus = 'idle',
  onReconnectOrbkit,
}: HeaderProps) {
  const [uptime, setUptime] = useState<UptimeState>({
    status: 'checking',
    checkedAt: 'pending',
    message: 'Checking uptime',
    source: 'backend',
  })
  const [showFundingWizard, setShowFundingWizard] = useState(false)

  async function handleManualCheck() {
    const targetNetwork = network
    setUptime((current) => buildCheckingState(targetNetwork, current))

    try {
      const result = await pingNetwork(targetNetwork)
      setUptime(buildOnlineState(result))
    } catch (error) {
      setUptime(buildOfflineState(targetNetwork, error))
    }
  }

  

  useEffect(() => {
    let active = true
    const controller = new AbortController()

    async function runCheck(silent = false) {
      if (!active) return
      const targetNetwork = network

      if (!silent) {
        setUptime((current) => buildCheckingState(targetNetwork, current))
      }

      try {
        const result = await pingNetwork(targetNetwork, controller.signal)
        if (!active) return
        setUptime(buildOnlineState(result))
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
        setUptime(buildOfflineState(targetNetwork, error))
      }
    }

    runCheck()
    const timer = window.setInterval(() => runCheck(true), 30000)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(timer)
    }
  }, [network])

  const StatusIcon = uptime.status === 'offline' ? WifiOff : Wifi
  const uptimeLabel = uptime.status === 'online'
    ? `${network} reachable ${uptime.latencyMs ?? 0}ms`
    : uptime.status === 'checking'
      ? `checking ${network}`
      : `${network} unreachable`
  const orbkitLabel = orbkitConnected === null
    ? 'orbkit checking'
    : orbkitConnected
      ? 'orbkit online'
      : 'orbkit offline'
  const OrbkitIcon = orbkitConnected === false ? WifiOff : Wifi

  return (
    <header className="app-topbar app-reveal">
      <div className="flex min-w-0 max-w-full items-center gap-3 sm:gap-4">
        <div className="app-brand-mark">
          <Rotate3D size={24} strokeWidth={2.4} />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-extrabold tracking-normal text-white sm:text-xl">Orbital Ops</h1>
          <p className="mt-1 truncate text-xs text-slate-400 sm:text-sm">Contract build and deployment workspace</p>
        </div>
      </div>

      <div className="app-topbar-actions">
        <label className="app-pill app-network-pill">
          <Globe2 className="text-cyan-300" size={17} strokeWidth={2.25} />
          <span className="app-network-value capitalize">{network}</span>
          <select
            aria-label="Switch network"
            className="app-pill-select"
            onChange={(event) => onNetworkChange(event.target.value as Network)}
            value={network}
          >
            {networks.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" className="absolute right-3 text-zinc-300" size={16} strokeWidth={2.4} />
        </label>

        <button
          aria-label={`Check uptime: ${uptime.message}. Last checked ${uptime.checkedAt}.`}
          className={`app-pill app-status-pill ${uptime.status === 'online' ? 'app-status-online' : ''} ${
            uptime.status === 'offline' ? 'app-status-offline' : ''
          }`}
          onClick={() => void handleManualCheck()}
          title={`${uptime.message} - ${uptime.checkedAt}`}
          type="button"
        >
          <StatusIcon size={18} strokeWidth={2.2} />
          <span className="truncate">{uptimeLabel}</span>
          <RefreshCw className={uptime.status === 'checking' ? 'animate-spin' : ''} size={14} />
        </button>

        <button
          aria-label={`Reconnect orbkit runtime${orbkitService ? ` ${orbkitService}` : ''}`}
          className={`app-pill app-orbkit-pill ${orbkitConnected ? 'app-orbkit-online' : ''} ${orbkitConnected === false ? 'app-orbkit-offline' : ''}`}
          disabled={!onReconnectOrbkit || orbkitReconnectStatus === 'reconnecting'}
          onClick={() => onReconnectOrbkit?.()}
          title={orbkitService || 'Orbkit runtime'}
          type="button"
        >
          <OrbkitIcon size={16} strokeWidth={2.2} />
          <span className="truncate">{orbkitLabel}</span>
          <RefreshCw className={orbkitReconnectStatus === 'reconnecting' ? 'animate-spin' : ''} size={14} />
        </button>

        <button className="app-pill app-muted-pill" type="button">
          {activeWalletLabel}
        </button>

        <a className="app-pill app-muted-pill no-underline" href="/guide" title="Open guide">
          <BookOpenText size={16} strokeWidth={2.2} />
          <span>Guide</span>
        </a>

        <HelperKeyControl />

        <button
          className="app-pill app-accent-pill cursor-pointer"
          type="button"
          onClick={() => setShowFundingWizard(true)}
          title={network === 'devnet' ? 'Top up wallet on devnet' : 'Copy wallet address for external topup'}
        >
          <CircleDollarSign size={16} strokeWidth={2.2} />
          <span>Topup</span>
        </button>

        {showFundingWizard && (
          <TopupWizard
            show={showFundingWizard}
            onClose={() => setShowFundingWizard(false)}
            wallets={wallets}
            activeWalletLabel={activeWalletLabel}
            activeWalletAddress={activeWalletAddress}
            onSelectWallet={onSelectWallet}
            network={network}
            uptimeStatus={uptime.status}
          />
        )}
      </div>
    </header>
  )
}

function graphqlRequest(query: string, variables?: Record<string, unknown>) {
  const token = getStoredAccessToken()
  const deviceId = getStoredDeviceId()
  return fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { 'x-device-id': deviceId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  }).then(async (res) => {
    const payload = await res.json().catch(() => ({}))
    if (!res.ok || payload.errors?.length) {
      throw new Error(payload.errors?.[0]?.message || `GraphQL request failed (${res.status})`)
    }
    const refreshedToken = res.headers.get('x-access-token')
    if (refreshedToken) setSessionCookie(refreshedToken)
    const refreshedDeviceId = res.headers.get('x-device-id')
    if (refreshedDeviceId) setDeviceCookie(refreshedDeviceId)
    return payload.data
  })
}

type SessionKeyPayload = {
  ok?: boolean
  accessToken?: string
  deviceId?: string
  message?: string
  user?: {
    username?: string | null
    api?: string | null
    helperApiKey?: string | null
    key?: string | null
  } | null
}

function sessionKeyFromPayload(payload: SessionKeyPayload | null) {
  const user = payload?.user
  const key = String(user?.api || user?.helperApiKey || user?.key || '').trim()
  return key || null
}

function HelperKeyControl() {
  const [show, setShow] = useState(false)
  const [key, setKey] = useState<string | null>(null)
  const [keyStatus, setKeyStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [keyError, setKeyError] = useState('')
  const [username, setUsername] = useState('')
  const [copied, setCopied] = useState(false)
  const [reveal, setReveal] = useState(true)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)

  async function loadKey() {
    setKeyStatus('loading')
    setKeyError('')
    try {
      const token = getStoredAccessToken()
      const deviceId = getStoredDeviceId()
      if (!token) {
        throw new Error('Session token is missing.')
      }
      const response = await fetch(apiPath('/session'), {
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(deviceId ? { 'x-device-id': deviceId } : {}),
        },
      })
      const data = (await response.json().catch(() => ({}))) as SessionKeyPayload
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.message || `Session returned ${response.status}`)
      }
      const refreshedToken = response.headers.get('x-access-token') || data.accessToken
      if (refreshedToken) setSessionCookie(refreshedToken)
      const refreshedDeviceId = response.headers.get('x-device-id') || data.deviceId
      if (refreshedDeviceId) setDeviceCookie(refreshedDeviceId)
      setKey(sessionKeyFromPayload(data))
      setUsername(String(data.user?.username || '').trim())
      setKeyStatus('loaded')
    } catch (error) {
      setKey(null)
      setKeyStatus('error')
      setKeyError(error instanceof Error ? error.message : 'Could not load API key.')
    }
  }

  async function createKey() {
    setIsCreating(true)
    setKeyError('')
    try {
      const accountUsername = username.trim()
      if (!accountUsername) {
        throw new Error('Username is required to rotate the API key.')
      }
      const passkeyProof = await authenticatePasskeyProof(accountUsername)
      const data = await graphqlRequest(`
        mutation CreateHelperApiKey($passkeyProof: String!) {
          createHelperApiKey(passkeyProof: $passkeyProof) {
            username
            key
            createdAt
          }
        }
      `, {
        passkeyProof,
      })
      if (data?.createHelperApiKey?.key) {
        setKey(data.createHelperApiKey.key)
        setKeyStatus('loaded')
        setKeyError('')
      }
    } catch (err) {
      console.error('Failed to create API key:', err)
      setKeyStatus('error')
      setKeyError(err instanceof Error ? err.message : 'Failed to create API key.')
    } finally {
      setIsCreating(false)
    }
  }

  async function copyKey() {
    if (!key) return
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  function mask(k?: string | null) {
    if (!k) return ''
    if (k.length <= 24) return k
    return `${k.slice(0, 10)}...${k.slice(-8)}`
  }

  const keyText = keyStatus === 'loading'
    ? 'Loading API key...'
    : keyStatus === 'error'
      ? keyError || 'Could not load API key.'
      : key
        ? (reveal ? key : mask(key))
        : 'No API key created for this account yet.'

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null
      if (!show) return
      if (popupRef.current && popupRef.current.contains(target)) return
      if (btnRef.current && btnRef.current.contains(target)) return
      setShow(false)
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShow(false)
    }

    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [show])

  useEffect(() => {
    function onResize() {
      if (!btnRef.current) return
      setAnchorRect(btnRef.current.getBoundingClientRect())
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [])

  useEffect(() => {
    if (show && btnRef.current) {
      setAnchorRect(btnRef.current.getBoundingClientRect())
      void loadKey()
    }
  }, [show])

  const popupWidth = Math.min(320, Math.max(280, window.innerWidth - 16))
  const popup = show ? (
    createPortal(
      <div
        ref={popupRef}
        style={{
          position: 'fixed',
          top: anchorRect ? Math.min(window.innerHeight - 16 - 120, anchorRect.bottom + 8) : '50%',
          left: anchorRect ? Math.min(Math.max(8, anchorRect.right - popupWidth), window.innerWidth - 8 - popupWidth) : '50%',
          width: popupWidth,
          zIndex: 9999,
        }}
      >
        <div className="rounded-xl bg-[#0b0c12] p-3 shadow-lg">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">API Key</p>
          <p className={`mt-2 break-all font-mono text-sm ${keyStatus === 'error' ? 'text-amber-200' : 'text-slate-200'}`}>{keyText}</p>
          <div className="mt-3 flex items-center justify-end gap-2">
            {key && (
              <>
                <button onClick={() => void copyKey()} className="rounded-xl bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10">{copied ? 'Copied' : 'Copy'}</button>
                <button onClick={() => setReveal((r) => !r)} className="rounded-xl bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10">{reveal ? 'Hide' : 'Reveal'}</button>
              </>
            )}
            {keyStatus === 'error' && (
              <button onClick={() => void loadKey()} className="rounded-xl bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10">Retry</button>
            )}
            <button
              onClick={() => void createKey()}
              disabled={isCreating || keyStatus === 'loading'}
              className="rounded-xl bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCreating ? 'Creating...' : key ? 'Rotate Key' : 'Create Key'}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  ) : null

  return (
    <>
      <button
        ref={btnRef}
        className="app-pill app-muted-pill"
        type="button"
        onClick={() => setShow((s) => !s)}
      >
        <KeyRound size={16} strokeWidth={2.2} />
        <span>API Key</span>
      </button>
      {popup}
    </>
  )
}
