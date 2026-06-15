import {
  AlertTriangle,
  Check,
  ChevronDown,
  Hammer,
  Loader2,
  Play,
  Rocket,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  eventResult,
  simulateDeploy,
  streamContractBuild,
  streamContractDeploy,
  type BuildDeployEvent,
  type DeployEstimate,
  type DeploymentSummary,
} from '../lib/buildDeploy'
import { formatCkbBalance } from '../lib/format'
import { authenticatePasskeyProof } from '../lib/passkey'
import { fetchContractConfig, type ContractConfigItem } from '../lib/structure'
import type { Network, WalletItem } from '../lib/wallets'

const FALLBACK_CONTRACT: ContractConfigItem = {
  id: '',
  name: 'No contract',
  path: '',
  script: '',
  build: null,
}

type BuildStatus = 'idle' | 'running' | 'success' | 'error'
type DeployStatus = 'idle' | 'estimating' | 'ready' | 'deploying' | 'success' | 'error'

function shortMiddle(value: string, max = 38) {
  if (value.length <= max) return value
  const edge = Math.max(8, Math.floor((max - 3) / 2))
  return `${value.slice(0, edge)}...${value.slice(-edge)}`
}

function eventTime(value?: string) {
  if (!value) return '--:--:--'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function phaseIndex(phase?: string) {
  const normalized = String(phase || '').toLowerCase()
  if (normalized === 'queued') return 0
  if (normalized === 'accepted') return 1
  if (normalized === 'building' || normalized === 'preparing' || normalized === 'signing') return 2
  if (normalized === 'broadcasting' || normalized === 'refreshing-balance') return 3
  if (normalized === 'completed') return 3
  if (normalized === 'failed') return 3
  return 0
}

function statusText(status: BuildStatus) {
  if (status === 'running') return 'Building'
  if (status === 'success') return 'Ready'
  if (status === 'error') return 'Failed'
  return 'Idle'
}

function deployStatusText(status: DeployStatus) {
  if (status === 'estimating') return 'Estimating'
  if (status === 'ready') return 'Deploy ready'
  if (status === 'deploying') return 'Deploying'
  if (status === 'success') return 'Deployed'
  if (status === 'error') return 'Deploy failed'
  return 'Idle'
}

function formatBytes(value?: number | null) {
  if (value === null || value === undefined) return 'Pending'
  if (!Number.isFinite(Number(value))) return 'Pending'
  const bytes = Number(value)
  if (bytes < 1024) return `${bytes.toLocaleString()} B`
  return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} KB`
}

function formatCkb(value?: number | string | null, maxDigits = 3) {
  if (value === null || value === undefined || value === '') return 'Pending'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 'Pending'
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: maxDigits })} CKB`
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? Check : AlertTriangle
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black ${
      ok
        ? 'bg-emerald-400/12 text-emerald-200 shadow-[inset_1px_1px_0_rgba(255,255,255,0.08)]'
        : 'bg-zinc-700/30 text-zinc-400'
    }`}>
      <Icon className="shrink-0" size={13} strokeWidth={2.4} />
      <span className="truncate">{label}</span>
    </span>
  )
}

function BuildProgress({ events, status }: { events: BuildDeployEvent[]; status: BuildStatus }) {
  const latest = events[events.length - 1] ?? null
  const activeIndex = status === 'idle' ? -1 : phaseIndex(latest?.phase)
  const failed = status === 'error'
  const stages = [
    { key: 'queued', label: 'Queued' },
    { key: 'accepted', label: 'Accepted' },
    { key: 'building', label: 'Build' },
    { key: 'completed', label: failed ? 'Failed' : 'Done' },
  ]

  return (
    <div className="rounded-[1.35rem] border border-white/[0.07] bg-black/20 p-3 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.64),inset_-8px_-8px_18px_rgba(255,255,255,0.025)]">
      <div className="grid grid-cols-4 gap-2">
        {stages.map((stage, index) => {
          const done = activeIndex >= index
          const active = activeIndex === index && status === 'running'
          return (
            <div className="min-w-0" key={stage.key}>
              <div className={`mx-auto flex h-9 w-9 items-center justify-center rounded-2xl border text-xs font-black transition ${
                failed && index === stages.length - 1 && done
                  ? 'border-rose-300/35 bg-rose-500/15 text-rose-200'
                  : done
                    ? 'border-emerald-300/30 bg-emerald-500/15 text-emerald-200'
                    : 'border-white/[0.08] bg-white/[0.035] text-zinc-500'
              }`}>
                {active ? <Loader2 className="animate-spin" size={15} /> : done ? <Check size={15} /> : index + 1}
              </div>
              <p className={`mt-1 truncate text-center text-[10px] font-black uppercase ${
                done ? failed && index === stages.length - 1 ? 'text-rose-200' : 'text-zinc-200' : 'text-zinc-600'
              }`}>
                {stage.label}
              </p>
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex min-w-0 items-start gap-3">
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
          status === 'error'
            ? 'bg-rose-500/15 text-rose-200'
            : status === 'success'
              ? 'bg-emerald-500/15 text-emerald-200'
              : 'bg-cyan-500/15 text-cyan-200'
        }`}>
          {status === 'error' ? <XCircle size={17} /> : status === 'running' ? <Loader2 className="animate-spin" size={17} /> : <Hammer size={17} />}
        </span>
        <div className="min-w-0 max-w-full overflow-hidden">
          <p className="max-w-full whitespace-pre-wrap break-all text-sm font-black leading-6 text-zinc-100">
            {latest?.message || (status === 'idle' ? 'Ready to start a contract build.' : 'Waiting for build updates...')}
          </p>
          <p className="mt-1 truncate text-xs text-zinc-500">
            {latest?.phase || 'idle'} {latest?.service ? `from ${latest.service}` : ''}
          </p>
        </div>
      </div>
    </div>
  )
}

function BuildLog({ events }: { events: BuildDeployEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-[1.15rem] border border-dashed border-white/[0.09] bg-black/15 p-4 text-sm text-zinc-500">
        Build events will stream here as Orbkit works.
      </div>
    )
  }

  return (
    <div className="app-compact-scrollbar max-h-52 space-y-2 overflow-y-auto pr-1">
      {events.map((event, index) => (
        <div
          className={`min-w-0 overflow-hidden rounded-[1.05rem] border p-3 ${
            event.phase === 'failed'
              ? 'border-rose-300/25 bg-rose-500/10'
              : event.phase === 'completed'
                ? 'border-emerald-300/25 bg-emerald-500/10'
                : 'border-cyan-300/16 bg-cyan-500/8'
          }`}
          key={`${event.requestId || 'event'}-${index}`}
        >
          <div className="flex min-w-0 items-center justify-between gap-3">
            <p className="truncate text-[10px] font-black uppercase text-zinc-300">
              {event.phase || event.status || event.type || 'event'}
            </p>
            <p className="shrink-0 text-xs text-zinc-500">{eventTime(event.createdAt)}</p>
          </div>
          <p className="mt-1 min-w-0 max-w-full whitespace-pre-wrap break-all text-sm leading-6 text-zinc-300">{event.message || 'Build event received.'}</p>
          {event.error && <p className="mt-1 min-w-0 whitespace-pre-wrap break-all text-xs leading-5 text-rose-200">{event.error}</p>}
          {eventResult(event)?.results?.length ? (
            <div className="mt-2 space-y-1">
              {eventResult(event)?.results?.map((item) => (
                <p className="min-w-0 whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-emerald-200" key={`${item.scriptName}-${item.binaryPath}`}>
                  {item.scriptName || 'binary'}: {item.binaryPath || 'output ready'}
                </p>
              ))}
            </div>
          ) : null}
          {eventResult(event)?.txHash && (
            <p className="mt-2 min-w-0 whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-emerald-200" title={eventResult(event)?.txHash || ''}>
              tx: {eventResult(event)?.txHash}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

export default function BuildDeployPanel({
  network,
  activeWallet,
  onContractSelected,
  onDeploymentComplete,
  onEvent,
  onWalletBalanceRefresh,
  runtimeRefreshKey = 0,
}: {
  network: Network
  activeWallet: WalletItem | null
  onContractSelected?: (contract: ContractConfigItem | null, service?: string | null) => void
  onDeploymentComplete?: (deployment: DeploymentSummary) => void
  onEvent?: (event: BuildDeployEvent) => void
  onWalletBalanceRefresh?: () => Promise<void> | void
  runtimeRefreshKey?: number
}) {
  const [contracts, setContracts] = useState<ContractConfigItem[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [configService, setConfigService] = useState<string | null>(null)
  const [configSource, setConfigSource] = useState('')
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState('')
  const [buildStatus, setBuildStatus] = useState<BuildStatus>('idle')
  const [deployStatus, setDeployStatus] = useState<DeployStatus>('idle')
  const [deployEstimate, setDeployEstimate] = useState<DeployEstimate | null>(null)
  const [events, setEvents] = useState<BuildDeployEvent[]>([])
  const [deployNote, setDeployNote] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const selectedContract = useMemo(() => (
    contracts.find((contract) => contract.path === selectedPath) ?? contracts[0] ?? FALLBACK_CONTRACT
  ), [contracts, selectedPath])

  const latestEvent = events[events.length - 1] ?? null
  const balanceLabel = formatCkbBalance(activeWallet?.balance, 'Checking')
  const hasWallet = Boolean(activeWallet)
  const hasBalance = typeof activeWallet?.balance === 'number' && activeWallet.balance > 0
  const hasContract = Boolean(selectedContract.path)
  const canBuild = hasContract && buildStatus !== 'running'
  const latestResult = eventResult(latestEvent)
  const builtBinary = latestResult?.results?.find((item) => item.contractPath === selectedContract.path)
    ?? latestResult?.results?.[0]
    ?? null
  const deployResult = [...events].reverse().map(eventResult).find((result) => result?.txHash) ?? null
  const preparedResult = [...events].reverse().map(eventResult).find((result) => result?.unsignedTx) ?? null
  const deployBytes = deployResult?.binaryBytes ?? preparedResult?.binaryBytes ?? deployEstimate?.binaryBytes ?? deployEstimate?.binarySizeBytes ?? null
  const deployFee = deployEstimate?.simulatedFee?.feeCkb ?? deployEstimate?.fee?.feeCkb ?? null
  const hasDeployBytes = typeof deployBytes === 'number' && deployBytes > 0
  const canDeploy = hasContract && Boolean(activeWallet?.address) && deployStatus !== 'deploying'

  useEffect(() => {
    let active = true
    setConfigLoading(true)
    setConfigError('')

    fetchContractConfig()
      .then((config) => {
        if (!active) return
        const nextContracts = config.contracts || []
        setContracts(nextContracts)
        setConfigService(config.service || null)
        setConfigSource(config.source || 'unknown')
        setSelectedPath((current) => (
          current && nextContracts.some((contract) => contract.path === current)
            ? current
            : nextContracts[0]?.path ?? ''
        ))
      })
      .catch((error) => {
        if (!active) return
        setContracts([])
        setSelectedPath('')
        setConfigError(error instanceof Error ? error.message : 'Could not load contract config.')
      })
      .finally(() => {
        if (active) setConfigLoading(false)
      })

    return () => {
      active = false
    }
  }, [runtimeRefreshKey])

  useEffect(() => {
    onContractSelected?.(hasContract ? selectedContract : null, configService)
  }, [configService, hasContract, onContractSelected, selectedContract])

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (!hasContract || !activeWallet?.address) {
      setDeployEstimate(null)
      setDeployStatus('idle')
      return
    }
    let active = true
    setDeployStatus((current) => current === 'deploying' ? current : 'estimating')
    simulateDeploy({
      contractPath: selectedContract.path,
      network,
      walletAddress: activeWallet.address,
      build: false,
      deployKind: 'typeid',
    })
      .then((estimate) => {
        if (!active) return
        setDeployEstimate(estimate)
        setDeployStatus((current) => current === 'deploying' ? current : 'ready')
      })
      .catch((error) => {
        if (!active) return
        setDeployEstimate(null)
        setDeployStatus((current) => current === 'deploying' ? current : 'error')
        setDeployNote(error instanceof Error ? error.message : 'Could not estimate deploy size.')
      })
    return () => {
      active = false
    }
  }, [activeWallet?.address, hasContract, network, selectedContract.path])

  async function handleBuild() {
    if (!canBuild) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBuildStatus('running')
    setEvents([])
    setDeployNote('')
    setDeployStatus((current) => current === 'success' ? 'ready' : current)

    try {
      await streamContractBuild({
        contractPath: selectedContract.path,
        network,
        signal: controller.signal,
        onEvent: (event) => {
          setEvents((current) => [...current, event])
          onEvent?.(event)
          if (event.phase === 'completed') setBuildStatus('success')
          if (event.phase === 'failed') setBuildStatus('error')
        },
      })
      setBuildStatus((current) => current === 'running' ? 'success' : current)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setBuildStatus('error')
      setEvents((current) => [
        ...current,
        {
          type: 'build-deploy-log',
          action: 'build',
          phase: 'failed',
          status: 'failed',
          network,
          contractPath: selectedContract.path,
          message: 'Build request failed before Orbkit completed.',
          error: error instanceof Error ? error.message : String(error),
          createdAt: new Date().toISOString(),
        },
      ])
    }
  }

  async function handleDeploy() {
    if (!canDeploy || !activeWallet?.address) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setDeployStatus('deploying')
    setBuildStatus('running')
    setEvents([])
    setDeployNote('Opening passkey authorization...')

    try {
      const passkeyProof = await authenticatePasskeyProof(activeWallet.username)
      setDeployNote('Passkey accepted. Preparing unsigned deploy transaction...')
      await streamContractDeploy({
        contractPath: selectedContract.path,
        network,
        walletAddress: activeWallet.address,
        passkeyProof,
        build: false,
        deployKind: 'typeid',
        signal: controller.signal,
        onEvent: (event) => {
          setEvents((current) => [...current, event])
          onEvent?.(event)
          if (event.phase === 'preparing') setDeployNote('Creating unsigned transaction request...')
          if (event.phase === 'signing') setDeployNote('Signing transaction with selected wallet key after passkey authorization...')
          if (event.phase === 'broadcasting') {
            setDeployNote(network === 'devnet' ? 'Submitting signed transaction to Orbkit devnet broadcaster...' : `Broadcasting signed transaction to ${network} RPC...`)
          }
          if (event.phase === 'refreshing-balance') {
            const result = eventResult(event)
            setDeployNote(
              result?.sponsored
                ? 'Deploy broadcast accepted. Refreshing spendable balance; devnet sponsor covered deploy capacity, so your wallet may only change by a tiny fee or remain unchanged.'
                : result?.redeploy
                  ? 'Redeploy broadcast accepted. Refreshing selected wallet spendable balance from chain...'
                  : 'Deploy broadcast accepted. Refreshing selected wallet spendable balance from chain...',
            )
          }
          if (event.phase === 'completed') {
            setDeployStatus('success')
            setBuildStatus('success')
            const result = eventResult(event)
            setDeployNote(
              result?.txHash
                ? `Deploy successful: ${result.txHash}${result.balanceRefreshed === false ? '\nBalance refresh is still catching up; use wallet refresh in a moment.' : ''}`
                : 'Deploy successful.',
            )
            onDeploymentComplete?.(result?.deployment || {
              contractName: selectedContract.name || selectedContract.script || selectedContract.path,
              contractPath: selectedContract.path,
              network,
              walletAddress: activeWallet.address,
              walletLabel: activeWallet.label || null,
              service: configService,
              txHash: result?.txHash || null,
              deployAddress: result?.deployAddress || result?.address || activeWallet.address,
              binaryBytes: result?.binaryBytes ?? deployBytes ?? null,
              binaryPath: result?.binaryPath || builtBinary?.binaryPath || null,
              deployKind: result?.deployKind || 'typeid',
              sponsored: Boolean(result?.sponsored),
              sponsorMode: result?.sponsorMode || null,
              sponsorAddress: result?.sponsorAddress || null,
              scriptConfig: result?.scriptConfig || null,
              typeId: result?.typeId || null,
              deployedAt: event.createdAt || new Date().toISOString(),
            })
            void onWalletBalanceRefresh?.()
          }
          if (event.phase === 'failed') {
            setDeployStatus('error')
            setBuildStatus('error')
            const result = eventResult(event)
            setDeployNote(result?.hint || event.error || event.message || 'Deploy failed.')
          }
        },
      })
      setDeployStatus((current) => current === 'deploying' ? 'success' : current)
      setBuildStatus((current) => current === 'running' ? 'success' : current)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setDeployStatus('error')
      setBuildStatus('error')
      setDeployNote(error instanceof Error ? error.message : 'Deploy failed.')
      setEvents((current) => [
        ...current,
        {
          type: 'build-deploy-log',
          action: 'deploy',
          phase: 'failed',
          status: 'failed',
          network,
          contractPath: selectedContract.path,
          message: 'Deploy request failed before completion.',
          error: error instanceof Error ? error.message : String(error),
          createdAt: new Date().toISOString(),
        },
      ])
    }
  }

  function handleReset() {
    abortRef.current?.abort()
    abortRef.current = null
    setBuildStatus('idle')
    setDeployStatus(activeWallet?.address && selectedContract.path ? 'ready' : 'idle')
    setEvents([])
    setDeployNote('')
  }

  return (
    <article className="glass-panel app-reveal min-w-0 overflow-hidden p-3 sm:p-5 md:p-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-400/12 text-amber-200 shadow-[inset_1px_1px_0_rgba(255,255,255,0.08)]">
            <Rocket size={18} strokeWidth={2.3} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-black tracking-normal text-white">Build + Deploy</h2>
            <p className="mt-1 truncate text-xs text-zinc-500">
              {configLoading ? 'Loading contract config' : configSource ? `Source ${configSource}` : 'Orbkit build lane'}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <span className={`inline-flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black ${
            buildStatus === 'success'
              ? 'bg-emerald-500/15 text-emerald-200'
              : buildStatus === 'error'
                ? 'bg-rose-500/15 text-rose-200'
                : buildStatus === 'running'
                  ? 'bg-cyan-500/15 text-cyan-200'
                  : 'bg-white/[0.05] text-zinc-400'
          }`}>
            {buildStatus === 'running' && <Loader2 className="shrink-0 animate-spin" size={13} />}
            <span className="truncate">{statusText(buildStatus)}</span>
          </span>
          <span className={`hidden min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black sm:inline-flex ${
            deployStatus === 'success'
              ? 'bg-emerald-500/15 text-emerald-200'
              : deployStatus === 'error'
                ? 'bg-rose-500/15 text-rose-200'
                : deployStatus === 'deploying' || deployStatus === 'estimating'
                  ? 'bg-cyan-500/15 text-cyan-200'
                  : 'bg-white/[0.05] text-zinc-400'
          }`}>
            {(deployStatus === 'deploying' || deployStatus === 'estimating') && <Loader2 className="shrink-0 animate-spin" size={13} />}
            <span className="truncate">{deployStatusText(deployStatus)}</span>
          </span>
          <button
            aria-label="Reset build panel"
            className="app-icon-button min-w-[2.45rem] bg-white/[0.035]"
            onClick={handleReset}
            type="button"
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>

      <div className="mt-4 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="min-w-0 space-y-3">
          <div className="rounded-[1.35rem] border border-white/[0.07] bg-white/[0.035] p-4 shadow-[inset_1px_1px_0_rgba(255,255,255,0.05)]">
            <label className="block text-[11px] font-black uppercase tracking-[0.24em] text-zinc-600" htmlFor="build-contract-select">
              Contract
            </label>
            <div className="relative mt-2">
              <select
                className="app-select pr-10 text-sm font-black"
                disabled={configLoading || contracts.length === 0 || buildStatus === 'running'}
                id="build-contract-select"
                onChange={(event) => {
                  setSelectedPath(event.target.value)
                  setEvents([])
                  setBuildStatus('idle')
                  setDeployStatus('idle')
                  setDeployEstimate(null)
                  setDeployNote('')
                }}
                value={selectedContract.path}
              >
                {contracts.length === 0 ? (
                  <option value="">No contracts available</option>
                ) : (
                  contracts.map((contract) => (
                    <option key={contract.path} value={contract.path}>
                      {contract.name || contract.script || contract.path}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500" size={17} />
            </div>
            <p className="mt-3 truncate font-mono text-xs text-zinc-500" title={selectedContract.path}>
              {selectedContract.path || 'Waiting for an Orbkit contract.'}
            </p>
            {configService && (
              <p className="mt-2 truncate text-xs text-zinc-600" title={configService}>
                service {configService}
              </p>
            )}
            {configError && <p className="mt-3 text-sm text-rose-200">{configError}</p>}
          </div>

          <div className="rounded-[1.35rem] border border-white/[0.07] bg-white/[0.026] p-4">
            <div className="flex flex-wrap gap-2">
              <StatusPill ok={hasWallet} label="Wallet" />
              <StatusPill ok={hasBalance} label="Balance" />
              <StatusPill ok={hasContract} label="Contract" />
              <StatusPill ok={hasDeployBytes} label="Deploy bytes" />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="min-w-0 rounded-[1rem] bg-black/24 px-3 py-3 shadow-[inset_7px_7px_15px_rgba(0,0,0,0.56),inset_-7px_-7px_15px_rgba(255,255,255,0.022)]">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-600">Balance</p>
                <p className="mt-1 truncate text-sm font-bold text-zinc-100">{balanceLabel}</p>
              </div>
              <div className="min-w-0 rounded-[1rem] bg-black/24 px-3 py-3 shadow-[inset_7px_7px_15px_rgba(0,0,0,0.56),inset_-7px_-7px_15px_rgba(255,255,255,0.022)]">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-600">Network</p>
                <p className="mt-1 truncate text-sm font-bold text-zinc-100">{network}</p>
              </div>
              <div className="min-w-0 rounded-[1rem] bg-black/24 px-3 py-3 shadow-[inset_7px_7px_15px_rgba(0,0,0,0.56),inset_-7px_-7px_15px_rgba(255,255,255,0.022)]">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-600">Project Bytes</p>
                <p className="mt-1 truncate text-sm font-bold text-zinc-100">{formatBytes(deployBytes)}</p>
              </div>
              <div className="min-w-0 rounded-[1rem] bg-black/24 px-3 py-3 shadow-[inset_7px_7px_15px_rgba(0,0,0,0.56),inset_-7px_-7px_15px_rgba(255,255,255,0.022)]">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-600">Fee Estimate</p>
                <p className="mt-1 truncate text-sm font-bold text-zinc-100">{formatCkb(deployFee, 8)}</p>
              </div>
              <div className="min-w-0 rounded-[1rem] bg-black/24 px-3 py-3 shadow-[inset_7px_7px_15px_rgba(0,0,0,0.56),inset_-7px_-7px_15px_rgba(255,255,255,0.022)] sm:col-span-2">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-600">Build Target</p>
                <p className="mt-1 truncate text-sm font-bold text-zinc-100">
                  {builtBinary?.binaryPath ? shortMiddle(builtBinary.binaryPath, 58) : selectedContract.script || 'Pending'}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[1.1rem] border border-white/[0.08] bg-white/[0.08] px-4 py-3 text-sm font-black text-zinc-100 shadow-[10px_10px_24px_rgba(0,0,0,0.42),inset_1px_1px_0_rgba(255,255,255,0.06)] transition hover:bg-white/[0.12] disabled:opacity-45"
              disabled={!canBuild}
              onClick={() => void handleBuild()}
              type="button"
            >
              {buildStatus === 'running' ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
              {buildStatus === 'running' ? 'Building...' : 'Build'}
            </button>
            <button
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[1.1rem] border border-cyan-300/10 bg-gradient-to-r from-cyan-500/45 to-blue-600/50 px-4 py-3 text-sm font-black text-white shadow-[10px_10px_24px_rgba(0,0,0,0.42),inset_1px_1px_0_rgba(255,255,255,0.14)] transition hover:opacity-95 disabled:opacity-45"
              disabled={!canDeploy}
              onClick={() => void handleDeploy()}
              type="button"
            >
              {deployStatus === 'deploying' ? <Loader2 className="animate-spin" size={16} /> : <Rocket size={16} />}
              {deployStatus === 'deploying' ? 'Deploying...' : deployStatus === 'success' ? 'Redeploy' : 'Deploy'}
            </button>
          </div>
          {deployNote && (
            <p className="min-w-0 max-w-full overflow-hidden rounded-[1rem] border border-cyan-300/18 bg-cyan-500/10 px-3 py-2 text-sm leading-6 text-cyan-100 whitespace-pre-wrap break-all">
              {deployNote}
            </p>
          )}
        </section>

        <section className="min-w-0 space-y-3">
          <BuildProgress events={events} status={buildStatus} />
          <BuildLog events={events} />
        </section>
      </div>
    </article>
  )
}
