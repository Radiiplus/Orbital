import {
  getStoredAccessToken,
  getStoredDeviceId,
  setDeviceCookie,
  setSessionCookie,
} from './session'
import { apiPath } from './api'
import { GRAPHQL_ENDPOINT } from './graphql'

const GRAPHQL_URL = GRAPHQL_ENDPOINT

type GraphqlResponse<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

export type Network = 'devnet' | 'testnet' | 'mainnet'

export type WalletItem = {
  id: string
  uuid: string
  username: string
  address: string
  label: string
  network: Network
  balance: number | null
  lockArg?: string | null
  publicKey?: string | null
  source: string
  createdAt: string
}

export type WalletSecret = {
  address: string
  mnemonic: string
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}) {
  const accessToken = getStoredAccessToken()
  const deviceId = getStoredDeviceId()
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(deviceId ? { 'x-device-id': deviceId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })

  const refreshedToken = response.headers.get('x-access-token')
  if (refreshedToken) {
    setSessionCookie(refreshedToken)
  }
  const refreshedDevice = response.headers.get('x-device-id')
  if (refreshedDevice) {
    setDeviceCookie(refreshedDevice)
  }

  const payload = (await response.json().catch(() => ({}))) as GraphqlResponse<T>
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || `GraphQL request failed (${response.status})`)
  }
  if (!payload.data) {
    throw new Error('GraphQL response did not include data.')
  }
  return payload.data
}

function mapWallet(wallet: Omit<WalletItem, 'id' | 'balance'>): WalletItem {
  return {
    ...wallet,
    id: wallet.address,
    balance: null,
  }
}

export async function listWallets(username: string, network: Network) {
  const data = await graphql<{
    userWallets: Array<Omit<WalletItem, 'id' | 'balance'>>
  }>(
    `query UserWallets($username: String!, $network: String!) {
      userWallets(username: $username, network: $network) {
        uuid
        username
        address
        label
        network
        lockArg
        publicKey
        source
        createdAt
      }
    }`,
    { username, network },
  )
  return data.userWallets.map(mapWallet)
}

export async function loadAccountBalances(username: string) {
  const data = await graphql<{
    accountInfo: {
      wallets: Array<{
        address: string
        network: Network
        balance?: string | null
      }>
    }
  }>(
    `query AccountBalances($username: String!) {
      accountInfo(username: $username) {
        wallets {
          address
          network
          balance
        }
      }
    }`,
    { username },
  )

  return new Map(
    data.accountInfo.wallets.map((wallet) => [
      `${wallet.network}:${wallet.address}`,
      wallet.balance == null ? null : Number(wallet.balance) / 100000000,
    ]),
  )
}

export async function updateWalletLabel(input: {
  username: string
  walletAddress: string
  label: string
  network: Network
}) {
  const data = await graphql<{
    updateWalletLabel: Omit<WalletItem, 'id' | 'balance'>
  }>(
    `mutation UpdateWalletLabel($input: UpdateWalletLabelInput!) {
      updateWalletLabel(input: $input) {
        uuid
        username
        address
        label
        network
        lockArg
        publicKey
        source
        createdAt
      }
    }`,
    { input },
  )
  return mapWallet(data.updateWalletLabel)
}

export async function createAccountWallet(input: {
  username: string
  label: string
  network: Network
}) {
  const data = await graphql<{
    createAccountWallet: Omit<WalletItem, 'id' | 'balance'>
  }>(
    `mutation CreateAccountWallet($input: AddAccountWalletInput!) {
      createAccountWallet(input: $input) {
        uuid
        username
        address
        label
        network
        lockArg
        publicKey
        source
        createdAt
      }
    }`,
    { input },
  )
  return mapWallet(data.createAccountWallet)
}

export async function linkAccountWallet(input: {
  username: string
  label: string
  mnemonic: string
  network: Network
}) {
  const data = await graphql<{
    linkAccountWallet: Omit<WalletItem, 'id' | 'balance'>
  }>(
    `mutation LinkAccountWallet($input: LinkAccountWalletInput!) {
      linkAccountWallet(input: $input) {
        uuid
        username
        address
        label
        network
        lockArg
        publicKey
        source
        createdAt
      }
    }`,
    { input },
  )
  return mapWallet(data.linkAccountWallet)
}

export async function deleteWallet(input: {
  username: string
  walletAddress: string
  network: Network
}) {
  const data = await graphql<{ deleteWallet: boolean }>(
    `mutation DeleteWallet($username: String!, $walletAddress: String!, $network: String!) {
      deleteWallet(username: $username, walletAddress: $walletAddress, network: $network)
    }`,
    input,
  )
  return data.deleteWallet
}

export async function exportWalletMnemonic(input: {
  username: string
  walletAddress: string
  network: Network
  passkeyProof: string
}) {
  const accessToken = getStoredAccessToken()
  const deviceId = getStoredDeviceId()
  const response = await fetch(apiPath('/wallets/export/mnemonic'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(deviceId ? { 'x-device-id': deviceId } : {}),
    },
    body: JSON.stringify(input),
  })

  const refreshedToken = response.headers.get('x-access-token')
  if (refreshedToken) {
    setSessionCookie(refreshedToken)
  }

  const payload = (await response.json().catch(() => ({}))) as Partial<WalletSecret> & {
    error?: string
    message?: string
  }
  if (!response.ok || !payload.mnemonic || !payload.address) {
    throw new Error(payload.message || payload.error || `Mnemonic export failed (${response.status})`)
  }
  return {
    address: payload.address,
    mnemonic: payload.mnemonic,
  }
}
