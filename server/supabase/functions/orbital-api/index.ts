import { blockchain } from 'npm:@ckb-lumos/base@0.23.0'
import { bytes } from 'npm:@ckb-lumos/codec@0.23.0'
import { hd } from 'npm:@ckb-lumos/lumos@0.23.0'
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, wordlists } from 'npm:bip39@3.1.0'

type Json = Record<string, unknown>

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
}

const SHANNONS_PER_CKB = 100000000n
const SESSION_TTL_MS = 15 * 60 * 1000
const SERVICE_TTL_MS = 15 * 60 * 1000
const COMMAND_TTL_MS = 15 * 60 * 1000
const STREAM_TIMEOUT_MS = 120000

const DEFAULT_COLLECTIONS = {
  users: 'users',
  wallets: 'wallets',
  sessions: 'sessions',
  services: 'services',
  messages: 'messages',
  funding: 'funding',
  structures: 'structures',
  builds: 'builds',
  deployments: 'deployments',
}

const ROUTE_SURFACE = [
  { method: 'GET', path: '/health', mode: 'edge' },
  { method: 'GET', path: '/routes', mode: 'edge' },
  { method: 'POST', path: '/graphql', mode: 'edge-graphql-compat' },
  { method: 'GET', path: '/contracts/config', mode: 'edge-cache' },
  { method: 'GET', path: '/contracts/deployments/latest', mode: 'edge-cache' },
  { method: 'POST', path: '/contracts/build', mode: 'edge-command-stream' },
  { method: 'POST', path: '/contracts/deploy', mode: 'edge-command-stream' },
  { method: 'POST', path: '/contracts/deploy/simulate', mode: 'edge-command' },
  { method: 'POST', path: '/contracts/deploy/broadcast', mode: 'edge-command' },
  { method: 'POST', path: '/wallets/devnet/fund', mode: 'edge-command-stream' },
  { method: 'POST', path: '/wallets/export/mnemonic', mode: 'edge' },
  { method: 'POST', path: '/orbkit/reconnect', mode: 'edge-command' },
  { method: 'GET', path: '/orbkit/status', mode: 'edge-cache' },
  { method: 'GET', path: '/networks/devnet/status', mode: 'edge-cache' },
  { method: 'GET', path: '/networks/devnet/ping', mode: 'edge-cache' },
  { method: 'POST', path: '/projects/structure/sync', mode: 'edge-command' },
  { method: 'POST', path: '/projects/structure/live', mode: 'edge-command' },
  { method: 'GET', path: '/projects/structure/latest', mode: 'edge-cache' },
  { method: 'GET', path: '/projects/structure/stream', mode: 'edge-poll-stream' },
  { method: 'GET', path: '/session', mode: 'edge' },
  { method: 'POST', path: '/session/refresh', mode: 'edge' },
  { method: 'GET', path: '/orbkit/commands', mode: 'orbkit-poll' },
  { method: 'POST', path: '/orbkit/commands/ack', mode: 'orbkit-poll' },
  { method: 'POST', path: '/orbkit/events', mode: 'orbkit-poll' },
  { method: 'POST', path: '/orbkit/services/register', mode: 'orbkit-poll' },
  { method: 'POST', path: '/orbkit/services/unregister', mode: 'orbkit-poll' },
]

let cachedAccessToken: { token: string; expiresAt: number } | null = null

function env(name: string, fallback = '') {
  return Deno.env.get(name) || fallback
}

function nowIso() {
  return new Date().toISOString()
}

function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  })
}

function errorResponse(status: number, message: string, extra: Json = {}) {
  return jsonResponse({ ok: false, message, ...extra }, { status })
}

function graphqlError(message: string) {
  return jsonResponse({ errors: [{ message }] }, { status: 200 })
}

async function readJson(request: Request) {
  return await request.json().catch(() => ({})) as Json
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return atob(padded)
}

function encodeBase64Url(value: string) {
  return encodeBase64UrlBytes(new TextEncoder().encode(value))
}

function encodeBase64UrlBytes(bytesValue: Uint8Array) {
  let binary = ''
  for (const byte of bytesValue) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function runtimeDocId(value: string) {
  return encodeBase64Url(String(value || '').trim())
}

function normalizeProjectKey(value: string, fallback = 'runtime') {
  return String(value || fallback || 'runtime').trim().replace(/\\/g, '/') || 'runtime'
}

function stateKey(parts: Array<string | null | undefined>) {
  return parts.map((part) => String(part || 'runtime').trim() || 'runtime').join(':')
}

function expiresAt(ms: number) {
  return new Date(Date.now() + Math.max(1000, Number(ms) || 1000)).toISOString()
}

function collectionName(key: keyof typeof DEFAULT_COLLECTIONS) {
  const upper = key.toUpperCase()
  return env(`FIREBASE_RUNTIME_${upper}_COLLECTION`, env(`FIREBASE_${upper}_COLLECTION`, DEFAULT_COLLECTIONS[key]))
}

function getBearerToken(request: Request) {
  const value = request.headers.get('authorization') || ''
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
}

function getDeviceId(request: Request, body: Json = {}) {
  return String(body.deviceId || request.headers.get('x-device-id') || '').trim()
}

function normalizeUsername(username: unknown) {
  return String(username || '').trim().toLowerCase()
}

function normalizeNetwork(value: unknown, fallback = 'devnet') {
  const network = String(value || fallback).trim().toLowerCase()
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) {
    throw new Error('network must be one of: devnet, testnet, mainnet.')
  }
  return network
}

function normalizeContractPath(value: unknown) {
  const contractPath = String(value || '').trim().replace(/\\/g, '/')
  if (!contractPath) throw new Error('contractPath is required.')
  return contractPath
}

function normalizePasskeyProof(value: unknown) {
  const proof = String(value || '').trim().toLowerCase()
  if (!/^[a-f0-9]{16,128}$/.test(proof)) {
    throw new Error('passkeyProof must be a hex-like string between 16 and 128 characters.')
  }
  return proof
}

function normalizeDeviceId(value: unknown) {
  const deviceId = String(value || '').trim()
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(deviceId)) {
    throw new Error('deviceId must be an 8 to 128 character device identifier.')
  }
  return deviceId
}

const MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24])
const ENGLISH_MNEMONIC_WORDS = wordlists.english
const ENGLISH_MNEMONIC_WORD_SET = new Set(ENGLISH_MNEMONIC_WORDS)
const ENGLISH_MNEMONIC_WORDS_BY_LENGTH = [...ENGLISH_MNEMONIC_WORDS].sort((left, right) => right.length - left.length)

function cleanMnemonicText(value: unknown) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .trim()
}

function validateMnemonicCandidate(candidate: string) {
  const mnemonic = String(candidate || '').trim().replace(/\s+/g, ' ')
  if (!mnemonic) return null
  const words = mnemonic.split(' ')
  if (!MNEMONIC_WORD_COUNTS.has(words.length)) return null
  try {
    mnemonicToEntropy(mnemonic)
    return mnemonic
  } catch {
    return null
  }
}

function extractMnemonicWords(text: string) {
  const words = text.match(/[a-z]+/g) || []
  const mnemonicWords = words.filter((word) => ENGLISH_MNEMONIC_WORD_SET.has(word))
  return validateMnemonicCandidate(mnemonicWords.join(' '))
}

function segmentMnemonicChars(text: string) {
  const chars = text.replace(/[^a-z]/g, '')
  const memo = new Map<string, string | null>()

  function walk(index: number, words: string[]): string | null {
    if (MNEMONIC_WORD_COUNTS.has(words.length) && index === chars.length) {
      return validateMnemonicCandidate(words.join(' '))
    }
    if (words.length >= 24 || index >= chars.length) return null

    const key = `${index}:${words.length}`
    if (memo.has(key)) return memo.get(key) || null

    for (const word of ENGLISH_MNEMONIC_WORDS_BY_LENGTH) {
      if (!chars.startsWith(word, index)) continue
      const result = walk(index + word.length, [...words, word])
      if (result) {
        memo.set(key, result)
        return result
      }
    }

    memo.set(key, null)
    return null
  }

  return walk(0, [])
}

function normalizeMnemonic(value: unknown) {
  const text = cleanMnemonicText(value)
  if (!text) throw new Error('mnemonic is required.')
  const direct = validateMnemonicCandidate(text)
  if (direct) return direct
  const extracted = extractMnemonicWords(text)
  if (extracted) return extracted
  const segmented = segmentMnemonicChars(text)
  if (segmented) return segmented
  throw new Error('Invalid mnemonic. Check the words and their order.')
}

function parseMetadata(metadata: unknown): Json {
  if (!metadata) return {}
  if (typeof metadata === 'string') {
    try {
      return parseMetadata(JSON.parse(metadata))
    } catch {
      return {}
    }
  }
  if (typeof metadata !== 'object') return {}
  const record = metadata as Json
  if (typeof record.raw === 'string' && Object.keys(record).length === 1) return parseMetadata(record.raw)
  return record
}

function titleCase(value: string) {
  const text = String(value || '').trim()
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : ''
}

function shortGraphqlName(query: string) {
  if (/createHelperApiKey/i.test(query)) return 'createHelperApiKey'
  if (/validateUsername/i.test(query)) return 'validateUsername'
  if (/accountAuthStatus/i.test(query)) return 'accountAuthStatus'
  if (/createAccount/i.test(query)) return 'createAccount'
  if (/recoverAccount/i.test(query)) return 'recoverAccount'
  if (/\blogin\b/i.test(query)) return 'login'
  if (/userWallets/i.test(query)) return 'userWallets'
  if (/accountInfo/i.test(query)) return 'accountInfo'
  if (/updateWalletLabel/i.test(query)) return 'updateWalletLabel'
  if (/createAccountWallet/i.test(query)) return 'createAccountWallet'
  if (/linkAccountWallet/i.test(query)) return 'linkAccountWallet'
  if (/deleteWallet/i.test(query)) return 'deleteWallet'
  if (/runtimeDbSchema/i.test(query)) return 'runtimeDbSchema'
  if (/dbSchema/i.test(query)) return 'dbSchema'
  if (/health/i.test(query)) return 'health'
  return ''
}

function validateUsernameInput(usernameInput: unknown) {
  const value = normalizeUsername(usernameInput)
  if (!value) return { ok: false, available: false, normalized: '', reason: 'Username is required.' }
  if (value.length < 3 || value.length > 32) {
    return { ok: false, available: false, normalized: value, reason: 'Username must be between 3 and 32 characters.' }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    return { ok: false, available: false, normalized: value, reason: 'Username may only contain letters, numbers, underscores, and hyphens.' }
  }
  return { ok: true, available: true, normalized: value, reason: null }
}

function googlePrivateKey() {
  return env('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n').trim()
}

async function importPrivateKey(pem: string) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const binary = decodeBase64Url(body.replace(/\+/g, '-').replace(/\//g, '_'))
  const keyBytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function googleAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.token
  const projectId = env('FIREBASE_PROJECT_ID')
  const clientEmail = env('FIREBASE_CLIENT_EMAIL')
  const privateKey = googlePrivateKey()
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase service account env vars are required.')

  const now = Math.floor(Date.now() / 1000)
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = encodeBase64Url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const unsignedJwt = `${header}.${claim}`
  const key = await importPrivateKey(privateKey)
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsignedJwt))
  const jwt = `${unsignedJwt}.${encodeBase64UrlBytes(new Uint8Array(signature))}`
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string }
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error || `Firebase token request failed (${response.status})`)
  }
  cachedAccessToken = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  }
  return cachedAccessToken.token
}

function firestoreBaseUrl() {
  const projectId = env('FIREBASE_PROJECT_ID')
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required.')
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`
}

function toFirestoreValue(value: unknown): Json {
  if (value === undefined || value === null) return { nullValue: null }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } }
  if (typeof value === 'object') {
    const fields: Record<string, Json> = {}
    for (const [key, item] of Object.entries(value as Json)) {
      if (item !== undefined) fields[key] = toFirestoreValue(item)
    }
    return { mapValue: { fields } }
  }
  return { stringValue: String(value) }
}

function toFirestoreFields(record: Json) {
  const fields: Record<string, Json> = {}
  for (const [key, value] of Object.entries(record || {})) {
    if (value !== undefined) fields[key] = toFirestoreValue(value)
  }
  return fields
}

function fromFirestoreValue(value: Json): unknown {
  if ('nullValue' in value) return null
  if ('booleanValue' in value) return Boolean(value.booleanValue)
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return Number(value.doubleValue)
  if ('timestampValue' in value) return value.timestampValue
  if ('stringValue' in value) return value.stringValue
  if ('arrayValue' in value) {
    const values = (value.arrayValue as Json)?.values as Json[] | undefined
    return (values || []).map(fromFirestoreValue)
  }
  if ('mapValue' in value) return fromFirestoreFields(((value.mapValue as Json)?.fields || {}) as Record<string, Json>)
  return null
}

function fromFirestoreFields(fields: Record<string, Json>) {
  const output: Json = {}
  for (const [key, value] of Object.entries(fields || {})) output[key] = fromFirestoreValue(value)
  return output
}

function fromFirestoreDocument(doc: Json | null) {
  if (!doc?.fields || typeof doc.fields !== 'object') return null
  const data = fromFirestoreFields(doc.fields as Record<string, Json>)
  const name = String(doc.name || '')
  return { id: name.split('/').pop() || '', ...data }
}

async function firestoreFetch(path: string, init: RequestInit = {}) {
  const token = await googleAccessToken()
  const response = await fetch(`${firestoreBaseUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  if (response.status === 404) return null
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error((payload as { error?: { message?: string } })?.error?.message || `Firestore request failed (${response.status})`)
  }
  return payload as Json
}

async function getDocument(collection: string, docId: string) {
  const doc = await firestoreFetch(`/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`)
  return fromFirestoreDocument(doc)
}

async function setDocument(collection: string, docId: string, data: Json, merge = true) {
  const fields = toFirestoreFields(data)
  const params = merge
    ? Object.keys(fields).map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&')
    : ''
  const doc = await firestoreFetch(`/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}${params ? `?${params}` : ''}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  })
  return fromFirestoreDocument(doc)
}

async function deleteDocument(collection: string, docId: string) {
  await firestoreFetch(`/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`, { method: 'DELETE' })
  return true
}

async function listCollection(collection: string, pageSize = 300) {
  const docs: Json[] = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ pageSize: String(pageSize) })
    if (pageToken) query.set('pageToken', pageToken)
    const payload = await firestoreFetch(`/${encodeURIComponent(collection)}?${query.toString()}`)
    docs.push(...(((payload?.documents || []) as Json[])))
    pageToken = String(payload?.nextPageToken || '')
  } while (pageToken)
  return docs.map(fromFirestoreDocument).filter(Boolean) as Json[]
}

async function findLatestByField(collection: string, field: string, value: string, timestampField = 'updatedAt') {
  const records = await listCollection(collection)
  return records
    .filter((record) => String(record[field] || '').trim() === value)
    .sort((left, right) => String(right[timestampField] || right.createdAt || '').localeCompare(String(left[timestampField] || left.createdAt || '')))[0] || null
}

async function listUsers() {
  return (await listCollection(collectionName('users'))).filter((item) => item.id !== '_schema')
}

async function listWallets() {
  return (await listCollection(collectionName('wallets'))).filter((item) => item.id !== '_schema')
}

async function listSessions() {
  return (await listCollection(collectionName('sessions'))).filter((item) => item.id !== '_schema')
}

async function getUserByUsername(username: string) {
  const normalized = normalizeUsername(username)
  return (await listUsers()).find((user) => normalizeUsername(user.username) === normalized) || null
}

async function getUserByUuid(uuid: string) {
  const value = String(uuid || '').trim()
  return value ? await getDocument(collectionName('users'), value) : null
}

async function upsertUser(record: Json) {
  const uuid = String(record.uuid || '').trim()
  if (!uuid) throw new Error('user uuid is required.')
  const existing = await getUserByUuid(uuid)
  const now = nowIso()
  return setDocument(collectionName('users'), uuid, {
    ...existing,
    ...record,
    uuid,
    createdAt: existing?.createdAt || record.createdAt || now,
    updatedAt: now,
  })
}

async function getWalletRecordsByUuid(uuid: string) {
  const value = String(uuid || '').trim()
  if (!value) return []
  return (await listWallets())
    .filter((wallet) => String(wallet.uuid || '').trim() === value)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
}

async function getWalletByUuid(uuid: string) {
  return (await getWalletRecordsByUuid(uuid))[0] || null
}

async function upsertWallet(record: Json) {
  const ownerUuid = String(record.uuid || '').trim()
  if (!ownerUuid) throw new Error('wallet uuid is required.')
  const id = String(record.id || `${ownerUuid}:${crypto.randomUUID()}`).trim()
  const existing = await getDocument(collectionName('wallets'), id)
  const now = nowIso()
  return setDocument(collectionName('wallets'), id, {
    ...existing,
    ...record,
    id,
    uuid: ownerUuid,
    createdAt: existing?.createdAt || record.createdAt || now,
    updatedAt: now,
  })
}

async function updateWalletByAddress(uuid: string, walletAddress: string, network: string, patch: Json) {
  const wallets = await getWalletRecordsByUuid(uuid)
  const wallet = wallets.find((item) => String((item.address as Json | undefined)?.[network] || '').trim() === walletAddress)
  if (!wallet?.id) return null
  return upsertWallet({ ...wallet, ...patch, id: wallet.id, uuid: wallet.uuid })
}

async function deleteWalletByAddress(uuid: string, walletAddress: string, network: string) {
  const wallets = await getWalletRecordsByUuid(uuid)
  const wallet = wallets.find((item) => String((item.address as Json | undefined)?.[network] || '').trim() === walletAddress)
  if (!wallet?.id) return false
  await deleteDocument(collectionName('wallets'), String(wallet.id))
  return true
}

async function getSessionByToken(token: string) {
  const value = String(token || '').trim()
  return value ? (await listSessions()).find((session) => String(session.token || '').trim() === value) || null : null
}

async function getSessionByUuid(uuid: string) {
  const value = String(uuid || '').trim()
  return value ? await getDocument(collectionName('sessions'), value) : null
}

async function upsertSession(record: Json) {
  const uuid = String(record.uuid || '').trim()
  if (!uuid) throw new Error('session uuid is required.')
  const existing = await getSessionByUuid(uuid)
  const now = nowIso()
  return setDocument(collectionName('sessions'), uuid, {
    ...existing,
    ...record,
    uuid,
    createdAt: existing?.createdAt || record.createdAt || now,
    updatedAt: now,
  })
}

async function resolveSession(request: Request, body: Json = {}) {
  const token = getBearerToken(request) || String(body.accessToken || '').trim()
  if (!token) return null
  const session = await getSessionByToken(token)
  if (!session) return null
  const deviceId = getDeviceId(request, body)
  if (session.deviceId && deviceId && String(session.deviceId) !== deviceId) return null
  if (session.deviceId && !deviceId) return null
  if (Number(session.expiresAt || 0) <= Date.now()) return null
  return session
}

async function requireSession(request: Request, body: Json = {}) {
  const session = await resolveSession(request, body)
  if (!session?.user || typeof session.user !== 'object') throw new Error('Authentication required.')
  return session
}

async function refreshSessionRecord(request: Request, body: Json = {}) {
  const token = getBearerToken(request) || String(body.accessToken || '').trim()
  if (!token) throw new Error('accessToken is required.')
  const session = await getSessionByToken(token)
  if (!session) throw new Error('Invalid access token.')
  const deviceId = normalizeDeviceId(getDeviceId(request, body))
  if (session.deviceId && String(session.deviceId) !== deviceId) throw new Error('deviceId does not match this session.')
  return upsertSession({
    ...session,
    token: randomId('sess'),
    deviceId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    updatedAt: nowIso(),
  })
}

function createSession(user: Json, deviceIdInput: unknown) {
  const deviceId = normalizeDeviceId(deviceIdInput)
  return {
    uuid: String(user.uuid || '').trim(),
    token: randomId('sess'),
    deviceId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    user: {
      uuid: user.uuid,
      username: user.username ?? null,
      api: user.api ?? null,
    },
  }
}

function privateKeyToWallet(privateKeyInput: string, networkInput = 'devnet') {
  const privateKey = privateKeyInput.startsWith('0x') ? privateKeyInput : `0x${privateKeyInput}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid private key format.')
  const publicKey = hd.key.privateToPublic(privateKey)
  const lockArg = hd.key.privateKeyToBlake160(privateKey)
  const addresses = {
    devnet: `ckt1${lockArg.slice(2)}`,
    testnet: `ckt1${lockArg.slice(2)}`,
    mainnet: `ckb1${lockArg.slice(2)}`,
  }
  const network = normalizeNetwork(networkInput)
  return {
    network,
    address: addresses[network],
    addresses,
    lockArg,
    publicKey,
    privateKey,
  }
}

function walletFromMnemonic(mnemonicInput: unknown, network = 'devnet') {
  const mnemonic = normalizeMnemonic(mnemonicInput)
  const seed = mnemonicToSeedSync(mnemonic)
  const wallet = privateKeyToWallet(seed.subarray(0, 32).toString('hex'), network)
  return { ...wallet, mnemonic }
}

function createRandomWallet(network = 'devnet') {
  const entropy = new Uint8Array(16)
  crypto.getRandomValues(entropy)
  const mnemonic = entropyToMnemonic(Array.from(entropy, (byte) => byte.toString(16).padStart(2, '0')).join(''))
  return walletFromMnemonic(mnemonic, network)
}

function walletAddressForNetwork(wallet: Json, network: string) {
  return String((wallet.address as Json | undefined)?.[network] || '').trim()
}

function toUserWallet(wallet: Json, user: Json, network: string, index = 0) {
  const address = walletAddressForNetwork(wallet, network)
  if (!address) return null
  return {
    uuid: wallet.uuid,
    username: user.username,
    address,
    label: String(wallet.label || '').trim() || (index === 0 ? 'Main' : `Wallet ${index + 1}`),
    network,
    lockArg: wallet.lockArg || null,
    publicKey: wallet.pubkey || null,
    source: wallet.source || 'generated',
    createdAt: wallet.createdAt,
  }
}

async function requireAuthorizedUser(usernameInput: unknown, request: Request, body: Json = {}) {
  const username = normalizeUsername(usernameInput)
  const user = await getUserByUsername(username)
  if (!user) throw new Error('User not found.')
  const session = await requireSession(request, body)
  if (String((session.user as Json).uuid || '').trim() !== String(user.uuid || '').trim()) {
    throw new Error('Wallet access is restricted to the active session user.')
  }
  return { user, session }
}

async function latestOrbkitService(capability = '') {
  const records = await listCollection(collectionName('services'))
  return records
    .filter((record) => String(record.role || '').trim() === 'orbkit')
    .map((record) => ({ ...record, parsedMetadata: parseMetadata(record.metadata) }))
    .filter((record) => {
      const expires = String(record.expiresAt || '').trim()
      if (expires && Date.parse(expires) <= Date.now()) return false
      if (!capability) return true
      const capabilities = Array.isArray((record.parsedMetadata as Json).capabilities)
        ? (record.parsedMetadata as Json).capabilities as unknown[]
        : []
      return capabilities.map((item) => String(item || '').trim()).includes(capability)
    })
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null
}

function mapContract(contract: Json) {
  const contractPath = String(contract?.path || '').trim().replace(/\\/g, '/')
  if (!contractPath) return null
  const baseName = contractPath.split('/').filter(Boolean).pop() || contractPath
  const script = String(contract?.script || '').trim()
  return {
    id: script || baseName || contractPath,
    name: titleCase(script || baseName || contractPath),
    path: contractPath,
    script: script || baseName,
    build: contract?.build === undefined || contract?.build === null ? null : Boolean(contract.build),
  }
}

async function contractsConfig() {
  const service = await latestOrbkitService('project-structure-sync') || await latestOrbkitService()
  if (!service) {
    return { ok: true, source: 'supabase-cache', service: null, workspaceRoot: null, configPath: null, contractsSourcePath: null, contracts: [] }
  }
  const metadata = service.parsedMetadata as Json
  const contracts = Array.isArray(metadata.contracts)
    ? metadata.contracts.map((item) => mapContract(item as Json)).filter(Boolean)
    : []
  return {
    ok: true,
    source: 'supabase-cache',
    service: service.service || null,
    workspaceRoot: metadata.workspaceRoot || null,
    configPath: metadata.configPath || null,
    contractsSourcePath: metadata.contractsSourcePath || null,
    contracts,
  }
}

async function requireOrbkitAuth(request: Request) {
  const token = getBearerToken(request)
  if (!token) throw new Error('Unauthorized orbkit client.')
  const users = await listUsers()
  const user = users.find((item) => String(item.helperApiKey || '').trim() === token || String(item.api || '').trim() === token) || null
  const internal = env('ORBKIT_API_KEY', 'orbkit-dev-key')
  if (!user && token !== internal) throw new Error('Unauthorized orbkit client. Invalid API key.')
  return { token, user }
}

async function upsertService(input: Json) {
  const service = String(input.service || '').trim()
  if (!service) throw new Error('service is required.')
  const existing = await getDocument(collectionName('services'), runtimeDocId(service))
  const currentMetadata = parseMetadata(existing?.metadata)
  const nextMetadata = parseMetadata(input.metadata)
  const capabilities = new Set([
    ...((currentMetadata.capabilities as unknown[] | undefined) || []).map((item) => String(item || '').trim()).filter(Boolean),
    ...((nextMetadata.capabilities as unknown[] | undefined) || []).map((item) => String(item || '').trim()).filter(Boolean),
  ])
  const metadata = {
    ...currentMetadata,
    ...nextMetadata,
    ...(capabilities.size ? { capabilities: Array.from(capabilities).sort() } : {}),
  }
  return setDocument(collectionName('services'), runtimeDocId(service), {
    service,
    role: String(input.role || existing?.role || 'orbkit').trim(),
    status: String(input.status || 'connected').trim(),
    metadata,
    connectedAt: existing?.connectedAt || nowIso(),
    updatedAt: nowIso(),
    expiresAt: expiresAt(SERVICE_TTL_MS),
  })
}

async function commandDoc(record: Json) {
  const commandId = String(record.commandId || randomId('cmd')).trim()
  const next = {
    commandId,
    channel: String(record.channel || '').trim(),
    service: String(record.service || 'orbital-supabase-function').trim(),
    target: record.target ? String(record.target).trim() : null,
    direction: String(record.direction || 'outbound').trim(),
    network: record.network ? String(record.network).trim() : null,
    ownerKey: String(record.ownerKey || 'runtime').trim() || 'runtime',
    projectKey: normalizeProjectKey(String(record.projectKey || 'runtime')),
    body: record.body || {},
    status: String(record.status || 'queued').trim(),
    createdAt: record.createdAt || nowIso(),
    updatedAt: nowIso(),
    expiresAt: expiresAt(COMMAND_TTL_MS),
  }
  await setDocument(collectionName('messages'), runtimeDocId(commandId), next)
  return next
}

async function appendState(collection: keyof typeof DEFAULT_COLLECTIONS, key: string, record: Json) {
  return setDocument(collectionName(collection), runtimeDocId(key), {
    ...record,
    key,
    updatedAt: nowIso(),
  })
}

async function publishFundingEvent(record: Json) {
  const owner = String(record.ownerKey || 'runtime').trim() || 'runtime'
  const key = stateKey([owner, 'funding', record.requestId as string])
  return appendState('funding', key, {
    ...record,
    ownerKey: owner,
    createdAt: record.createdAt || nowIso(),
  })
}

async function publishBuildEvent(record: Json) {
  const owner = String(record.ownerKey || 'runtime').trim() || 'runtime'
  const project = normalizeProjectKey(String(record.projectKey || record.contractPath || 'runtime'))
  const key = stateKey([owner, project, record.network as string || 'network', record.requestId as string || record.action as string || 'build'])
  return appendState('builds', key, {
    ...record,
    ownerKey: owner,
    projectKey: project,
    createdAt: record.createdAt || nowIso(),
  })
}

async function publishStructureEvent(record: Json) {
  const owner = String(record.ownerKey || 'runtime').trim() || 'runtime'
  const project = normalizeProjectKey(String(record.projectKey || record.contractPath || 'runtime'))
  const key = stateKey([owner, project, 'structure'])
  const current = await getDocument(collectionName('structures'), runtimeDocId(key))
  return appendState('structures', key, {
    ...(current || {}),
    ...record,
    ownerKey: owner,
    projectKey: project,
    updatedAt: nowIso(),
    createdAt: record.createdAt || current?.createdAt || nowIso(),
    ...(record.snapshot === undefined || record.snapshot === null ? {} : { snapshot: record.snapshot }),
  })
}

async function latestStructure(url: URL, request: Request) {
  const contractPath = normalizeContractPath(url.searchParams.get('contractPath'))
  const session = await resolveSession(request)
  const owner = String((session?.user as Json | undefined)?.uuid || 'runtime').trim() || 'runtime'
  const project = normalizeProjectKey(contractPath)
  const exact = await getDocument(collectionName('structures'), runtimeDocId(stateKey([owner, project, 'structure'])))
    || await getDocument(collectionName('structures'), runtimeDocId(stateKey(['runtime', project, 'structure'])))
    || await findLatestByField(collectionName('structures'), 'contractPath', contractPath)
  return jsonResponse({ ok: true, contractPath, service: exact?.service || url.searchParams.get('service') || null, latest: exact || null })
}

async function latestDeployment(url: URL, request: Request) {
  const network = normalizeNetwork(url.searchParams.get('network') || 'devnet')
  const contractPath = String(url.searchParams.get('contractPath') || '').trim().replace(/\\/g, '/')
  if (!contractPath) return jsonResponse({ ok: true, network, contractPath: null, deployment: null })
  const session = await resolveSession(request)
  const owner = String((session?.user as Json | undefined)?.uuid || 'runtime').trim() || 'runtime'
  const project = normalizeProjectKey(contractPath)
  const exact = await getDocument(collectionName('deployments'), runtimeDocId(stateKey([owner, project, network, contractPath, 'deployment'])))
    || await getDocument(collectionName('deployments'), runtimeDocId(stateKey(['runtime', project, network, contractPath, 'deployment'])))
    || await findLatestByField(collectionName('deployments'), 'contractPath', contractPath)
  return jsonResponse({ ok: true, service: exact?.service || url.searchParams.get('service') || null, network, contractPath, deployment: exact?.receipt || null })
}

async function orbkitStatus(request: Request) {
  const session = await resolveSession(request)
  if (!session) return errorResponse(401, 'Authentication required.', { connected: false })
  const records = await listCollection(collectionName('services'))
  const services = records
    .filter((record) => String(record.role || '').trim() === 'orbkit')
    .map((record) => ({ ...record, parsedMetadata: parseMetadata(record.metadata) }))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  const primary = services[0] || null
  return jsonResponse({
    ok: true,
    connected: services.length > 0,
    connectedCount: services.length,
    service: primary?.service || null,
    status: primary?.status || 'offline',
    updatedAt: primary?.updatedAt || null,
    workspaceRoot: (primary?.parsedMetadata as Json | undefined)?.workspaceRoot || null,
    configPath: (primary?.parsedMetadata as Json | undefined)?.configPath || null,
    contracts: (primary?.parsedMetadata as Json | undefined)?.contracts || [],
    services: services.map((service) => ({
      service: service.service,
      role: service.role,
      status: service.status,
      connectedAt: service.connectedAt,
      updatedAt: service.updatedAt,
      capabilities: Array.isArray((service.parsedMetadata as Json).capabilities) ? (service.parsedMetadata as Json).capabilities : [],
    })),
  })
}

async function devnetStatus(request: Request) {
  const session = await resolveSession(request)
  if (!session) {
    return errorResponse(401, 'Authentication required.', {
      network: 'devnet',
      connected: false,
    })
  }
  const service = await latestOrbkitService()
  if (!service) {
    return errorResponse(503, 'Devnet service (orbkit) is not connected.', {
      network: 'devnet',
      connected: false,
      reachableAt: nowIso(),
    })
  }
  return jsonResponse({
    ok: true,
    network: 'devnet',
    connected: true,
    message: 'Devnet is reachable through connected orbkit service.',
    orbkitService: service.service || null,
    username: ((session.user || {}) as Json).username || null,
    reachableAt: nowIso(),
  })
}

async function sessionInfo(request: Request) {
  const session = await resolveSession(request)
  if (!session) return errorResponse(401, 'Session is no longer valid.')
  const sessionUser = (session.user || {}) as Json
  const currentUser = await getUserByUuid(String(sessionUser.uuid || ''))
  const user = currentUser || sessionUser
  const api = String(user.api || sessionUser.api || user.helperApiKey || '').trim() || null
  const helperApiKey = String(user.helperApiKey || '').trim() || null
  return jsonResponse({
    ok: true,
    accessToken: session.token || null,
    deviceId: session.deviceId || null,
    expiresAt: session.expiresAt || null,
    refreshed: false,
    user: {
      username: user.username || sessionUser.username || null,
      api,
      helperApiKey,
    },
  })
}

async function refreshSessionRoute(request: Request) {
  const body = await readJson(request)
  const session = await refreshSessionRecord(request, body)
  return jsonResponse({
    ok: true,
    accessToken: session.token,
    deviceId: session.deviceId,
    expiresAt: session.expiresAt,
    refreshed: true,
    user: (session.user || {}) as Json,
  }, {
    headers: {
      'x-access-token': String(session.token || ''),
      'x-session-refreshed': '1',
      ...(session.deviceId ? { 'x-device-id': String(session.deviceId) } : {}),
    },
  })
}

async function createAccount(usernameInput: unknown, networkInput: unknown) {
  const usernameCheck = validateUsernameInput(usernameInput)
  if (!usernameCheck.ok) throw new Error(usernameCheck.reason || 'Invalid username.')
  const existing = await getUserByUsername(usernameCheck.normalized)
  if (existing) throw new Error('Username is already taken.')
  const user = await upsertUser({ uuid: crypto.randomUUID(), username: usernameCheck.normalized, api: null })
  const wallet = createRandomWallet(normalizeNetwork(networkInput || 'devnet'))
  const record = await upsertWallet({
    uuid: user?.uuid,
    address: wallet.addresses,
    lockArg: wallet.lockArg,
    pubkey: wallet.publicKey,
    privkey: wallet.privateKey,
    mnemonic: wallet.mnemonic,
    label: usernameCheck.normalized,
    source: 'generated',
  })
  return {
    ok: true,
    owner: { uuid: user?.uuid, username: user?.username },
    wallet: { ...record, address: wallet.address, addresses: wallet.addresses },
  }
}

async function login(usernameInput: unknown, passkeyProofInput: unknown, deviceIdInput: unknown) {
  const username = normalizeUsername(usernameInput)
  const passkeyProof = normalizePasskeyProof(passkeyProofInput)
  const user = await getUserByUsername(username)
  if (!user) throw new Error('User not found.')
  const wallet = await getWalletByUuid(String(user.uuid || ''))
  if (!wallet) throw new Error('Wallet not found for user.')
  const updatedUser = await upsertUser({ ...user, api: passkeyProof, helperApiKey: user.helperApiKey || null })
  const session = await upsertSession(createSession(updatedUser || user, deviceIdInput))
  return {
    ok: true,
    accessToken: session?.token,
    owner: { uuid: updatedUser?.uuid, username: updatedUser?.username },
    wallet: {
      uuid: wallet.uuid,
      address: (wallet.address as Json | undefined)?.devnet,
      addresses: wallet.address,
      lockArg: wallet.lockArg,
      pubkey: wallet.pubkey,
      label: wallet.label,
    },
  }
}

async function recoverAccount(usernameInput: unknown, mnemonicInput: unknown, deviceIdInput: unknown, passkeyProofInput: unknown) {
  const username = normalizeUsername(usernameInput)
  const user = await getUserByUsername(username)
  if (!user) throw new Error('User not found.')
  const wallet = await getWalletByUuid(String(user.uuid || ''))
  if (!wallet) throw new Error('Wallet not found for user.')
  const recoveredWallet = walletFromMnemonic(mnemonicInput, 'devnet')
  if (recoveredWallet.addresses.devnet !== (wallet.address as Json | undefined)?.devnet) {
    throw new Error('Mnemonic does not match the stored wallet.')
  }
  const passkeyProof = passkeyProofInput ? normalizePasskeyProof(passkeyProofInput) : null
  const updatedUser = await upsertUser({ ...user, api: passkeyProof })
  const updatedWallet = await upsertWallet({
    ...wallet,
    mnemonic: recoveredWallet.mnemonic,
    privkey: recoveredWallet.privateKey,
    pubkey: recoveredWallet.publicKey,
    lockArg: recoveredWallet.lockArg,
    address: recoveredWallet.addresses,
  })
  const session = await upsertSession(createSession(updatedUser || user, deviceIdInput))
  return {
    ok: true,
    accessToken: session?.token,
    owner: { uuid: updatedUser?.uuid, username: updatedUser?.username },
    wallet: {
      uuid: updatedWallet?.uuid,
      address: (updatedWallet?.address as Json | undefined)?.devnet,
      addresses: updatedWallet?.address,
      lockArg: updatedWallet?.lockArg,
      pubkey: updatedWallet?.pubkey,
      label: updatedWallet?.label,
    },
    passkeyProof: updatedWallet?.privkey,
  }
}

async function userWallets(usernameInput: unknown, networkInput: unknown, request: Request, body: Json = {}) {
  const network = normalizeNetwork(networkInput)
  const { user } = await requireAuthorizedUser(usernameInput, request, body)
  const wallets = await getWalletRecordsByUuid(String(user.uuid || ''))
  return wallets.map((wallet, index) => toUserWallet(wallet, user, network, index)).filter(Boolean)
}

async function accountInfo(usernameInput: unknown) {
  const user = await getUserByUsername(normalizeUsername(usernameInput))
  if (!user) throw new Error('User not found.')
  const wallets = await getWalletRecordsByUuid(String(user.uuid || ''))
  const rows: Json[] = []
  for (const wallet of wallets) {
    const addresses = (wallet.address || {}) as Json
    for (const [network, address] of Object.entries(addresses)) {
      let balance: string | null = null
      const latest = await findLatestByField(collectionName('messages'), 'balanceAddress', String(address))
      if (latest?.balance !== undefined && latest?.balance !== null) balance = String(latest.balance)
      rows.push({ address, network, balance })
    }
  }
  return { username: user.username, wallets: rows }
}

async function updateWalletLabel(input: Json, request: Request, body: Json = {}) {
  const network = normalizeNetwork(input.network)
  const { user } = await requireAuthorizedUser(input.username, request, body)
  const walletAddress = String(input.walletAddress || '').trim()
  const label = String(input.label || '').trim().replace(/\s+/g, ' ')
  if (!label) throw new Error('Wallet label cannot be empty.')
  const updated = await updateWalletByAddress(String(user.uuid || ''), walletAddress, network, { label })
  if (!updated) throw new Error('Wallet link not found for user.')
  const wallets = await getWalletRecordsByUuid(String(user.uuid || ''))
  const index = wallets.findIndex((wallet) => walletAddressForNetwork(wallet, network) === walletAddress)
  return toUserWallet(updated, user, network, Math.max(0, index))
}

async function createAccountWallet(input: Json, request: Request, body: Json = {}) {
  const network = normalizeNetwork(input.network)
  const { user } = await requireAuthorizedUser(input.username, request, body)
  const label = String(input.label || 'Wallet').trim().replace(/\s+/g, ' ')
  const wallet = createRandomWallet(network)
  const record = await upsertWallet({
    uuid: user.uuid,
    address: wallet.addresses,
    lockArg: wallet.lockArg,
    pubkey: wallet.publicKey,
    privkey: wallet.privateKey,
    mnemonic: wallet.mnemonic,
    label,
    source: 'generated',
  })
  const wallets = await getWalletRecordsByUuid(String(user.uuid || ''))
  const index = wallets.findIndex((item) => walletAddressForNetwork(item, network) === wallet.addresses[network])
  return toUserWallet(record || {}, user, network, Math.max(0, index))
}

async function linkAccountWallet(input: Json, request: Request, body: Json = {}) {
  const network = normalizeNetwork(input.network)
  const { user } = await requireAuthorizedUser(input.username, request, body)
  const wallet = walletFromMnemonic(input.mnemonic, network)
  const existing = (await getWalletRecordsByUuid(String(user.uuid || ''))).find((item) => (
    Object.entries(wallet.addresses).some(([name, address]) => String((item.address as Json | undefined)?.[name] || '').trim() === address)
  ))
  if (existing) return toUserWallet(existing, user, network)
  const label = String(input.label || 'Wallet').trim().replace(/\s+/g, ' ')
  const record = await upsertWallet({
    uuid: user.uuid,
    address: wallet.addresses,
    lockArg: wallet.lockArg,
    pubkey: wallet.publicKey,
    privkey: wallet.privateKey,
    mnemonic: wallet.mnemonic,
    label,
    source: 'mnemonic',
  })
  return toUserWallet(record || {}, user, network)
}

async function deleteWallet(input: Json, request: Request, body: Json = {}) {
  const network = normalizeNetwork(input.network)
  const { user } = await requireAuthorizedUser(input.username, request, body)
  return deleteWalletByAddress(String(user.uuid || ''), String(input.walletAddress || '').trim(), network)
}

async function exportWalletMnemonic(request: Request) {
  const body = await readJson(request)
  const network = normalizeNetwork(body.network)
  const { user } = await requireAuthorizedUser(body.username, request, body)
  normalizePasskeyProof(body.passkeyProof)
  const walletAddress = String(body.walletAddress || '').trim()
  const wallet = (await getWalletRecordsByUuid(String(user.uuid || ''))).find((item) => walletAddressForNetwork(item, network) === walletAddress)
  if (!wallet) throw new Error('Wallet link not found for user.')
  return jsonResponse({ ok: true, address: walletAddress, mnemonic: wallet.mnemonic })
}

async function createHelperApiKey(request: Request, body: Json = {}) {
  const session = await requireSession(request, body)
  const user = await getUserByUuid(String((session.user as Json).uuid || ''))
  if (!user) throw new Error('User not found for session.')
  const key = normalizePasskeyProof(body.passkeyProof)
  const keyOwner = (await listUsers()).find((item) => String(item.uuid || '').trim() !== String(user.uuid || '').trim() && (
    String(item.helperApiKey || '').trim() === key || String(item.api || '').trim() === key
  ))
  if (keyOwner) throw new Error('API key already belongs to another user.')
  const updated = await upsertUser({ ...user, api: key, helperApiKey: key, helperApiKeyCreatedAt: nowIso() })
  return { username: updated?.username, key, createdAt: updated?.helperApiKeyCreatedAt || nowIso() }
}

async function graphqlCompat(request: Request) {
  const body = await readJson(request)
  const query = String(body.query || '')
  const variables = (body.variables && typeof body.variables === 'object' ? body.variables : {}) as Json
  const op = shortGraphqlName(query)
  try {
    if (op === 'health') return jsonResponse({ data: { health: { ok: true, service: 'orbital-supabase-function' } } })
    if (op === 'dbSchema') return jsonResponse({ data: { dbSchema: '{}' } })
    if (op === 'runtimeDbSchema') return jsonResponse({ data: { runtimeDbSchema: '{}' } })
    if (op === 'validateUsername') {
      const result = validateUsernameInput(variables.username)
      const existing = result.ok ? await getUserByUsername(result.normalized) : null
      return jsonResponse({ data: { validateUsername: { ...result, available: result.ok ? !existing : false, reason: existing ? 'Username is already taken.' : result.reason } } })
    }
    if (op === 'accountAuthStatus') {
      const username = normalizeUsername(variables.username)
      const user = await getUserByUsername(username)
      return jsonResponse({ data: { accountAuthStatus: { ok: true, exists: Boolean(user), username, hasPasskey: Boolean(String(user?.api || '').trim()) } } })
    }
    if (op === 'createAccount') return jsonResponse({ data: { createAccount: await createAccount(variables.username, variables.network) } })
    if (op === 'login') return jsonResponse({ data: { login: await login(variables.username, variables.passkeyProof, variables.deviceId) } })
    if (op === 'recoverAccount') return jsonResponse({ data: { recoverAccount: await recoverAccount(variables.username, variables.mnemonic, variables.deviceId, variables.passkeyProof) } })
    if (op === 'userWallets') return jsonResponse({ data: { userWallets: await userWallets(variables.username, variables.network, request, variables) } })
    if (op === 'accountInfo') return jsonResponse({ data: { accountInfo: await accountInfo(variables.username) } })
    if (op === 'updateWalletLabel') return jsonResponse({ data: { updateWalletLabel: await updateWalletLabel((variables.input || {}) as Json, request, variables) } })
    if (op === 'createAccountWallet') return jsonResponse({ data: { createAccountWallet: await createAccountWallet((variables.input || {}) as Json, request, variables) } })
    if (op === 'linkAccountWallet') return jsonResponse({ data: { linkAccountWallet: await linkAccountWallet((variables.input || {}) as Json, request, variables) } })
    if (op === 'deleteWallet') return jsonResponse({ data: { deleteWallet: await deleteWallet(variables, request, variables) } })
    if (op === 'createHelperApiKey') return jsonResponse({ data: { createHelperApiKey: await createHelperApiKey(request, variables) } })
    return graphqlError('Unsupported GraphQL operation on Supabase function.')
  } catch (error) {
    return graphqlError(error instanceof Error ? error.message : String(error))
  }
}

async function streamEvents(collection: keyof typeof DEFAULT_COLLECTIONS, requestId: string, eventType: string, isDone: (event: Json) => boolean) {
  const encoder = new TextEncoder()
  let lastFingerprint = ''
  const started = Date.now()
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        while (Date.now() - started < STREAM_TIMEOUT_MS) {
          const latest = await findLatestByField(collectionName(collection), 'requestId', requestId)
          if (latest) {
            const fingerprint = JSON.stringify(latest)
            if (fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: eventType, ...latest })}\n`))
            }
            if (isDone(latest)) break
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: eventType, phase: 'failed', status: 'failed', error: error instanceof Error ? error.message : String(error), createdAt: nowIso() })}\n`))
      } finally {
        controller.close()
      }
    },
  }), {
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
    },
  })
}

async function startFunding(request: Request) {
  const body = await readJson(request)
  const session = await requireSession(request, body)
  const service = await latestOrbkitService('devnet-fund-wallet')
  if (!service) return errorResponse(503, 'No connected orbkit service is available.')
  const requestId = randomId('fund')
  const ownerKey = String((session.user as Json).uuid || (session.user as Json).username || 'runtime')
  const address = String(body.address || '').trim()
  const amount = Number(body.amountInCKB)
  if (!/^(ckt|ckb)1[0-9a-z]+$/i.test(address)) throw new Error('address must be a ckt1... or ckb1... address.')
  if (!Number.isFinite(amount) || amount < 62) throw new Error('amountInCKB must be at least 62.')
  await publishFundingEvent({
    requestId,
    ownerKey,
    phase: 'queued',
    status: 'queued',
    address,
    amountInCKB: String(amount),
    service: 'orbital-supabase-function',
    target: service.service,
    message: `Queued devnet funding request for ${service.service}.`,
    createdAt: nowIso(),
  })
  await commandDoc({
    channel: 'devnet-fund-wallet-request',
    target: service.service,
    network: 'devnet',
    ownerKey,
    body: { requestId, ownerKey, address, amountInCKB: String(amount), retryCount: Number(body.retryCount || 3) },
  })
  return streamEvents('funding', requestId, 'funding-log', (event) => ['completed', 'failed'].includes(String(event.phase || event.status)))
}

function normalizeDeployKind(value: unknown) {
  const kind = String(value || 'typeid').trim().toLowerCase()
  if (!['typeid', 'data'].includes(kind)) throw new Error('deployKind must be "typeid" or "data".')
  return kind
}

async function resolveDeployWallet(request: Request, body: Json) {
  const session = await requireSession(request, body)
  const user = await getUserByUuid(String((session.user as Json).uuid || ''))
  if (!user) throw new Error('User not found for access token.')
  const network = normalizeNetwork(body.network)
  const walletAddress = String(body.walletAddress || body.address || '').trim()
  const wallet = (await getWalletRecordsByUuid(String(user.uuid || ''))).find((item) => (
    walletAddress ? walletAddressForNetwork(item, network) === walletAddress : Boolean(walletAddressForNetwork(item, network))
  ))
  if (!wallet) throw new Error('Wallet not found for user.')
  return {
    session,
    user,
    wallet,
    network,
    address: walletAddressForNetwork(wallet, network),
    privateKey: String(wallet.privkey || '').trim(),
  }
}

function signDeployTransaction(unsignedTx: Json, signingEntries: Json[], privateKeyInput: string) {
  const privateKey = privateKeyInput.startsWith('0x') ? privateKeyInput : `0x${privateKeyInput}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Selected wallet does not include a valid signing key.')
  const witnesses = Array.isArray(unsignedTx.witnesses) ? [...unsignedTx.witnesses] : []
  for (const entry of signingEntries || []) {
    if (entry?.type !== 'witness_args_lock') continue
    const index = Number(entry.index)
    const message = String(entry.message || '').trim()
    if (!Number.isInteger(index) || index < 0 || !/^0x[0-9a-fA-F]{64}$/.test(message)) throw new Error('Invalid signing entry.')
    const signature = hd.key.signRecoverable(message, privateKey)
    const currentWitness = String(witnesses[index] || '0x')
    let witnessArgs: Json = {}
    if (currentWitness !== '0x') witnessArgs = blockchain.WitnessArgs.unpack(bytes.bytify(currentWitness)) as Json
    witnesses[index] = bytes.hexify(blockchain.WitnessArgs.pack({
      inputType: witnessArgs.inputType,
      outputType: witnessArgs.outputType,
      lock: signature,
    }))
  }
  return { ...unsignedTx, witnesses }
}

async function startBuildDeploy(request: Request, action: 'build' | 'deploy') {
  const body = await readJson(request)
  const service = await latestOrbkitService(action === 'build' ? 'build-contract' : 'deploy-contract')
  if (!service) return errorResponse(503, 'No connected orbkit service is available.')
  const contractPath = normalizeContractPath(body.contractPath)
  const network = normalizeNetwork(body.network)
  const requestId = randomId('job')
  let ownerKey = 'runtime'
  let deployWallet: Json | null = null
  let privateKey = ''
  if (action === 'deploy') {
    const resolved = await resolveDeployWallet(request, body)
    normalizePasskeyProof(body.passkeyProof)
    ownerKey = String(resolved.user.uuid || 'runtime')
    deployWallet = { username: resolved.user.username, network, address: resolved.address }
    privateKey = resolved.privateKey
  } else {
    const session = await resolveSession(request, body)
    ownerKey = String((session?.user as Json | undefined)?.uuid || 'runtime')
  }
  await publishBuildEvent({
    requestId,
    ownerKey,
    projectKey: contractPath,
    action,
    phase: 'queued',
    status: 'queued',
    service: 'orbital-supabase-function',
    target: service.service,
    network,
    contractPath,
    message: `Queued ${action} request for ${contractPath}.`,
    createdAt: nowIso(),
  })
  await commandDoc({
    channel: 'build-deploy-request',
    target: service.service,
    network,
    ownerKey,
    projectKey: contractPath,
    body: {
      requestId,
      ownerKey,
      projectKey: contractPath,
      action,
      contractPath,
      network,
      retryCount: Number(body.retryCount || 2),
      build: body.build === undefined ? action === 'build' : Boolean(body.build),
      deployKind: normalizeDeployKind(body.deployKind),
      sponsorMode: network === 'devnet' ? 'devnet-funder' : 'none',
      deployWallet,
    },
  })

  if (action === 'deploy') {
    ;(async () => {
      const prepared = await waitForBuildResult(requestId, (event) => {
        const result = parseMaybeJson(event.result)
        return event.phase === 'completed' && result?.unsignedTx
      })
      const preparedResult = parseMaybeJson(prepared.result) || {}
      await publishBuildEvent({
        requestId,
        ownerKey,
        projectKey: contractPath,
        action,
        phase: 'signing',
        status: 'running',
        service: 'orbital-supabase-function',
        target: service.service,
        network,
        contractPath,
        message: `Signing unsigned deploy transaction for ${contractPath}.`,
        result: { action: 'deploy-signing', signingEntryCount: (preparedResult.signingEntries as unknown[] | undefined)?.length || 0 },
        createdAt: nowIso(),
      })
      const signedTx = signDeployTransaction(preparedResult.unsignedTx as Json, (preparedResult.signingEntries as Json[] | undefined) || [], privateKey)
      await publishBuildEvent({
        requestId,
        ownerKey,
        projectKey: contractPath,
        action,
        phase: 'broadcasting',
        status: 'running',
        service: 'orbital-supabase-function',
        target: service.service,
        network,
        contractPath,
        message: network === 'devnet'
          ? 'Submitting signed deploy transaction to Orbkit for devnet broadcast.'
          : `Submitting signed deploy transaction to Orbkit for ${network} broadcast.`,
        result: { action: 'deploy-broadcasting', binaryBytes: preparedResult.binaryBytes ?? null },
        createdAt: nowIso(),
      })
      await commandDoc({
        channel: 'build-deploy-request',
        target: service.service,
        network,
        ownerKey,
        projectKey: contractPath,
        body: {
          requestId,
          ownerKey,
          projectKey: contractPath,
          action: 'deploy-broadcast',
          contractPath,
          network,
          tx: signedTx,
          prepareResult: preparedResult,
          deployWallet,
        },
      })
    })().catch(async (error) => {
      await publishBuildEvent({
        requestId,
        ownerKey,
        projectKey: contractPath,
        action,
        phase: 'failed',
        status: 'failed',
        service: 'orbital-supabase-function',
        target: service.service,
        network,
        contractPath,
        message: `Deploy failed for ${contractPath}.`,
        error: error instanceof Error ? error.message : String(error),
        createdAt: nowIso(),
      })
    })
  }

  return streamEvents('builds', requestId, 'build-deploy-log', (event) => {
    if (event.phase === 'failed') return true
    if (action === 'build') return event.phase === 'completed'
    return event.phase === 'completed' && parseMaybeJson(event.result)?.txHash
  })
}

function parseMaybeJson(value: unknown): Json | null {
  if (!value) return null
  if (typeof value === 'object') return value as Json
  try {
    return JSON.parse(String(value)) as Json
  } catch {
    return null
  }
}

async function waitForBuildResult(requestId: string, done: (event: Json) => boolean) {
  const started = Date.now()
  while (Date.now() - started < STREAM_TIMEOUT_MS) {
    const latest = await findLatestByField(collectionName('builds'), 'requestId', requestId)
    if (latest?.phase === 'failed') throw new Error(String(latest.error || latest.message || 'Build/deploy failed.'))
    if (latest && done(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('Timed out waiting for Orbkit result.')
}

async function simulateDeploy(request: Request) {
  const body = await readJson(request)
  const service = await latestOrbkitService('deploy-contract')
  if (!service) return errorResponse(503, 'No connected orbkit service is available.')
  const resolved = await resolveDeployWallet(request, body)
  const contractPath = normalizeContractPath(body.contractPath)
  const requestId = randomId('sim')
  await commandDoc({
    channel: 'build-deploy-request',
    target: service.service,
    network: resolved.network,
    ownerKey: String(resolved.user.uuid || 'runtime'),
    projectKey: contractPath,
    body: {
      requestId,
      action: 'deploy',
      contractPath,
      network: resolved.network,
      build: Boolean(body.build),
      deployKind: normalizeDeployKind(body.deployKind),
      sponsorMode: resolved.network === 'devnet' ? 'devnet-funder' : 'none',
      deployWallet: { username: resolved.user.username, network: resolved.network, address: resolved.address },
    },
  })
  const latest = await waitForBuildResult(requestId, (event) => event.phase === 'completed' && Boolean(parseMaybeJson(event.result)?.unsignedTx))
  const result = parseMaybeJson(latest.result) || {}
  return jsonResponse({
    ...result,
    binarySizeBytes: result.binaryBytes ?? null,
    deployWallet: { username: resolved.user.username, address: resolved.address, network: resolved.network },
  })
}

async function structureSync(request: Request, liveRoute = false) {
  const body = await readJson(request)
  const session = await resolveSession(request, body)
  const service = await latestOrbkitService('project-structure-sync')
  if (!service) return errorResponse(503, 'No connected orbkit service is available.')
  const contractPath = normalizeContractPath(body.contractPath)
  const ownerKey = String((session?.user as Json | undefined)?.uuid || 'runtime')
  const liveSyncEnabled = liveRoute ? Boolean(body.liveSyncEnabled) : Boolean(body.liveSyncEnabled)
  const streamId = randomId('struct')
  await publishStructureEvent({
    streamId,
    ownerKey,
    projectKey: contractPath,
    contractPath,
    service: 'orbital-supabase-function',
    target: service.service,
    status: liveRoute ? 'configured' : 'queued',
    liveSyncEnabled,
    syncMode: liveSyncEnabled ? 'live' : 'manual',
    changeType: liveRoute ? 'config' : 'request',
    sequence: 0,
    message: liveRoute
      ? (liveSyncEnabled ? `Live project structure sync enabled for ${contractPath}.` : `Live project structure sync disabled for ${contractPath}.`)
      : `Queued project structure sync for ${contractPath}.`,
    createdAt: nowIso(),
  })
  await commandDoc({
    channel: 'project-structure-request',
    target: service.service,
    ownerKey,
    projectKey: contractPath,
    body: {
      requestId: streamId,
      ownerKey,
      projectKey: contractPath,
      contractPath,
      requestType: liveRoute ? 'configure-live-sync' : 'sync',
      liveSyncEnabled,
    },
  })
  const latest = await getDocument(collectionName('structures'), runtimeDocId(stateKey([ownerKey, contractPath, 'structure'])))
  return jsonResponse({ ok: true, contractPath, service: service.service, liveSyncEnabled, queuedAt: nowIso(), latest })
}

async function structureStream(url: URL, request: Request) {
  const contractPath = normalizeContractPath(url.searchParams.get('contractPath'))
  const session = await resolveSession(request)
  const ownerKey = String((session?.user as Json | undefined)?.uuid || 'runtime')
  const encoder = new TextEncoder()
  let lastFingerprint = ''
  const started = Date.now()
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'project-structure-started', contractPath, createdAt: nowIso() })}\n`))
      try {
        while (Date.now() - started < STREAM_TIMEOUT_MS) {
          const latest = await getDocument(collectionName('structures'), runtimeDocId(stateKey([ownerKey, contractPath, 'structure'])))
            || await getDocument(collectionName('structures'), runtimeDocId(stateKey(['runtime', contractPath, 'structure'])))
            || await findLatestByField(collectionName('structures'), 'contractPath', contractPath)
          if (latest) {
            const fingerprint = JSON.stringify(latest)
            if (fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'project-structure-log', ...latest })}\n`))
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      } finally {
        controller.close()
      }
    },
  }), { headers: { ...CORS_HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8' } })
}

async function reconnectOrbkit(request: Request) {
  const body = await readJson(request)
  await requireSession(request, body)
  const service = body.service ? await getDocument(collectionName('services'), runtimeDocId(String(body.service))) : await latestOrbkitService()
  if (!service) return errorResponse(503, 'No connected orbkit runtime is available to reconnect.')
  const requestId = randomId('orbkit_reconnect')
  await commandDoc({
    channel: 'orbkit-control',
    target: String(service.service),
    body: { requestId, command: 'reconnect', reason: 'manual-ui', createdAt: nowIso() },
  })
  return jsonResponse({ ok: true, requestId, service: service.service, message: `Reconnect requested for ${service.service}.` })
}

async function orbkitCommands(request: Request, url: URL) {
  await requireOrbkitAuth(request)
  const service = String(url.searchParams.get('service') || '').trim()
  if (!service) return errorResponse(400, 'service is required.')
  await upsertService({ service, role: 'orbkit', status: 'connected' })
  const docs = (await listCollection(collectionName('messages')))
    .filter((cmd) => (
      String(cmd.target || '').trim() === service
      && String(cmd.status || '').trim() === 'queued'
      && (!cmd.expiresAt || Date.parse(String(cmd.expiresAt)) > Date.now())
    ))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
    .slice(0, Math.max(1, Math.min(25, Number(url.searchParams.get('limit') || 10))))
  return jsonResponse({ ok: true, commands: docs })
}

async function ackCommand(request: Request) {
  await requireOrbkitAuth(request)
  const body = await readJson(request)
  const commandId = String(body.commandId || '').trim()
  if (!commandId) throw new Error('commandId is required.')
  const status = String(body.status || 'accepted').trim()
  const command = await getDocument(collectionName('messages'), runtimeDocId(commandId))
  if (!command) return jsonResponse({ ok: true, commandId, missing: true })
  await setDocument(collectionName('messages'), runtimeDocId(commandId), { ...command, status, updatedAt: nowIso() })
  return jsonResponse({ ok: true, commandId, status })
}

async function orbkitEvent(request: Request) {
  await requireOrbkitAuth(request)
  const body = await readJson(request)
  const channel = String(body.channel || '').trim()
  const payload = (body.body && typeof body.body === 'object' ? body.body : {}) as Json
  if (channel === 'devnet-fund-wallet-progress') {
    await publishFundingEvent({
      ...payload,
      service: body.service,
      target: body.target || 'orbital-supabase-function',
      createdAt: payload.createdAt || nowIso(),
    })
  } else if (channel === 'build-deploy-progress') {
    const event = await publishBuildEvent({
      ...payload,
      service: body.service,
      target: body.target || 'orbital-supabase-function',
      createdAt: payload.createdAt || nowIso(),
    })
    const result = parseMaybeJson(event?.result)
    if (payload.action === 'deploy-broadcast' && payload.phase === 'completed' && result?.deployment) {
      const network = String(payload.network || result.network || '').trim().toLowerCase()
      const contractPath = String(payload.contractPath || result.contractPath || '').trim()
      const ownerKey = String(payload.ownerKey || 'runtime').trim()
      const projectKey = normalizeProjectKey(String(payload.projectKey || contractPath || 'runtime'))
      await setDocument(collectionName('deployments'), runtimeDocId(stateKey([ownerKey, projectKey, network, contractPath, 'deployment'])), {
        service: body.service,
        ownerKey,
        projectKey,
        network,
        contractPath,
        receipt: result.deployment,
        txHash: result.txHash || (result.deployment as Json)?.txHash || null,
        updatedAt: nowIso(),
      })
      await publishBuildEvent({
        ...payload,
        action: 'deploy',
        phase: 'completed',
        status: 'completed',
        message: `Deploy completed for ${contractPath}.`,
        result: {
          ok: true,
          action: 'deploy',
          network,
          contractPath,
          txHash: result.txHash || (result.deployment as Json)?.txHash || null,
          deployment: result.deployment,
        },
        createdAt: nowIso(),
      })
    }
  } else if (channel === 'project-structure-progress') {
    await publishStructureEvent({
      ...payload,
      service: body.service,
      target: body.target || 'orbital-supabase-function',
      createdAt: payload.createdAt || nowIso(),
    })
  } else if (channel === 'wallet-balance-response' || channel === 'devnet-balance-update') {
    const address = String(payload.address || '').trim()
    await setDocument(collectionName('messages'), runtimeDocId(stateKey(['balance', address, String(payload.network || body.network || 'devnet')])), {
      channel,
      balanceAddress: address,
      network: payload.network || body.network || 'devnet',
      balance: payload.balance ?? payload.totalShannons ?? null,
      result: payload.result || null,
      updatedAt: nowIso(),
    })
  }
  return jsonResponse({ ok: true })
}

async function registerOrbkit(request: Request) {
  await requireOrbkitAuth(request)
  const body = await readJson(request)
  const service = await upsertService(body)
  return jsonResponse({ ok: true, service })
}

async function unregisterOrbkit(request: Request) {
  await requireOrbkitAuth(request)
  const body = await readJson(request)
  const service = String(body.service || '').trim()
  if (service) await deleteDocument(collectionName('services'), runtimeDocId(service))
  return jsonResponse({ ok: true })
}

function normalizeFunctionPath(pathname: string) {
  return pathname.replace(/^\/functions\/v1\/orbital-api/, '').replace(/^\/orbital-api/, '') || '/'
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  try {
    const url = new URL(request.url)
    const path = normalizeFunctionPath(url.pathname)

    if (request.method === 'GET' && path === '/health') return jsonResponse({ ok: true, service: 'orbital-supabase-function' })
    if (request.method === 'GET' && path === '/routes') return jsonResponse({ ok: true, service: 'orbital-supabase-function', routes: ROUTE_SURFACE })
    if (request.method === 'POST' && path === '/graphql') return graphqlCompat(request)
    if (request.method === 'GET' && path === '/contracts/config') return jsonResponse(await contractsConfig())
    if (request.method === 'GET' && path === '/contracts/deployments/latest') return latestDeployment(url, request)
    if (request.method === 'POST' && path === '/contracts/build') return startBuildDeploy(request, 'build')
    if (request.method === 'POST' && path === '/contracts/deploy') return startBuildDeploy(request, 'deploy')
    if (request.method === 'POST' && path === '/contracts/deploy/simulate') return simulateDeploy(request)
    if (request.method === 'POST' && path === '/wallets/devnet/fund') return startFunding(request)
    if (request.method === 'POST' && path === '/wallets/export/mnemonic') return exportWalletMnemonic(request)
    if (request.method === 'POST' && path === '/orbkit/reconnect') return reconnectOrbkit(request)
    if (request.method === 'GET' && path === '/orbkit/status') return orbkitStatus(request)
    if (request.method === 'GET' && path === '/networks/devnet/status') return devnetStatus(request)
    if (request.method === 'GET' && path === '/networks/devnet/ping') return jsonResponse({ ok: true, network: 'devnet', source: 'orbkit-cache' })
    if (request.method === 'POST' && path === '/projects/structure/sync') return structureSync(request)
    if (request.method === 'POST' && path === '/projects/structure/live') return structureSync(request, true)
    if (request.method === 'GET' && path === '/projects/structure/latest') return latestStructure(url, request)
    if (request.method === 'GET' && path === '/projects/structure/stream') return structureStream(url, request)
    if (request.method === 'GET' && path === '/session') return sessionInfo(request)
    if (request.method === 'POST' && path === '/session/refresh') return refreshSessionRoute(request)
    if (request.method === 'GET' && path === '/orbkit/commands') return orbkitCommands(request, url)
    if (request.method === 'POST' && path === '/orbkit/commands/ack') return ackCommand(request)
    if (request.method === 'POST' && path === '/orbkit/events') return orbkitEvent(request)
    if (request.method === 'POST' && path === '/orbkit/services/register') return registerOrbkit(request)
    if (request.method === 'POST' && path === '/orbkit/services/unregister') return unregisterOrbkit(request)

    return errorResponse(404, 'Route not found.', { path, availableRoutes: ROUTE_SURFACE })
  } catch (error) {
    return errorResponse(500, error instanceof Error ? error.message : String(error))
  }
})
