import { createWallet } from '../../orbkit/mod/create.mjs';
import { createWalletFromMnemonic } from '../../orbkit/mod/common.mjs';

function normalizeUsername(username) {
  const value = String(username || '').trim().toLowerCase();
  if (!value) {
    throw new Error('username is required.');
  }
  return value;
}

function normalizeNetwork(network) {
  const value = String(network || 'devnet').trim().toLowerCase();
  if (!['devnet', 'testnet', 'mainnet'].includes(value)) {
    throw new Error('network must be one of: devnet, testnet, mainnet.');
  }
  return value;
}

function normalizeLabel(label) {
  const value = String(label || '').trim().replace(/\s+/g, ' ');
  if (!value) {
    throw new Error('Wallet label cannot be empty.');
  }
  if (value.length > 40) {
    throw new Error('Wallet label must be 40 characters or fewer.');
  }
  return value;
}

function normalizeMnemonic(mnemonic) {
  const value = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!value) {
    throw new Error('mnemonic is required.');
  }
  return value;
}

function normalizePasskeyProof(passkeyProof) {
  const value = String(passkeyProof || '').trim();
  if (!/^[a-fA-F0-9]{16,128}$/.test(value)) {
    throw new Error('passkeyProof must be a hex-like string between 16 and 128 characters.');
  }
  return value.toLowerCase();
}

function addressForNetwork(wallet, network) {
  return String(wallet?.address?.[network] || '').trim();
}

function walletAddressesOverlap(left = {}, right = {}) {
  return Object.entries(left).some(([network, address]) => {
    const value = String(address || '').trim();
    return value && value === String(right?.[network] || '').trim();
  });
}

function defaultLabel(index) {
  return index === 0 ? 'Main' : `Wallet ${index + 1}`;
}

function toUserWallet(wallet, user, network, index = 0) {
  const address = addressForNetwork(wallet, network);
  if (!address) return null;
  return {
    uuid: wallet.uuid,
    username: user.username,
    address,
    label: String(wallet.label || '').trim() || defaultLabel(index),
    network,
    lockArg: wallet.lockArg || null,
    publicKey: wallet.pubkey || null,
    source: wallet.source || 'generated',
    createdAt: wallet.createdAt,
  };
}

function applySessionRefresh(reply, session) {
  if (!reply?.raw || !session?.refreshed || !session?.token) return;
  reply.raw.setHeader('x-access-token', session.token);
  reply.raw.setHeader('x-session-refreshed', '1');
}

export function createAccountWalletService({ db, walletAccessService }) {
  function resolveAuthorizedUser(usernameInput, auth = {}) {
    const username = normalizeUsername(usernameInput);
    const user = db.getUserByUsername(username);
    if (!user) {
      throw new Error('User not found.');
    }

    const session = walletAccessService.resolveSession({
      headers: auth.headers || {},
      accessToken: auth.accessToken,
      deviceId: auth.deviceId,
    });
    if (String(session.user?.uuid || '').trim() !== String(user.uuid || '').trim()) {
      throw new Error('Wallet access is restricted to the active session user.');
    }
    applySessionRefresh(auth.reply, session);

    return { user, session };
  }

  function listWalletRecords(user, network) {
    return db.listWalletsByUuid(user.uuid)
      .filter((wallet) => addressForNetwork(wallet, network));
  }

  function ensureUniqueLabel(user, network, label, currentAddress = '') {
    const normalized = normalizeLabel(label);
    const existing = listWalletRecords(user, network).find((wallet) => (
      String(wallet.label || '').trim().toLowerCase() === normalized.toLowerCase()
      && addressForNetwork(wallet, network) !== currentAddress
    ));
    if (existing) {
      throw new Error('Wallet label must be unique for this account.');
    }
    return normalized;
  }

  function findWalletByAddress(user, walletAddress, network) {
    const address = String(walletAddress || '').trim();
    if (!address) {
      throw new Error('walletAddress is required.');
    }
    const wallet = listWalletRecords(user, network).find((item) => addressForNetwork(item, network) === address);
    if (!wallet) {
      throw new Error('Wallet link not found for user.');
    }
    return wallet;
  }

  function requireFreshPasskeyProof(user, passkeyProof) {
    if (!String(user.api || '').trim()) {
      throw new Error('A passkey must be registered before exporting wallet recovery material.');
    }
    return normalizePasskeyProof(passkeyProof);
  }

  return {
    listUserWallets(input = {}, auth = {}) {
      const network = normalizeNetwork(input.network);
      const { user } = resolveAuthorizedUser(input.username, auth);
      return listWalletRecords(user, network)
        .map((wallet, index) => toUserWallet(wallet, user, network, index))
        .filter(Boolean);
    },

    updateWalletLabel(input = {}, auth = {}) {
      const network = normalizeNetwork(input.network);
      const { user } = resolveAuthorizedUser(input.username, auth);
      const current = findWalletByAddress(user, input.walletAddress, network);
      const currentAddress = addressForNetwork(current, network);
      const label = ensureUniqueLabel(user, network, input.label, currentAddress);
      const updated = db.updateWalletByAddress(user.uuid, currentAddress, network, { label });
      if (!updated) {
        throw new Error('Wallet link not found for user.');
      }
      const index = listWalletRecords(user, network).findIndex((wallet) => addressForNetwork(wallet, network) === currentAddress);
      return toUserWallet(updated, user, network, Math.max(0, index));
    },

    createAccountWallet(input = {}, auth = {}) {
      const network = normalizeNetwork(input.network);
      const { user } = resolveAuthorizedUser(input.username, auth);
      const label = ensureUniqueLabel(user, network, input.label);
      const wallet = createWallet({ network });
      const record = db.createWallet({
        uuid: user.uuid,
        address: wallet.addresses,
        lockArg: wallet.lockArg,
        pubkey: wallet.publicKey,
        privkey: wallet.privateKey,
        mnemonic: wallet.mnemonic,
        label,
        source: wallet.source || 'generated',
      });
      const index = listWalletRecords(user, network).findIndex((item) => addressForNetwork(item, network) === wallet.addresses[network]);
      return toUserWallet(record, user, network, Math.max(0, index));
    },

    linkAccountWallet(input = {}, auth = {}) {
      const network = normalizeNetwork(input.network);
      const { user } = resolveAuthorizedUser(input.username, auth);
      const mnemonic = normalizeMnemonic(input.mnemonic);
      const wallet = createWalletFromMnemonic(mnemonic, { network });
      const existing = db.listWalletsByUuid(user.uuid).find((item) => walletAddressesOverlap(item.address, wallet.addresses));
      if (existing) {
        const existingAddress = addressForNetwork(existing, network);
        const index = listWalletRecords(user, network).findIndex((item) => addressForNetwork(item, network) === existingAddress);
        return toUserWallet(existing, user, network, Math.max(0, index));
      }

      const label = ensureUniqueLabel(user, network, input.label);
      const record = db.createWallet({
        uuid: user.uuid,
        address: wallet.addresses,
        lockArg: wallet.lockArg,
        pubkey: wallet.publicKey,
        privkey: wallet.privateKey,
        mnemonic,
        label,
        source: 'mnemonic',
      });
      const index = listWalletRecords(user, network).findIndex((item) => addressForNetwork(item, network) === wallet.addresses[network]);
      return toUserWallet(record, user, network, Math.max(0, index));
    },

    deleteWallet(input = {}, auth = {}) {
      const network = normalizeNetwork(input.network);
      const { user } = resolveAuthorizedUser(input.username, auth);
      const wallet = findWalletByAddress(user, input.walletAddress, network);
      return db.deleteWalletByAddress(user.uuid, addressForNetwork(wallet, network), network);
    },

    exportWalletMnemonic(input = {}, auth = {}) {
      const network = normalizeNetwork(input.network);
      const { user } = resolveAuthorizedUser(input.username, auth);
      requireFreshPasskeyProof(user, input.passkeyProof);
      const wallet = findWalletByAddress(user, input.walletAddress, network);
      return {
        address: addressForNetwork(wallet, network),
        mnemonic: wallet.mnemonic,
      };
    },
  };
}
