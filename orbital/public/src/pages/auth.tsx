import { useEffect, useMemo, useState } from 'react'
import { Rotate3D } from 'lucide-react'
import {
  DASH_PAGE_PATH,
  getOrCreateDeviceId,
  setDeviceCookie,
  setSessionCookie,
} from '../lib/session'
import { GRAPHQL_ENDPOINT } from '../lib/graphql'

type Mode = 'create' | 'existing' | 'recover'
type CreateStep = 'choose' | 'username' | 'wallet' | 'passkey' | 'done'
type ExistingStep = 'choose' | 'username' | 'passkey' | 'mnemonic' | 'done'
type WalletReviewStep = 'mnemonic' | 'addresses' | 'confirm'

type UsernameState = {
  status: 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'error'
  message: string
  normalized: string
}

type WalletMaterial = {
  address: string
  addresses: {
    devnet: string
    testnet: string
    mainnet: string
  }
  mnemonic: string
  privkey: string
  pubkey: string
}

type AccountStatus = {
  exists: boolean
  hasPasskey: boolean
  username: string
}

type GraphqlResponse<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

const GRAPHQL_URL = GRAPHQL_ENDPOINT
const NETWORK = 'devnet'
const SITE_NAME = 'Orbital'

function normalizeMnemonicInput(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexFromText(value: string) {
  return bytesToHex(new TextEncoder().encode(value)).slice(0, 128).padEnd(16, '0')
}

function randomChallenge() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}

function passkeyErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Passkey creation was cancelled.'
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Passkey ceremony failed.'
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = (await response.json()) as GraphqlResponse<T>
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || 'GraphQL request failed.')
  }
  if (!payload.data) {
    throw new Error('GraphQL response did not include data.')
  }
  return payload.data
}

async function validateUsername(username: string) {
  const data = await graphql<{
    validateUsername: {
      ok: boolean
      available: boolean
      normalized: string
      reason: string | null
    }
  }>(
    `query ValidateUsername($username: String!) {
      validateUsername(username: $username) {
        ok
        available
        normalized
        reason
      }
    }`,
    { username },
  )
  return data.validateUsername
}

async function getAccountStatus(username: string) {
  const data = await graphql<{ accountAuthStatus: AccountStatus }>(
    `query AccountAuthStatus($username: String!) {
      accountAuthStatus(username: $username) {
        exists
        hasPasskey
        username
      }
    }`,
    { username },
  )
  return data.accountAuthStatus
}

async function createAccount(username: string) {
  const data = await graphql<{
    createAccount: {
      ok: boolean
      owner: { uuid: string; username: string }
      wallet: WalletMaterial
    }
  }>(
    `mutation CreateAccount($username: String!, $network: String!) {
      createAccount(username: $username, network: $network) {
        ok
        owner {
          uuid
          username
        }
        wallet {
          address
          mnemonic
          privkey
          pubkey
          addresses {
            devnet
            testnet
            mainnet
          }
        }
      }
    }`,
    { username, network: NETWORK },
  )
  return data.createAccount
}

async function login(username: string, passkeyProof: string, deviceId: string) {
  const data = await graphql<{
    login: {
      ok: boolean
      accessToken: string
      owner: { username: string }
      wallet: {
        address: string
        addresses: WalletMaterial['addresses']
        pubkey: string
      }
    }
  }>(
    `mutation Login($username: String!, $passkeyProof: String!, $deviceId: String!) {
      login(username: $username, passkeyProof: $passkeyProof, deviceId: $deviceId) {
        ok
        accessToken
        owner {
          username
        }
        wallet {
          address
          pubkey
          addresses {
            devnet
            testnet
            mainnet
          }
        }
      }
    }`,
    { username, passkeyProof, deviceId },
  )
  return data.login
}

async function recoverAccount(username: string, mnemonic: string, deviceId: string, passkeyProof?: string) {
  const data = await graphql<{
    recoverAccount: {
      ok: boolean
      accessToken: string
      passkeyProof: string
      owner: { username: string }
      wallet: {
        address: string
        addresses: WalletMaterial['addresses']
        pubkey: string
      }
    }
  }>(
    `mutation RecoverAccount($username: String!, $mnemonic: String!, $passkeyProof: String, $deviceId: String!) {
      recoverAccount(username: $username, mnemonic: $mnemonic, passkeyProof: $passkeyProof, deviceId: $deviceId) {
        ok
        accessToken
        passkeyProof
        owner {
          username
        }
        wallet {
          address
          pubkey
          addresses {
            devnet
            testnet
            mainnet
          }
        }
      }
    }`,
    { username, mnemonic, passkeyProof, deviceId },
  )
  return data.recoverAccount
}

async function createPasskeyProof(hiddenUserId: string, privateKeyHint?: string) {
  const challenge = randomChallenge()
  const userId = hiddenUserId.trim()
  const fallbackSeed = `${userId}:${privateKeyHint || bytesToHex(challenge)}`

  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    return hexFromText(fallbackSeed)
  }

  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: {
          name: SITE_NAME,
        },
        user: {
          id: new TextEncoder().encode(userId),
          name: SITE_NAME,
          displayName: SITE_NAME,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      },
    }) as PublicKeyCredential | null

    if (!credential) return hexFromText(fallbackSeed)
    return hexFromText(`${userId}:${credential.id}:${privateKeyHint || ''}`)
  } catch (error) {
    throw new Error(passkeyErrorMessage(error))
  }
}

async function authenticatePasskeyProof(username: string) {
  const challenge = randomChallenge()
  const fallbackSeed = `${username}:${bytesToHex(challenge)}`

  if (!window.PublicKeyCredential || !navigator.credentials?.get) {
    return hexFromText(fallbackSeed)
  }

  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'preferred',
      },
    }) as PublicKeyCredential | null

    if (!credential) return hexFromText(fallbackSeed)
    return hexFromText(`${username}:${credential.id}`)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error('Passkey authentication was cancelled.')
    }
    throw new Error(error instanceof Error ? error.message : 'Passkey authentication failed.')
  }
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  type?: string
  disabled?: boolean
}) {
  return (
    <label className="block text-left">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">
        {label}
      </span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="auth-input"
      />
    </label>
  )
}

function SecretBox({
  label,
  value,
}: {
  label: string
  value: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-4 shadow-[inset_8px_8px_18px_rgba(0,0,0,0.7),inset_-8px_-8px_18px_rgba(255,255,255,0.04)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">{label}</span>
        <button type="button" onClick={copy} className="auth-ghost-button px-3 py-2 text-xs">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="break-all font-mono text-sm leading-6 text-zinc-200">{value}</p>
    </div>
  )
}

function AddressList({
  addresses,
}: {
  addresses: WalletMaterial['addresses']
}) {
  const rows = [
    ['Devnet', addresses.devnet],
    ['Testnet', addresses.testnet],
    ['Mainnet', addresses.mainnet],
  ]

  return (
    <div className="grid gap-3">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="rounded-[1.15rem] border border-white/10 bg-black/30 p-3 shadow-[inset_7px_7px_16px_rgba(0,0,0,0.7),inset_-7px_-7px_16px_rgba(255,255,255,0.04)]"
        >
          <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
            {label}
          </span>
          <p className="break-all font-mono text-xs leading-5 text-zinc-200 sm:text-sm">{value}</p>
        </div>
      ))}
    </div>
  )
}

export default function AuthPage() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [createStep, setCreateStep] = useState<CreateStep>('choose')
  const [existingStep, setExistingStep] = useState<ExistingStep>('choose')
  const [username, setUsername] = useState('')
  const [existingUsername, setExistingUsername] = useState('')
  const [recoveryMnemonic, setRecoveryMnemonic] = useState('')
  const [wallet, setWallet] = useState<WalletMaterial | null>(null)
  const [createdUserUuid, setCreatedUserUuid] = useState('')
  const [walletReviewStep, setWalletReviewStep] = useState<WalletReviewStep>('mnemonic')
  const [savedSecrets, setSavedSecrets] = useState(false)
  const [deviceId] = useState(() => getOrCreateDeviceId())
  const [usernameState, setUsernameState] = useState<UsernameState>({
    status: 'idle',
    message: 'Pick a name for your wallet.',
    normalized: '',
  })
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const steps = useMemo(() => {
    if (mode === 'create') return ['Choose', 'Username', 'Keys', 'Passkey']
    if (mode === 'existing') return ['Choose', 'Account', status?.hasPasskey ? 'Passkey' : 'Recover']
    if (mode === 'recover') return ['Choose', 'Recovery', 'Passkey']
    return ['Choose', 'Secure', 'Session']
  }, [mode, status?.hasPasskey])

  useEffect(() => {
    if (mode !== 'create') return
    const trimmed = username.trim()
    if (!trimmed) {
      setUsernameState({
        status: 'idle',
        message: 'Pick a name for your wallet.',
        normalized: '',
      })
      return
    }

    let cancelled = false
    setUsernameState((current) => ({
      ...current,
      status: 'checking',
      message: 'Checking username availability...',
    }))

    const timer = window.setTimeout(() => {
      validateUsername(trimmed)
        .then((result) => {
          if (cancelled) return
          if (!result.ok) {
            setUsernameState({
              status: 'invalid',
              message: result.reason || 'Username is invalid.',
              normalized: result.normalized,
            })
            return
          }
          setUsernameState({
            status: result.available ? 'available' : 'taken',
            message: result.available ? 'Username is available.' : result.reason || 'Username is already taken.',
            normalized: result.normalized,
          })
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setUsernameState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not validate username.',
            normalized: '',
          })
        })
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mode, username])

  function resetFlow(nextMode: Mode) {
    setMode(nextMode)
    setCreateStep(nextMode === 'create' ? 'username' : 'choose')
    setExistingStep(nextMode === 'existing' ? 'username' : 'choose')
    setMessage('')
    setStatus(null)
    setSavedSecrets(false)
    setWalletReviewStep('mnemonic')
  }

  async function handleCreateWallet() {
    if (usernameState.status !== 'available') return
    setBusy(true)
    setMessage('Creating wallet...')
    try {
      const result = await createAccount(usernameState.normalized)
      setWallet(result.wallet)
      setCreatedUserUuid(result.owner.uuid)
      setUsername(result.owner.username)
      setWalletReviewStep('mnemonic')
      setCreateStep('wallet')
      setMessage('Wallet created. Store the mnemonic before continuing.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Wallet creation failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleCreatePasskey() {
    if (!wallet) return
    setBusy(true)
    setMessage('Opening passkey ceremony...')
    try {
      const passkeyUserId = createdUserUuid || usernameState.normalized || username
      const proof = await createPasskeyProof(passkeyUserId, wallet.privkey)
      const result = await login(usernameState.normalized || username, proof, deviceId)
      setSessionCookie(result.accessToken)
      setDeviceCookie(deviceId)
      setCreateStep('done')
      setMessage('Redirecting to dashboard...')
      window.setTimeout(() => {
        window.location.assign(DASH_PAGE_PATH)
      }, 600)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Passkey setup failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleExistingLookup() {
    const value = existingUsername.trim().toLowerCase()
    if (!value) {
      setMessage('Username is required.')
      return
    }
    setBusy(true)
    setMessage('Checking account auth status...')
    try {
      const result = await getAccountStatus(value)
      setStatus(result)
      if (!result.exists) {
        setMessage('No account exists for that username.')
        return
      }
      if (result.hasPasskey) {
        setExistingStep('passkey')
        setMessage('Passkey is available for this account.')
      } else {
        setExistingStep('mnemonic')
        setMessage('No passkey is stored yet. Recover with mnemonic to create one.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not check this account.')
    } finally {
      setBusy(false)
    }
  }

  async function handlePasskeyLogin() {
    const value = existingUsername.trim().toLowerCase()
    setBusy(true)
    setMessage('Authenticating with passkey...')
    try {
      const proof = await authenticatePasskeyProof(value)
      const result = await login(value, proof, deviceId)
      setSessionCookie(result.accessToken)
      setDeviceCookie(deviceId)
      setExistingStep('done')
      setMessage('Redirecting to dashboard...')
      window.setTimeout(() => {
        window.location.assign(DASH_PAGE_PATH)
      }, 600)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Passkey authentication failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRecovery() {
    const value = existingUsername.trim().toLowerCase()
    const mnemonic = normalizeMnemonicInput(recoveryMnemonic)
    if (!value || !mnemonic) {
      setMessage('Username and mnemonic are required.')
      return
    }
    setBusy(true)
    setMessage('Recovering account and preparing passkey...')
    try {
      const proof = await createPasskeyProof(value)
      const result = await recoverAccount(value, mnemonic, deviceId, proof)
      setSessionCookie(result.accessToken)
      setDeviceCookie(deviceId)
      setExistingStep('done')
      setMode('recover')
      setMessage('Recovery complete. Redirecting to dashboard...')
      window.setTimeout(() => {
        window.location.assign(DASH_PAGE_PATH)
      }, 600)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Account recovery failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#000000] px-4 py-6 text-zinc-100 sm:px-6 lg:px-8">
      <section className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-6xl items-center">
        <div className="grid w-full gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <aside className="glass-panel flex flex-col justify-between p-6 sm:p-8">
            <div>
              <div className="mb-8 flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-[1rem] bg-zinc-100 text-black shadow-[7px_7px_18px_rgba(0,0,0,0.9),-5px_-5px_16px_rgba(255,255,255,0.12)]">
                  <Rotate3D size={23} strokeWidth={2.4} />
                </div>
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.3em] text-zinc-500">Orbital</p>
                  <h1 className="text-3xl font-semibold tracking-normal text-white sm:text-4xl">Wallet access</h1>
                </div>
              </div>

              <div className="space-y-3">
                {steps.map((step, index) => (
                  <div key={step} className="flex items-center gap-3 rounded-[1.25rem] border border-white/10 bg-white/[0.03] p-3">
                    <span className="grid h-9 w-9 place-items-center rounded-[0.9rem] bg-black text-sm font-semibold text-zinc-200 shadow-[inset_5px_5px_12px_rgba(0,0,0,0.8),inset_-5px_-5px_12px_rgba(255,255,255,0.06)]">
                      {index + 1}
                    </span>
                    <span className="text-sm font-medium text-zinc-300">{step}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-8 rounded-[1.5rem] border border-white/10 bg-black/30 p-4 text-left shadow-[inset_8px_8px_20px_rgba(0,0,0,0.75),inset_-8px_-8px_20px_rgba(255,255,255,0.04)]">
              <p className="font-mono text-xs leading-6 text-zinc-400">
                The mnemonic is only shown during creation, so treat that step like a real custody moment.
              </p>
            </div>
          </aside>

          <section className="glass-panel p-5 sm:p-7 lg:p-9">
            <div className="mb-8 flex flex-wrap gap-3">
              <button
                type="button"
                className={`auth-mode-button ${mode === 'create' ? 'auth-mode-button-active' : ''}`}
                onClick={() => resetFlow('create')}
              >
                Create new wallet
              </button>
              <button
                type="button"
                className={`auth-mode-button ${mode === 'existing' ? 'auth-mode-button-active' : ''}`}
                onClick={() => resetFlow('existing')}
              >
                Authenticate existing
              </button>
            </div>

            {!mode && (
              <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-6 text-left">
                <p className="text-sm uppercase tracking-[0.22em] text-zinc-500">Start</p>
                <h2 className="mt-3 text-2xl font-semibold text-white">Choose how you want to enter.</h2>
              </div>
            )}

            {mode === 'create' && createStep === 'username' && (
              <div className="auth-stack">
                <div>
                  <p className="auth-kicker">New wallet</p>
                  <h2 className="auth-title">Reserve a username.</h2>
                </div>
                <Field
                  label="Username"
                  value={username}
                  onChange={setUsername}
                  placeholder="user"
                  disabled={busy}
                />
                <p className={`text-sm ${usernameState.status === 'available' ? 'text-emerald-300' : 'text-zinc-400'}`}>
                  {usernameState.message}
                </p>
                <button
                  type="button"
                  disabled={busy || usernameState.status !== 'available'}
                  onClick={handleCreateWallet}
                  className="auth-primary-button"
                >
                  {busy ? 'Creating...' : 'Create wallet'}
                </button>
              </div>
            )}

            {mode === 'create' && createStep === 'wallet' && wallet && (
              <div className="auth-stack">
                <div>
                  <p className="auth-kicker">Wallet created</p>
                  <h2 className="auth-title">
                    {walletReviewStep === 'mnemonic' && 'Store the mnemonic.'}
                    {walletReviewStep === 'addresses' && 'Review addresses.'}
                    {walletReviewStep === 'confirm' && 'Confirm custody.'}
                  </h2>
                </div>

                <div className="flex gap-2">
                  {(['mnemonic', 'addresses', 'confirm'] as WalletReviewStep[]).map((step, index) => (
                    <button
                      key={step}
                      type="button"
                      onClick={() => setWalletReviewStep(step)}
                      className={`h-2 flex-1 rounded-full ${walletReviewStep === step ? 'bg-zinc-100' : 'bg-white/15'}`}
                      aria-label={`Wallet review step ${index + 1}`}
                    />
                  ))}
                </div>

                {walletReviewStep === 'mnemonic' && (
                  <>
                    <SecretBox label="Mnemonic" value={wallet.mnemonic} />
                    <button
                      type="button"
                      onClick={() => setWalletReviewStep('addresses')}
                      className="auth-primary-button"
                    >
                      Continue to addresses
                    </button>
                  </>
                )}

                {walletReviewStep === 'addresses' && (
                  <>
                    <AddressList addresses={wallet.addresses} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setWalletReviewStep('mnemonic')}
                        className="auth-ghost-button"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={() => setWalletReviewStep('confirm')}
                        className="auth-primary-button"
                      >
                        Continue
                      </button>
                    </div>
                  </>
                )}

                {walletReviewStep === 'confirm' && (
                  <>
                    <label className="flex items-start gap-3 rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4 text-left text-sm text-zinc-300">
                      <input
                        type="checkbox"
                        checked={savedSecrets}
                        onChange={(event) => setSavedSecrets(event.target.checked)}
                        className="mt-1 h-4 w-4 accent-white"
                      />
                      <span>I have saved the mnemonic and reviewed all wallet addresses.</span>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setWalletReviewStep('addresses')}
                        className="auth-ghost-button"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        disabled={!savedSecrets || busy}
                        onClick={() => setCreateStep('passkey')}
                        className="auth-primary-button"
                      >
                        Continue to passkey
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {mode === 'create' && createStep === 'passkey' && (
              <div className="auth-stack">
                <div>
                  <p className="auth-kicker">Passkey</p>
                  <h2 className="auth-title">Bind this wallet to your device.</h2>
                </div>
                <button type="button" disabled={busy} onClick={handleCreatePasskey} className="auth-primary-button">
                  {busy ? 'Opening passkey...' : 'Create passkey and session'}
                </button>
              </div>
            )}

            {mode === 'existing' && existingStep === 'username' && (
              <div className="auth-stack">
                <div>
                  <p className="auth-kicker">Existing account</p>
                  <h2 className="auth-title">Find your auth path.</h2>
                </div>
                <Field
                  label="Username"
                  value={existingUsername}
                  onChange={setExistingUsername}
                  placeholder="user"
                  disabled={busy}
                />
                <button type="button" disabled={busy} onClick={handleExistingLookup} className="auth-primary-button">
                  {busy ? 'Checking...' : 'Continue'}
                </button>
                <button type="button" onClick={() => setExistingStep('mnemonic')} className="auth-ghost-button">
                  Recover with mnemonic
                </button>
              </div>
            )}

            {mode === 'existing' && existingStep === 'passkey' && (
              <div className="auth-stack">
                <div>
                  <p className="auth-kicker">Passkey found</p>
                  <h2 className="auth-title">Authenticate with your device.</h2>
                </div>
                <button type="button" disabled={busy} onClick={handlePasskeyLogin} className="auth-primary-button">
                  {busy ? 'Authenticating...' : 'Authenticate with passkey'}
                </button>
                <button type="button" onClick={() => setExistingStep('mnemonic')} className="auth-ghost-button">
                  Use recovery instead
                </button>
              </div>
            )}

            {mode && (existingStep === 'mnemonic' || mode === 'recover') && (
              <div className="auth-stack">
                <div>
                  <p className="auth-kicker">Recovery</p>
                  <h2 className="auth-title">Verify your mnemonic.</h2>
                </div>
                <Field
                  label="Username"
                  value={existingUsername}
                  onChange={setExistingUsername}
                  placeholder="user"
                  disabled={busy}
                />
                <label className="block text-left">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">
                    Mnemonic
                  </span>
                  <textarea
                    value={recoveryMnemonic}
                    disabled={busy}
                    placeholder="twelve or twenty four recovery words"
                    onChange={(event) => setRecoveryMnemonic(event.target.value)}
                    className="auth-input min-h-32 resize-none"
                  />
                </label>
                <button type="button" disabled={busy} onClick={handleRecovery} className="auth-primary-button">
                  {busy ? 'Recovering...' : 'Recover and create passkey'}
                </button>
              </div>
            )}

            {(createStep === 'done' || existingStep === 'done') && (
              <div className="auth-stack">
                <p className="auth-kicker">Session ready</p>
                <h2 className="auth-title">Redirecting.</h2>
              </div>
            )}

            {message && (
              <div className="mt-6 rounded-[1.25rem] border border-white/10 bg-black/35 p-4 text-left font-mono text-sm text-zinc-300">
                {message}
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}
