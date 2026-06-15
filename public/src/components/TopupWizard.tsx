import {
  Check,
  ChevronLeft,
  CircleDollarSign,
  Copy,
  ExternalLink,
  Loader2,
  Radio,
  ReceiptText,
  Send,
  WalletCards,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchWalletBalances } from '../lib/balances.ts'
import { getStoredAccessToken, getStoredDeviceId, setDeviceCookie, setSessionCookie } from '../lib/session'
import { apiPath } from '../lib/api'

export type Network = 'devnet' | 'testnet' | 'mainnet'

type Wallet = { address: string; label: string }

type TopupWizardProps = {
  show: boolean
  onClose: () => void
  wallets?: Wallet[]
  activeWalletLabel: string
  activeWalletAddress: string | null
  onSelectWallet?: (address: string | null) => void
  network: Network
  uptimeStatus: 'checking' | 'online' | 'offline'
}

type FundingStatus = 'idle' | 'streaming' | 'success' | 'error'
type WizardStep = 1 | 2 | 3

type FundingEvent = {
  type?: string
  requestId?: string
  phase?: string
  status?: string
  service?: string
  message?: string
  error?: string | null
  txHash?: string | null
  createdAt?: string
}

type ProgressItem = {
  id: string
  phase: string
  status: string
  message: string
  service: string
  txHash: string | null
  createdAt: string
}

const devnetSteps: Array<{ id: WizardStep; label: string; icon: LucideIcon }> = [
  { id: 1, label: 'Wallet', icon: WalletCards },
  { id: 2, label: 'Amount', icon: CircleDollarSign },
  { id: 3, label: 'Stream', icon: Radio },
]

const publicTopupSteps: Array<{ id: WizardStep; label: string; icon: LucideIcon }> = [
  { id: 1, label: 'Wallet', icon: WalletCards },
  { id: 2, label: 'Address', icon: Copy },
  { id: 3, label: 'Ready', icon: ExternalLink },
]

const networkLabels: Record<Network, string> = {
  devnet: 'Devnet',
  testnet: 'Testnet',
  mainnet: 'Mainnet',
}

const TESTNET_FAUCET_URL = 'https://faucet.nervos.org/'

function shortAddress(address: string) {
  if (address.length <= 22) return address
  return `${address.slice(0, 12)}...${address.slice(-8)}`
}

function shortHash(hash: string) {
  if (hash.length <= 24) return hash
  return `${hash.slice(0, 14)}...${hash.slice(-10)}`
}

function nowLabel() {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date())
}

function normalizeProgressEvent(event: FundingEvent, index: number): ProgressItem {
  return {
    id: `${event.requestId || 'fund'}-${event.phase || event.type || 'event'}-${index}`,
    phase: String(event.phase || event.type || 'started'),
    status: String(event.status || (event.type === 'funding-started' ? 'started' : 'running')),
    message: String(event.message || (event.type === 'funding-started' ? 'Funding stream opened.' : 'Processing...')),
    service: String(event.service || 'orbital-server'),
    txHash: event.txHash || null,
    createdAt: event.createdAt
      ? new Intl.DateTimeFormat(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date(event.createdAt))
      : nowLabel(),
  }
}

function phaseTone(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === 'completed' || normalized === 'success') return 'border-emerald-300/35 bg-emerald-400/[0.09] text-emerald-100'
  if (normalized === 'failed' || normalized === 'error') return 'border-rose-300/30 bg-rose-500/10 text-rose-100'
  if (normalized === 'queued') return 'border-cyan-300/25 bg-cyan-500/[0.08] text-cyan-100'
  return 'border-white/10 bg-white/[0.045] text-zinc-200'
}

export default function TopupWizard({
  show,
  onClose,
  wallets = [],
  activeWalletLabel,
  activeWalletAddress,
  onSelectWallet,
  network,
  uptimeStatus,
}: TopupWizardProps) {
  const [fundingAmount, setFundingAmount] = useState('100')
  const [fundingStatus, setFundingStatus] = useState<FundingStatus>('idle')
  const [fundingMessage, setFundingMessage] = useState('')
  const [fundingProgress, setFundingProgress] = useState<ProgressItem[]>([])
  const [wizardStep, setWizardStep] = useState<WizardStep>(1)
  const [wizardSelectedWallet, setWizardSelectedWallet] = useState<string | null>(activeWalletAddress)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [copiedAddress, setCopiedAddress] = useState(false)

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.address === wizardSelectedWallet) || null,
    [wallets, wizardSelectedWallet],
  )
  const isDevnet = network === 'devnet'
  const stepItems = isDevnet ? devnetSteps : publicTopupSteps
  const networkLabel = networkLabels[network]
  const topupReady = isDevnet ? uptimeStatus === 'online' : Boolean(wizardSelectedWallet)
  const amount = Number(fundingAmount)
  const amountValid = Number.isFinite(amount) && amount >= 62
  const canFund = isDevnet && uptimeStatus === 'online' && Boolean(wizardSelectedWallet) && amountValid
  const isBusy = fundingStatus === 'streaming'

  useEffect(() => {
    if (!show) return
    setWizardStep(1)
    setWizardSelectedWallet(activeWalletAddress)
    setFundingAmount('100')
    setFundingStatus('idle')
    setFundingProgress([])
    setFundingMessage('')
    setRequestId(null)
    setCopiedAddress(false)
  }, [show, activeWalletAddress, network])

  async function refreshFundedWallet(walletAddress: string) {
    try {
      const balances = await fetchWalletBalances([walletAddress], 'devnet')
      window.dispatchEvent(new CustomEvent('walletBalancesUpdated', { detail: { balances } }))
    } catch {
      // The funding stream is still the source of truth for this modal.
    }
  }

  function addProgress(event: FundingEvent) {
    setFundingProgress((current) => [...current, normalizeProgressEvent(event, current.length)])
    if (event.requestId) setRequestId(String(event.requestId))
    if (event.message) setFundingMessage(String(event.message))
  }

  async function copySelectedAddress() {
    if (!wizardSelectedWallet) return
    await navigator.clipboard.writeText(wizardSelectedWallet)
    setCopiedAddress(true)
    setWizardStep(3)
    window.setTimeout(() => setCopiedAddress(false), 1400)
  }

  async function readFundingStream(response: Response, walletAddress: string): Promise<FundingEvent | null> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Funding stream did not include a response body.')

    const decoder = new TextDecoder()
    let buffer = ''
    const latest: { event: FundingEvent | null } = { event: null }

    async function handleLine(line: string) {
      if (!line.trim()) return
      const event = JSON.parse(line) as FundingEvent
      latest.event = event
      addProgress(event)

      const phase = String(event.phase || '').toLowerCase()
      const status = String(event.status || '').toLowerCase()
      if (phase === 'completed' || status === 'completed') {
        await refreshFundedWallet(walletAddress)
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (value) {
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          await handleLine(line)
        }
      }
      if (done) break
    }

    if (buffer.trim()) {
      await handleLine(buffer)
    }

    return latest.event
  }

  async function handleFunding() {
    const walletAddress = wizardSelectedWallet ?? activeWalletAddress
    if (network !== 'devnet' || uptimeStatus !== 'online') {
      setFundingMessage('Devnet must be reachable to use funding.')
      setFundingStatus('error')
      setWizardStep(3)
      return
    }
    if (!amountValid) {
      setFundingMessage('Amount must be at least 62 CKB.')
      setFundingStatus('error')
      setWizardStep(2)
      return
    }
    if (!walletAddress) {
      setFundingMessage('Select a wallet before starting the topup.')
      setFundingStatus('error')
      setWizardStep(1)
      return
    }

    setWizardStep(3)
    setFundingStatus('streaming')
    setFundingMessage('Opening funding stream...')
    setFundingProgress([])
    setRequestId(null)

    try {
      const token = getStoredAccessToken()
      const deviceId = getStoredDeviceId()
      const response = await fetch(apiPath('/wallets/devnet/fund'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(deviceId ? { 'x-device-id': deviceId } : {}),
        },
        body: JSON.stringify({
          address: walletAddress,
          amountInCKB: amount,
          retryCount: 3,
        }),
      })

      const refreshedToken = response.headers.get('x-access-token')
      const refreshedDevice = response.headers.get('x-device-id')
      if (refreshedToken) setSessionCookie(refreshedToken)
      if (refreshedDevice) setDeviceCookie(refreshedDevice)

      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { message?: string; error?: string }
        throw new Error(error.message || error.error || `Funding request failed (${response.status})`)
      }

      const lastEvent = await readFundingStream(response, walletAddress)
      const phase = String(lastEvent?.phase || '').toLowerCase()
      const status = String(lastEvent?.status || '').toLowerCase()
      if (phase === 'failed' || status === 'failed') {
        setFundingStatus('error')
        setFundingMessage(lastEvent?.error || lastEvent?.message || 'Funding failed.')
        return
      }
      if (phase === 'completed' || status === 'completed') {
        setFundingStatus('success')
        setFundingMessage(lastEvent?.message || 'Topup completed.')
        return
      }
      setFundingStatus('error')
      setFundingMessage('Funding stream ended before completion.')
    } catch (error) {
      setFundingStatus('error')
      setFundingMessage(error instanceof Error ? error.message : 'Funding failed.')
    }
  }

  if (!show) return null

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-5">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={isBusy ? undefined : onClose} />

      <section className="glass-panel relative z-50 flex max-h-[92vh] w-[min(100%,58rem)] flex-col overflow-hidden">
        <div className="shrink-0 border-b border-white/10 bg-black/35 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="auth-kicker">{networkLabel} Topup</p>
              <h2 className="mt-2 text-2xl font-bold tracking-normal text-white">Topup</h2>
            </div>
            <div className="flex items-center gap-2">
              {stepItems.map((step) => {
                const Icon = step.icon
                const active = wizardStep === step.id
                const complete = isDevnet
                  ? wizardStep > step.id || (step.id === 3 && fundingStatus === 'success')
                  : wizardStep > step.id || (step.id === 3 && copiedAddress)
                return (
                  <button
                    aria-label={`${step.label} step`}
                    className={`grid h-11 w-11 place-items-center rounded-[1rem] border transition ${
                      active
                        ? 'border-cyan-300/35 bg-cyan-400/[0.1] text-cyan-100 shadow-[inset_6px_6px_14px_rgba(0,0,0,0.54),inset_-5px_-5px_12px_rgba(255,255,255,0.04)]'
                        : complete
                          ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100'
                          : 'border-white/10 bg-white/[0.035] text-zinc-400'
                    }`}
                    disabled={isBusy || (isDevnet && step.id === 3) || (step.id === 2 && !wizardSelectedWallet) || (!isDevnet && step.id === 3 && !wizardSelectedWallet)}
                    key={step.id}
                    onClick={() => setWizardStep(step.id)}
                    title={step.label}
                    type="button"
                  >
                    {complete ? <Check size={18} /> : <Icon size={18} />}
                  </button>
                )
              })}
            </div>
            <button
              aria-label="Close topup wizard"
              className="grid h-10 w-10 place-items-center rounded-[1rem] border border-white/10 bg-white/[0.04] text-zinc-300 transition hover:border-white/25 hover:bg-white/[0.08]"
              disabled={isBusy}
              onClick={onClose}
              type="button"
            >
              <X size={17} strokeWidth={2.35} />
            </button>
          </div>
        </div>

        <div className="app-compact-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="auth-kicker">Coordinated Flow</p>
              <h3 className="mt-2 text-2xl font-bold tracking-normal text-white sm:text-3xl">
                {isDevnet ? 'Fund a devnet wallet' : `${networkLabel} wallet topup`}
              </h3>
            </div>
            <div className={`rounded-[1rem] border px-3 py-2 text-xs font-bold uppercase tracking-[0.2em] ${
              topupReady
                ? 'border-emerald-300/25 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-300/25 bg-rose-500/10 text-rose-200'
            }`}>
              {topupReady ? 'Ready' : isDevnet ? 'Unavailable' : 'Select wallet'}
            </div>
          </header>

          <div className="grid gap-4 lg:grid-cols-[1fr_17rem]">
            <section className="grid gap-4">
              {wizardStep === 1 && (
                <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-4 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.58),inset_-7px_-7px_16px_rgba(255,255,255,0.035)]">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-[1rem] bg-cyan-500/12 text-cyan-200">
                      <WalletCards size={20} strokeWidth={2.3} />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-white">Choose wallet</p>
                      <p className="mt-1 text-xs text-zinc-500">{wallets.length} linked wallets available</p>
                    </div>
                  </div>

                  <div className="app-compact-scrollbar mt-4 grid max-h-[21rem] gap-2 overflow-y-auto pr-2">
                    {wallets.length === 0 && (
                      <div className="rounded-[1rem] border border-white/10 bg-white/[0.035] p-4 text-sm text-zinc-400">
                        Create or link a {networkLabel.toLowerCase()} wallet before using topup.
                      </div>
                    )}
                    {wallets.map((wallet) => {
                      const selected = wizardSelectedWallet === wallet.address
                      return (
                        <button
                          className={`rounded-[1.1rem] border p-3 text-left transition ${
                            selected
                              ? 'border-cyan-300/35 bg-cyan-400/[0.09] shadow-[0_16px_30px_rgba(8,145,178,0.08)]'
                              : 'border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]'
                          }`}
                          key={wallet.address}
                          onClick={() => {
                            setWizardSelectedWallet(wallet.address)
                            onSelectWallet?.(wallet.address)
                          }}
                          type="button"
                        >
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-bold text-white">{wallet.label}</p>
                              <p className="mt-1 truncate font-mono text-xs text-zinc-500" title={wallet.address}>
                                {shortAddress(wallet.address)}
                              </p>
                            </div>
                            {selected && (
                              <span className="shrink-0 rounded-full bg-cyan-300/12 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-100">
                                Active
                              </span>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {isDevnet && wizardStep === 2 && (
                <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-4 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.58),inset_-7px_-7px_16px_rgba(255,255,255,0.035)]">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-[1rem] bg-emerald-500/12 text-emerald-200">
                      <CircleDollarSign size={20} strokeWidth={2.3} />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-white">Set amount</p>
                      <p className="mt-1 text-xs text-zinc-500">Minimum faucet transfer is 62 CKB.</p>
                    </div>
                  </div>

                  <label className="mt-5 block">
                    <span className="mb-2 block text-xs font-bold uppercase tracking-[0.22em] text-zinc-500">Amount</span>
                    <div className="relative">
                      <input
                        className="auth-input app-no-spin pr-16 font-mono"
                        disabled={isBusy}
                        min="62"
                        onChange={(event) => setFundingAmount(event.target.value)}
                        placeholder="100"
                        step="1"
                        type="number"
                        value={fundingAmount}
                      />
                      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-500">
                        CKB
                      </span>
                    </div>
                  </label>

                  {!amountValid && (
                    <p className="mt-3 text-sm text-rose-200">Enter at least 62 CKB.</p>
                  )}

                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {['100', '250', '500'].map((preset) => (
                      <button
                        className="rounded-[1rem] border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-bold text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.07]"
                        disabled={isBusy}
                        key={preset}
                        onClick={() => setFundingAmount(preset)}
                        type="button"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-[0.42fr_1fr]">
                    <button
                      className="auth-ghost-button inline-flex items-center justify-center gap-2"
                      disabled={isBusy}
                      onClick={() => setWizardStep(1)}
                      type="button"
                    >
                      <ChevronLeft size={17} />
                      Back
                    </button>
                    <button
                      className="auth-primary-button inline-flex items-center justify-center gap-2"
                      disabled={!canFund || isBusy}
                      onClick={() => void handleFunding()}
                      type="button"
                    >
                      <Send size={17} />
                      Start Topup
                    </button>
                  </div>
                </div>
              )}

              {!isDevnet && wizardStep === 2 && (
                <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-4 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.58),inset_-7px_-7px_16px_rgba(255,255,255,0.035)]">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-[1rem] bg-cyan-500/12 text-cyan-200">
                      <Copy size={20} strokeWidth={2.3} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-white">Copy wallet address</p>
                      <p className="mt-1 text-xs text-zinc-500">{selectedWallet?.label || activeWalletLabel}</p>
                    </div>
                  </div>

                  <div className="mt-5 rounded-[1.1rem] border border-white/10 bg-white/[0.035] p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Wallet Address</p>
                    <p className="mt-3 truncate font-mono text-sm text-zinc-100" title={wizardSelectedWallet || ''}>
                      {wizardSelectedWallet ? shortAddress(wizardSelectedWallet) : 'none selected'}
                    </p>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-[0.42fr_1fr]">
                    <button
                      className="auth-ghost-button inline-flex items-center justify-center gap-2"
                      onClick={() => setWizardStep(1)}
                      type="button"
                    >
                      <ChevronLeft size={17} />
                      Back
                    </button>
                    <button
                      className="auth-primary-button inline-flex items-center justify-center gap-2"
                      disabled={!wizardSelectedWallet}
                      onClick={() => void copySelectedAddress()}
                      type="button"
                    >
                      <Copy size={17} />
                      {copiedAddress ? 'Copied' : 'Copy Address'}
                    </button>
                  </div>
                </div>
              )}

              {!isDevnet && wizardStep === 3 && (
                <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-4 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.58),inset_-7px_-7px_16px_rgba(255,255,255,0.035)]">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-[1rem] bg-emerald-500/12 text-emerald-200">
                      <ExternalLink size={20} strokeWidth={2.3} />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-white">{networkLabel} address ready</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {network === 'testnet' ? 'Use the faucet link after copying your address.' : 'Use the copied address with your preferred wallet flow.'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-3">
                    {network === 'testnet' && (
                      <a
                        className="auth-primary-button inline-flex items-center justify-center gap-2 no-underline"
                        href={TESTNET_FAUCET_URL}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink size={17} />
                        Open Testnet Faucet
                      </a>
                    )}
                    <button className="auth-ghost-button inline-flex items-center justify-center gap-2" onClick={onClose} type="button">
                      Close
                    </button>
                  </div>
                </div>
              )}

              {isDevnet && wizardStep === 3 && (
                <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-4 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.58),inset_-7px_-7px_16px_rgba(255,255,255,0.035)]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-[1rem] bg-cyan-500/12 text-cyan-200">
                        {fundingStatus === 'streaming' ? <Loader2 className="animate-spin" size={20} /> : <ReceiptText size={20} />}
                      </span>
                      <div>
                        <p className="text-sm font-bold text-white">Live progress</p>
                        <p className="mt-1 text-xs text-zinc-500">{fundingMessage || 'Waiting for stream.'}</p>
                      </div>
                    </div>
                    {fundingStatus === 'streaming' && (
                      <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-emerald-200">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
                        Realtime
                      </span>
                    )}
                  </div>

                  <div className="app-compact-scrollbar mt-4 grid max-h-[23rem] gap-2 overflow-y-auto pr-2">
                    {fundingProgress.length === 0 && (
                      <div className="rounded-[1rem] border border-white/10 bg-white/[0.035] p-4 text-sm text-zinc-400">
                        {fundingStatus === 'streaming' ? 'Opening the stream...' : 'Start funding to see each phase here.'}
                      </div>
                    )}
                    {fundingProgress.map((event) => (
                      <article className={`rounded-[1rem] border p-3 ${phaseTone(event.status)}`} key={event.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-mono text-xs font-bold uppercase tracking-[0.16em]">{event.phase}</p>
                          <span className="text-[11px] font-bold text-zinc-500">{event.createdAt}</span>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-zinc-300">{event.message}</p>
                        {event.txHash && (
                          <p className="mt-2 truncate font-mono text-[11px] text-emerald-200" title={event.txHash}>
                            {shortHash(event.txHash)}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <aside className="grid content-start gap-4">
              <div className="rounded-[1.35rem] border border-white/10 bg-white/[0.035] p-4 shadow-[10px_10px_24px_rgba(0,0,0,0.45),-7px_-7px_18px_rgba(255,255,255,0.035)]">
                <p className="auth-kicker">Summary</p>
                <div className="mt-4 grid gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Wallet</p>
                    <p className="mt-1 truncate text-sm font-bold text-white">{selectedWallet?.label || activeWalletLabel}</p>
                    <p className="mt-1 truncate font-mono text-xs text-zinc-500">
                      {wizardSelectedWallet ? shortAddress(wizardSelectedWallet) : 'none selected'}
                    </p>
                  </div>
                  <div className="h-px bg-white/10" />
                  {isDevnet ? (
                    <>
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Amount</p>
                        <p className="mt-1 text-2xl font-bold text-white">{Number.isFinite(amount) ? amount.toLocaleString() : '0'} CKB</p>
                      </div>
                      <div className="h-px bg-white/10" />
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Request</p>
                        <p className="mt-1 truncate font-mono text-xs text-zinc-400">{requestId || 'not started'}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Network</p>
                        <p className="mt-1 text-2xl font-bold text-white">{networkLabel}</p>
                      </div>
                      <div className="h-px bg-white/10" />
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Address</p>
                        <p className="mt-1 truncate font-mono text-xs text-zinc-400" title={wizardSelectedWallet || ''}>
                          {wizardSelectedWallet ? shortAddress(wizardSelectedWallet) : 'not selected'}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {fundingStatus === 'error' && (
                <div className="rounded-[1.15rem] border border-rose-300/25 bg-rose-500/10 p-4 text-sm leading-6 text-rose-100">
                  {fundingMessage || 'Topup failed.'}
                </div>
              )}
              {fundingStatus === 'success' && (
                <div className="rounded-[1.15rem] border border-emerald-300/25 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-100">
                  {fundingMessage || 'Topup completed.'}
                </div>
              )}

              <div className="grid gap-3">
                {wizardStep === 1 && (
                  <button
                    className="auth-primary-button"
                    disabled={!wizardSelectedWallet}
                    onClick={() => setWizardStep(2)}
                    type="button"
                  >
                    Continue
                  </button>
                )}

                {!isDevnet && wizardStep === 2 && (
                  <button
                    className="auth-primary-button"
                    disabled={!wizardSelectedWallet}
                    onClick={() => setWizardStep(3)}
                    type="button"
                  >
                    Continue
                  </button>
                )}

                {isDevnet && wizardStep === 3 && fundingStatus !== 'streaming' && (
                  <button className="auth-primary-button" onClick={onClose} type="button">
                    Close
                  </button>
                )}
              </div>
            </aside>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
