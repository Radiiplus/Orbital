import { useCallback, useEffect, useState } from 'react'
import BuildDeployPanel from '../components/BuildDeployPanel'
import Header, { type Network } from '../components/header'
import ProjectStructurePanel from '../components/ProjectStructurePanel'
import WalletsPanel from '../components/wallets/WalletsPanel'
import { fetchPublicNetworkBalances } from '../lib/balances'
import {
  createAccountWallet,
  deleteWallet,
  exportWalletMnemonic,
  linkAccountWallet,
  listWallets,
  loadAccountBalances,
  updateWalletLabel,
  type WalletItem,
} from '../lib/wallets'
import { authenticatePasskeyProof } from '../lib/passkey'
import {
  getStoredAccessToken,
  getStoredDeviceId,
  setDeviceCookie,
  setSessionCookie,
} from '../lib/session'
import type { ContractConfigItem } from '../lib/structure'
import { eventResult, fetchLatestDeployment, type BuildDeployEvent, type DeploymentSummary } from '../lib/buildDeploy'
import { fetchOrbkitStatus, reconnectOrbkit, type OrbkitConnectionStatus } from '../lib/orbkit'
import { apiPath } from '../lib/api'

const NETWORK_STORAGE_KEY = 'onw'

type SessionPayload = {
  ok?: boolean
  accessToken?: string
  deviceId?: string
  user?: {
    username?: string | null
  }
}

type DeploymentDisplayItem = {
  label: string
  value: string
  title?: string
  mono?: boolean
}

function readInitialNetwork(): Network {
  const stored = localStorage.getItem(NETWORK_STORAGE_KEY)
  return stored === 'testnet' || stored === 'mainnet' || stored === 'devnet' ? stored : 'devnet'
}

function shortMiddle(value: string | null | undefined, max = 34) {
  if (!value) return 'Pending'
  if (value.length <= max) return value
  const edge = Math.max(6, Math.floor((max - 3) / 2))
  return `${value.slice(0, edge)}...${value.slice(-edge)}`
}

function formatDeploymentBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Pending'
  if (value < 1024) return `${value.toLocaleString()} B`
  return `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} KB`
}

function formatDeploymentTime(value: string | null | undefined) {
  if (!value) return 'Pending'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Pending'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function scriptConfigValue(deployment: DeploymentSummary | null, key: string) {
  const value = deployment?.scriptConfig?.[key]
  return typeof value === 'string' && value ? value : null
}

export default function HomePage() {
  const [network, setNetwork] = useState<Network>(readInitialNetwork)
  const [username, setUsername] = useState('')
  const [wallets, setWallets] = useState<WalletItem[]>([])
  const [activeWallet, setActiveWallet] = useState<string | null>(null)
  const [walletsLoading, setWalletsLoading] = useState(false)
  const [walletError, setWalletError] = useState('')
  const [selectedContractPath, setSelectedContractPath] = useState<string | null>(null)
  const [selectedContractService, setSelectedContractService] = useState<string | null>(null)
  const [lastDeployment, setLastDeployment] = useState<DeploymentSummary | null>(null)
  const [lastDeploymentLoading, setLastDeploymentLoading] = useState(false)
  const [orbkitStatus, setOrbkitStatus] = useState<OrbkitConnectionStatus | null>(null)
  const [orbkitReconnectStatus, setOrbkitReconnectStatus] = useState<'idle' | 'reconnecting' | 'success' | 'error'>('idle')
  const [runtimeRefreshKey, setRuntimeRefreshKey] = useState(0)
  const selectedWallet = wallets.find((wallet) => wallet.address === activeWallet) ?? null

  const deploymentTxHash = lastDeployment?.txHash || scriptConfigValue(lastDeployment, 'TX_HASH')
  const deploymentCodeHash = scriptConfigValue(lastDeployment, 'CODE_HASH')
  const deploymentItems: DeploymentDisplayItem[] = lastDeployment
    ? [
        { label: 'Contract', value: lastDeployment.contractName || lastDeployment.contractPath, title: lastDeployment.contractPath },
        { label: 'Network', value: lastDeployment.network },
        { label: 'Tx Hash', value: shortMiddle(deploymentTxHash, 36), title: deploymentTxHash || 'Pending', mono: true },
        { label: 'Wallet', value: lastDeployment.walletLabel || shortMiddle(lastDeployment.walletAddress, 28), title: lastDeployment.walletAddress || lastDeployment.walletLabel || 'Pending' },
        { label: 'Deploy Address', value: shortMiddle(lastDeployment.deployAddress, 32), title: lastDeployment.deployAddress || 'Pending', mono: true },
        { label: 'Project Bytes', value: formatDeploymentBytes(lastDeployment.binaryBytes) },
        { label: 'Deploy Kind', value: `${lastDeployment.deployKind || 'typeid'}${lastDeployment.sponsored ? ' / sponsored' : ''}`, title: lastDeployment.sponsorAddress || lastDeployment.deployKind || 'typeid' },
        { label: 'Code Hash', value: shortMiddle(deploymentCodeHash, 36), title: deploymentCodeHash || 'Pending', mono: true },
        { label: 'Type ID', value: shortMiddle(lastDeployment.typeId, 36), title: lastDeployment.typeId || 'Pending', mono: true },
        { label: 'Updated', value: formatDeploymentTime(lastDeployment.deployedAt), title: lastDeployment.deployedAt },
      ]
    : [
        { label: 'Wallet', value: selectedWallet ? selectedWallet.label : 'Select wallet', title: selectedWallet?.address || undefined },
        { label: 'Network', value: network },
        { label: 'Contract', value: selectedContractPath || 'Waiting for Orbkit', title: selectedContractPath || undefined },
        { label: 'Deployment', value: lastDeploymentLoading ? 'Reading project receipt' : 'No project receipt yet' },
      ]

  function handleNetworkChange(nextNetwork: Network) {
    localStorage.setItem(NETWORK_STORAGE_KEY, nextNetwork)
    setNetwork(nextNetwork)
  }

  const handleDeploymentComplete = useCallback((deployment: DeploymentSummary) => {
    const nextDeployment = {
      ...deployment,
      deployedAt: deployment.deployedAt || new Date().toISOString(),
    }
    setLastDeployment(nextDeployment)
  }, [])

  const handleBuildDeployEvent = useCallback((event: BuildDeployEvent) => {
    if (event.phase !== 'completed') return
    const result = eventResult(event)
    const walletAddress = result?.walletAddress || result?.deployAddress || result?.address || null
    if (!walletAddress || result?.walletBalance == null) return
    const nextBalance = Number(result.walletBalance) / 100000000
    if (!Number.isFinite(nextBalance)) return
    setWallets((current) => current.map((wallet) => (
      wallet.address === walletAddress ? { ...wallet, balance: nextBalance } : wallet
    )))
  }, [])

  const refreshOrbkitStatus = useCallback(async (signal?: AbortSignal) => {
    const status = await fetchOrbkitStatus(signal)
    setOrbkitStatus(status)
    return status
  }, [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()

    async function loadStatus() {
      try {
        const status = await fetchOrbkitStatus(controller.signal)
        if (active) setOrbkitStatus(status)
      } catch {
        if (active) {
          setOrbkitStatus({
            ok: false,
            connected: false,
            connectedCount: 0,
            service: null,
            status: 'offline',
            updatedAt: null,
            workspaceRoot: null,
            configPath: null,
            contracts: [],
            services: [],
            message: 'Orbkit status unavailable',
          })
        }
      }
    }

    void loadStatus()
    const timer = window.setInterval(() => void loadStatus(), 8000)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(timer)
    }
  }, [])

  const handleReconnectOrbkit = useCallback(async () => {
    setOrbkitReconnectStatus('reconnecting')
    try {
      await reconnectOrbkit(orbkitStatus?.service)
      await new Promise((resolve) => window.setTimeout(resolve, 900))
      await refreshOrbkitStatus()
      setRuntimeRefreshKey((current) => current + 1)
      setOrbkitReconnectStatus('success')
      window.setTimeout(() => setOrbkitReconnectStatus('idle'), 1800)
    } catch {
      setOrbkitReconnectStatus('error')
      window.setTimeout(() => setOrbkitReconnectStatus('idle'), 2500)
    }
  }, [orbkitStatus?.service, refreshOrbkitStatus])

  useEffect(() => {
    let active = true
    setLastDeploymentLoading(true)
    fetchLatestDeployment({
      network,
      contractPath: selectedContractPath,
      service: selectedContractService,
      walletAddress: selectedWallet?.address,
    })
      .then((deployment) => {
        if (!active) return
        setLastDeployment(deployment)
      })
      .catch(() => {
        if (active) setLastDeployment(null)
      })
      .finally(() => {
        if (active) setLastDeploymentLoading(false)
      })
    return () => {
      active = false
    }
  }, [network, selectedContractPath, selectedContractService, selectedWallet?.address])

  const readCurrentSession = useCallback(async () => {
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
  }, [])

  const refreshWallets = useCallback(async () => {
    const currentUsername = username || await readCurrentSession()
    if (!currentUsername) return

    setWalletsLoading(true)
    setWalletError('')
    try {
      setUsername(currentUsername)
      const [walletRows, balances] = await Promise.all([
        listWallets(currentUsername, network),
        loadAccountBalances(currentUsername),
      ])
      const rpcBalances = await fetchPublicNetworkBalances(
        walletRows.map((wallet) => wallet.address),
        network,
      )
      const nextWallets = walletRows.map((wallet) => ({
        ...wallet,
        balance: rpcBalances[wallet.address] ?? balances.get(`${wallet.network}:${wallet.address}`) ?? null,
      }))

      setWallets(nextWallets)
      setActiveWallet((current) => (
        current && nextWallets.some((wallet) => wallet.address === current)
          ? current
          : nextWallets[0]?.address ?? null
      ))
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Could not load wallets.')
    } finally {
      setWalletsLoading(false)
    }
  }, [network, readCurrentSession, username])

  useEffect(() => {
    void refreshWallets()
  }, [refreshWallets])

  useEffect(() => {
    function handleWalletBalancesUpdated(event: Event) {
      const payload = (event as CustomEvent<{ balances?: Record<string, number> }>).detail || {}
      const balances = payload.balances || {}
      setWallets((current) => current.map((wallet) => {
        const balance = balances[wallet.address]
        return balance === undefined ? wallet : { ...wallet, balance }
      }))
    }

    window.addEventListener('walletBalancesUpdated', handleWalletBalancesUpdated)
    return () => {
      window.removeEventListener('walletBalancesUpdated', handleWalletBalancesUpdated)
    }
  }, [])

  async function runWalletMutation(work: () => Promise<void>) {
    await work()
    await refreshWallets()
  }

  return (
    <main className="min-h-screen w-full max-w-[100dvw] overflow-x-hidden bg-[#000000] text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_82%_12%,rgba(52,211,153,0.16),transparent_28%),radial-gradient(circle_at_12%_74%,rgba(244,244,245,0.08),transparent_24%)]" />
      <div className="relative min-h-screen w-full min-w-0 max-w-[100dvw] overflow-x-hidden px-2 py-2 sm:px-4 sm:py-4 md:px-6 md:py-6">
        <div className="grid min-w-0 max-w-full content-start gap-3 overflow-x-hidden sm:gap-4">
          <Header
            network={network}
            onNetworkChange={handleNetworkChange}
            activeWalletLabel={selectedWallet?.label ?? 'No wallet selected'}
            activeWalletAddress={selectedWallet?.address ?? null}
            wallets={wallets.map((w) => ({ address: w.address, label: w.label }))}
            onSelectWallet={setActiveWallet}
            orbkitConnected={orbkitStatus?.connected ?? null}
            orbkitService={orbkitStatus?.service ?? null}
            orbkitReconnectStatus={orbkitReconnectStatus}
            onReconnectOrbkit={handleReconnectOrbkit}
          />

          <section className="grid min-w-0 gap-4 lg:grid-cols-3">
            <WalletsPanel
              activeWallet={activeWallet}
              error={walletError}
              loading={walletsLoading}
              onCreateWallet={(label) => runWalletMutation(async () => {
                await createAccountWallet({ username, label, network })
              })}
              onDeleteWallet={(walletAddress) => runWalletMutation(async () => {
                await deleteWallet({ username, walletAddress, network })
              })}
              onExportWalletMnemonic={async (walletAddress) => {
                const passkeyProof = await authenticatePasskeyProof(username)
                return exportWalletMnemonic({ username, walletAddress, network, passkeyProof })
              }}
              onLinkWallet={(mnemonic, label) => runWalletMutation(async () => {
                await linkAccountWallet({ username, mnemonic, label, network })
              })}
              onRefresh={refreshWallets}
              onSelectWallet={setActiveWallet}
              onUpdateWalletLabel={(walletAddress, label) => runWalletMutation(async () => {
                await updateWalletLabel({ username, walletAddress, label, network })
              })}
              wallets={wallets}
            />

            <article className="glass-panel app-reveal min-w-0 p-3 sm:p-5 md:p-6">
              <p className="auth-kicker">Active Wallet</p>
              <h2 className="mt-2 truncate text-2xl font-bold tracking-normal text-white">
                {selectedWallet?.label ?? 'No wallet selected'}
              </h2>
              <p className="mt-3 line-clamp-2 break-all font-mono text-xs leading-5 text-zinc-500" title={selectedWallet?.address ?? ''}>
                {selectedWallet?.address ?? 'Create or link a wallet to activate deploy signing.'}
              </p>
            </article>
          </section>

          <section className="grid min-w-0 gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <BuildDeployPanel
                activeWallet={selectedWallet}
                network={network}
                onDeploymentComplete={handleDeploymentComplete}
                onEvent={handleBuildDeployEvent}
                onWalletBalanceRefresh={refreshWallets}
                runtimeRefreshKey={runtimeRefreshKey}
                onContractSelected={(contract: ContractConfigItem | null, service?: string | null) => {
                  setSelectedContractPath(contract?.path || null)
                  setSelectedContractService(service || null)
                }}
              />
            </div>
            <aside className="glass-panel app-reveal min-w-0 p-3 sm:p-5">
              <p className="auth-kicker">Workspace Readiness</p>
              <h2 className="mt-2 text-xl font-bold tracking-normal text-white">
                {lastDeployment ? 'Last deployed contract' : lastDeploymentLoading ? 'Reading deployment' : 'Build lane armed'}
              </h2>
              {lastDeployment && (
                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                  <span className="rounded-full bg-emerald-400/12 px-2.5 py-1 text-[11px] font-black text-emerald-200">
                    Deployed
                  </span>
                  {lastDeployment.service && (
                    <span className="min-w-0 truncate rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] font-black text-zinc-400" title={lastDeployment.service}>
                      {shortMiddle(lastDeployment.service, 24)}
                    </span>
                  )}
                </div>
              )}
              <div className="app-compact-scrollbar mt-4 grid max-h-[28rem] gap-3 overflow-y-auto pr-1">
                {deploymentItems.map((item) => (
                  <div className="min-w-0 rounded-[1rem] border border-white/10 bg-black/25 px-3 py-3 shadow-[inset_7px_7px_15px_rgba(0,0,0,0.48),inset_-7px_-7px_15px_rgba(255,255,255,0.02)]" key={item.label}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">{item.label}</p>
                    <p className={`mt-1 truncate font-bold text-zinc-100 ${item.mono ? 'font-mono text-xs' : 'text-sm'}`} title={item.title || item.value}>
                      {item.value}
                    </p>
                  </div>
                ))}
              </div>
            </aside>
          </section>

          <ProjectStructurePanel
            preferredContractPath={selectedContractPath}
            preferredService={selectedContractService}
            runtimeRefreshKey={runtimeRefreshKey}
          />
        </div>
      </div>
    </main>
  )
}
