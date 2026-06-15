import {
  Copy,
  Eye,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  WalletCards,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatCkbBalance } from '../../lib/format'
import type { WalletItem, WalletSecret } from '../../lib/wallets'

type WalletsPanelProps = {
  wallets: WalletItem[]
  activeWallet: string | null
  loading?: boolean
  error?: string
  onSelectWallet: (walletAddress: string) => void
  onRefresh: () => Promise<void> | void
  onUpdateWalletLabel: (walletAddress: string, label: string) => Promise<void>
  onCreateWallet: (label: string) => Promise<void>
  onLinkWallet: (mnemonic: string, label: string) => Promise<void>
  onDeleteWallet: (walletAddress: string) => Promise<void>
  onExportWalletMnemonic: (walletAddress: string) => Promise<WalletSecret>
}

type AddMode = 'menu' | 'create' | 'import'
type CopyTarget = 'address' | 'mnemonic' | null

function shortAddress(address: string) {
  if (address.length <= 18) return address
  return `${address.slice(0, 10)}...${address.slice(-8)}`
}

function balanceLabel(balance: number | null) {
  return formatCkbBalance(balance)
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  label: string
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'neutral' | 'danger' | 'accent'
}) {
  const toneClass = tone === 'danger'
    ? 'text-rose-200 hover:border-rose-300/35 hover:bg-rose-500/12'
    : tone === 'accent'
      ? 'text-cyan-200 hover:border-cyan-300/35 hover:bg-cyan-500/12'
      : 'text-zinc-300 hover:border-white/25 hover:bg-white/[0.08]'

  return (
    <button
      aria-label={label}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-[0.75rem] border border-white/10 bg-white/[0.04] shadow-[7px_7px_16px_rgba(0,0,0,0.45),-5px_-5px_14px_rgba(255,255,255,0.035)] transition sm:h-9 sm:w-9 sm:rounded-[0.9rem] ${toneClass}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-3 backdrop-blur-md sm:p-5" role="dialog" aria-modal="true">
      <section className="glass-panel app-compact-scrollbar max-h-[90vh] w-[min(100%,34rem)] overflow-y-auto p-3 sm:p-5 md:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate text-xl font-bold tracking-normal text-white">{title}</h3>
          <IconButton label="Close" onClick={onClose}>
            <X size={17} strokeWidth={2.3} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  multiline?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-[0.22em] text-zinc-500">{label}</span>
      {multiline ? (
        <textarea
          className="auth-input min-h-28 resize-none"
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
      ) : (
        <input
          className="auth-input"
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
      )}
    </label>
  )
}

function WalletTile({
  wallet,
  active,
  onSelect,
  onEdit,
  onDetails,
}: {
  wallet: WalletItem
  active: boolean
  onSelect: () => void
  onEdit: () => void
  onDetails: () => void
}) {
  return (
    <article
      className={`min-h-[7.5rem] min-w-0 rounded-[0.9rem] border p-2.5 transition sm:min-h-[10.5rem] sm:rounded-[1.25rem] sm:p-3 ${
        active
          ? 'border-cyan-300/35 bg-cyan-400/[0.09] shadow-[inset_1px_1px_0_rgba(255,255,255,0.08),0_18px_34px_rgba(8,145,178,0.08)]'
          : 'border-white/10 bg-black/32 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.65),inset_-7px_-7px_16px_rgba(255,255,255,0.035)] hover:border-white/18 hover:bg-white/[0.045]'
      }`}
    >
      <div className="flex h-full flex-col">
        <div className="flex min-w-0 items-start justify-between gap-1.5 sm:gap-2">
          <button className="min-w-0 text-left" onClick={onSelect} type="button">
            <WalletCards className="text-cyan-300" size={22} strokeWidth={2.1} />
          </button>
          <div className="flex max-w-[4.25rem] shrink-0 gap-1 sm:max-w-none sm:gap-2">
            <IconButton label={`Edit ${wallet.label}`} onClick={onEdit}>
              <Pencil size={14} strokeWidth={2.3} />
            </IconButton>
            <IconButton label={`View ${wallet.label}`} onClick={onDetails}>
              <Eye size={14} strokeWidth={2.3} />
            </IconButton>
          </div>
        </div>

        <button className="mt-auto min-w-0 text-left" onClick={onSelect} type="button">
          <p className="truncate text-sm font-bold text-white">{wallet.label}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-zinc-500 sm:mt-2 sm:text-xs">{shortAddress(wallet.address)}</p>
          <p className="mt-2 text-xs font-bold text-cyan-100">
            {balanceLabel(wallet.balance)}
          </p>
        </button>
      </div>
    </article>
  )
}

export default function WalletsPanel({
  wallets,
  activeWallet,
  loading = false,
  error = '',
  onSelectWallet,
  onRefresh,
  onUpdateWalletLabel,
  onCreateWallet,
  onLinkWallet,
  onDeleteWallet,
  onExportWalletMnemonic,
}: WalletsPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [editingWallet, setEditingWallet] = useState<WalletItem | null>(null)
  const [detailWallet, setDetailWallet] = useState<WalletItem | null>(null)
  const [deletingWallet, setDeletingWallet] = useState<WalletItem | null>(null)
  const [showAddWallet, setShowAddWallet] = useState(false)
  const [addMode, setAddMode] = useState<AddMode>('menu')
  const [walletLabel, setWalletLabel] = useState('')
  const [newWalletLabel, setNewWalletLabel] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [busy, setBusy] = useState(false)
  const [modalError, setModalError] = useState('')
  const [copied, setCopied] = useState<CopyTarget>(null)

  const compactWallets = useMemo(() => wallets.slice(0, 2), [wallets])

  function resetAddModal() {
    setShowAddWallet(false)
    setAddMode('menu')
    setNewWalletLabel('')
    setMnemonic('')
    setBusy(false)
    setModalError('')
  }

  function closeEditModal() {
    setEditingWallet(null)
    setWalletLabel('')
    setBusy(false)
    setModalError('')
  }

  function closeDetailsModal() {
    setDetailWallet(null)
    setCopied(null)
    setBusy(false)
    setModalError('')
  }

  async function copyValue(value: string, target: Exclude<CopyTarget, null>) {
    await navigator.clipboard.writeText(value)
    setCopied(target)
    window.setTimeout(() => setCopied(null), 1400)
  }

  async function submitEdit() {
    if (!editingWallet) return
    const nextLabel = walletLabel.trim()
    if (!nextLabel) {
      setModalError('Wallet label is required.')
      return
    }
    setBusy(true)
    setModalError('')
    try {
      await onUpdateWalletLabel(editingWallet.address, nextLabel)
      closeEditModal()
    } catch (submitError) {
      setBusy(false)
      setModalError(submitError instanceof Error ? submitError.message : 'Could not update wallet label.')
    }
  }

  async function submitCreate() {
    const nextLabel = newWalletLabel.trim()
    if (!nextLabel) {
      setModalError('Wallet label is required.')
      return
    }
    setBusy(true)
    setModalError('')
    try {
      await onCreateWallet(nextLabel)
      resetAddModal()
    } catch (submitError) {
      setBusy(false)
      setModalError(submitError instanceof Error ? submitError.message : 'Could not create wallet.')
    }
  }

  async function submitImport() {
    const nextLabel = newWalletLabel.trim()
    const nextMnemonic = mnemonic.trim().replace(/\s+/g, ' ')
    if (!nextLabel || !nextMnemonic) {
      setModalError('Wallet label and mnemonic are required.')
      return
    }
    setBusy(true)
    setModalError('')
    try {
      await onLinkWallet(nextMnemonic, nextLabel)
      resetAddModal()
    } catch (submitError) {
      setBusy(false)
      setModalError(submitError instanceof Error ? submitError.message : 'Could not link wallet.')
    }
  }

  async function confirmDelete() {
    if (!deletingWallet) return
    setBusy(true)
    setModalError('')
    try {
      await onDeleteWallet(deletingWallet.address)
      setDeletingWallet(null)
      closeDetailsModal()
    } catch (submitError) {
      setBusy(false)
      setModalError(submitError instanceof Error ? submitError.message : 'Could not delete wallet.')
    }
  }

  function renderWalletGrid(displayWallets: WalletItem[], mode: 'compact' | 'expanded') {
    return (
      <div className={`grid min-w-0 gap-2 sm:gap-3 ${mode === 'expanded' ? 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'sm:grid-cols-2 xl:grid-cols-3'}`}>
        {displayWallets.map((wallet) => (
          <WalletTile
            active={activeWallet === wallet.address}
            key={wallet.address}
            onDetails={() => {
              setDetailWallet(wallet)
              setModalError('')
            }}
            onEdit={() => {
              setEditingWallet(wallet)
              setWalletLabel(wallet.label)
              setModalError('')
            }}
            onSelect={() => onSelectWallet(wallet.address)}
            wallet={wallet}
          />
        ))}

        <button
          className="grid min-h-[7.5rem] min-w-0 place-items-center rounded-[0.9rem] border border-dashed border-cyan-300/32 bg-cyan-500/[0.07] p-2.5 text-cyan-100 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.52),inset_-7px_-7px_16px_rgba(255,255,255,0.035)] transition hover:border-cyan-200/45 hover:bg-cyan-500/[0.11] sm:min-h-[10.5rem] sm:rounded-[1.25rem] sm:p-4"
          onClick={() => {
            setShowAddWallet(true)
            setAddMode('menu')
            setModalError('')
          }}
          type="button"
        >
          <span className="flex flex-col items-center gap-2 text-xs font-bold sm:gap-3 sm:text-sm">
            <Plus size={22} strokeWidth={2.4} />
            Add Wallet
          </span>
        </button>
      </div>
    )
  }

  return (
    <>
      <section className="glass-panel app-reveal min-w-0 max-w-full overflow-hidden p-2.5 sm:p-5 lg:col-span-2" id="wallets">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 sm:mb-4 sm:gap-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[0.9rem] bg-cyan-500/12 text-cyan-200 shadow-[inset_6px_6px_14px_rgba(0,0,0,0.58),inset_-5px_-5px_12px_rgba(255,255,255,0.04)] sm:h-10 sm:w-10 sm:rounded-[1rem]">
              <WalletCards size={21} strokeWidth={2.3} />
            </span>
            <div className="min-w-0">
              <p className="auth-kicker">Linked Wallets</p>
              <p className="mt-1 truncate text-sm text-zinc-500">{wallets.length} total</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <IconButton label="Refresh wallets" disabled={loading} onClick={() => void onRefresh()}>
              <RefreshCw className={loading ? 'animate-spin' : ''} size={16} strokeWidth={2.3} />
            </IconButton>
            <IconButton label="Expand wallets" onClick={() => setExpanded(true)}>
              <Maximize2 size={16} strokeWidth={2.3} />
            </IconButton>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-[1rem] border border-rose-300/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            {error}
          </div>
        )}

        {renderWalletGrid(compactWallets, 'compact')}

        {wallets.length > compactWallets.length && (
          <p className="mt-3 text-xs font-medium text-zinc-500">Showing recent {compactWallets.length} of {wallets.length}</p>
        )}
      </section>

      {expanded && (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-black/75 p-3 backdrop-blur-md sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded linked wallets"
        >
          <section className="glass-panel mx-auto flex max-h-[92vh] w-[min(100%,68rem)] flex-col p-3 sm:p-5">
            <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-[1rem] bg-cyan-500/12 text-cyan-200 shadow-[inset_6px_6px_14px_rgba(0,0,0,0.58),inset_-5px_-5px_12px_rgba(255,255,255,0.04)]">
                  <WalletCards size={21} strokeWidth={2.3} />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-xl font-bold tracking-normal text-white">Linked Wallets</h3>
                  <p className="mt-1 text-sm text-zinc-500">{wallets.length} total</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <IconButton label="Refresh wallets" disabled={loading} onClick={() => void onRefresh()}>
                  <RefreshCw className={loading ? 'animate-spin' : ''} size={16} strokeWidth={2.3} />
                </IconButton>
                <IconButton label="Minimize wallets" onClick={() => setExpanded(false)}>
                  <Minimize2 size={16} strokeWidth={2.3} />
                </IconButton>
                <IconButton label="Close expanded wallets" onClick={() => setExpanded(false)}>
                  <X size={16} strokeWidth={2.3} />
                </IconButton>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {renderWalletGrid(wallets, 'expanded')}
            </div>
          </section>
        </div>
      )}

      {editingWallet && (
        <ModalShell title="Edit Wallet" onClose={closeEditModal}>
          <div className="space-y-4">
            <div className="truncate rounded-[1rem] border border-white/10 bg-black/35 p-3 font-mono text-xs text-zinc-400">
              {editingWallet.address}
            </div>
            <Field label="Label" onChange={setWalletLabel} placeholder="Main" value={walletLabel} />
            {modalError && <p className="text-sm text-rose-200">{modalError}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <button className="auth-ghost-button" onClick={closeEditModal} type="button">Cancel</button>
              <button className="auth-primary-button" disabled={busy} onClick={() => void submitEdit()} type="button">
                {busy ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {detailWallet && (
        <ModalShell title={detailWallet.label} onClose={closeDetailsModal}>
          <div className="space-y-4">
            <div className="rounded-[1.15rem] border border-white/10 bg-black/35 p-4">
              <span className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-500">Address</span>
              <p className="mt-2 break-all font-mono text-sm leading-6 text-zinc-200">{detailWallet.address}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button className="auth-ghost-button inline-flex items-center justify-center gap-2" onClick={() => void copyValue(detailWallet.address, 'address')} type="button">
                <Copy size={16} />
                {copied === 'address' ? 'Copied' : 'Copy'}
              </button>
              <button
                className="auth-ghost-button inline-flex items-center justify-center gap-2"
                onClick={() => {
                  setEditingWallet(detailWallet)
                  setWalletLabel(detailWallet.label)
                  setDetailWallet(null)
                }}
                type="button"
              >
                <Pencil size={16} />
                Rename
              </button>
              <button
                className="auth-ghost-button inline-flex items-center justify-center gap-2"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setModalError('')
                  try {
                    const secret = await onExportWalletMnemonic(detailWallet.address)
                    await copyValue(secret.mnemonic, 'mnemonic')
                  } catch (submitError) {
                    setModalError(submitError instanceof Error ? submitError.message : 'Could not export mnemonic.')
                  } finally {
                    setBusy(false)
                  }
                }}
                type="button"
              >
                <Upload size={16} />
                {busy ? 'Authenticating...' : copied === 'mnemonic' ? 'Mnemonic Copied' : 'Export Mnemonic'}
              </button>
              <button
                className="auth-ghost-button inline-flex items-center justify-center gap-2 border-rose-300/20 bg-rose-500/10 text-rose-100"
                onClick={() => setDeletingWallet(detailWallet)}
                type="button"
              >
                <Trash2 size={16} />
                Delete
              </button>
            </div>
            {modalError && <p className="text-sm text-rose-200">{modalError}</p>}
          </div>
        </ModalShell>
      )}

      {showAddWallet && (
        <ModalShell title="Add Wallet" onClose={resetAddModal}>
          {addMode === 'menu' && (
            <div className="grid gap-3">
              <button className="auth-primary-button inline-flex items-center justify-center gap-2" onClick={() => setAddMode('create')} type="button">
                <Plus size={18} />
                Create New Wallet
              </button>
              <button className="auth-ghost-button inline-flex items-center justify-center gap-2" onClick={() => setAddMode('import')} type="button">
                <WalletCards size={18} />
                Link Existing Wallet
              </button>
            </div>
          )}

          {addMode === 'create' && (
            <div className="space-y-4">
              <Field label="Label" onChange={setNewWalletLabel} placeholder="backup" value={newWalletLabel} />
              {modalError && <p className="text-sm text-rose-200">{modalError}</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                <button className="auth-ghost-button" onClick={() => setAddMode('menu')} type="button">Back</button>
                <button className="auth-primary-button" disabled={busy} onClick={() => void submitCreate()} type="button">
                  {busy ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          )}

          {addMode === 'import' && (
            <div className="space-y-4">
              <Field label="Label" onChange={setNewWalletLabel} placeholder="backup" value={newWalletLabel} />
              <Field label="Mnemonic" multiline onChange={setMnemonic} placeholder="recovery phrase" value={mnemonic} />
              {modalError && <p className="text-sm text-rose-200">{modalError}</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                <button className="auth-ghost-button" onClick={() => setAddMode('menu')} type="button">Back</button>
                <button className="auth-primary-button" disabled={busy} onClick={() => void submitImport()} type="button">
                  {busy ? 'Linking...' : 'Link'}
                </button>
              </div>
            </div>
          )}
        </ModalShell>
      )}

      {deletingWallet && (
        <ModalShell title="Delete Wallet" onClose={() => setDeletingWallet(null)}>
          <div className="space-y-4">
            <p className="text-sm leading-6 text-zinc-400">
              Remove {deletingWallet.label} from this account?
            </p>
            {modalError && <p className="text-sm text-rose-200">{modalError}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <button className="auth-ghost-button" onClick={() => setDeletingWallet(null)} type="button">Cancel</button>
              <button className="auth-primary-button bg-rose-100 text-black" disabled={busy} onClick={() => void confirmDelete()} type="button">
                {busy ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  )
}
