import { randomUUID } from 'node:crypto';
import { createWallet } from '../../orbkit/mod/create.mjs';
import { createWalletFromMnemonic } from '../../orbkit/mod/common.mjs';

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsername(username) {
  return String(username || '').trim();
}

function normalizePasskeyProof(input) {
  const value = String(input || '').trim();
  if (!/^[a-fA-F0-9]{16,128}$/.test(value)) {
    throw new Error('passkeyProof must be a hex-like string between 16 and 128 characters.');
  }
  return value.toLowerCase();
}

function normalizeDeviceId(input) {
  const value = String(input || '').trim();
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(value)) {
    throw new Error('deviceId must be an 8 to 128 character device identifier.');
  }
  return value;
}

export function validateUsernameInput(username) {
  const value = normalizeUsername(username);
  if (!value) {
    return {
      ok: false,
      available: false,
      normalized: '',
      reason: 'Username is required.',
    };
  }
  if (value.length < 3 || value.length > 32) {
    return {
      ok: false,
      available: false,
      normalized: value.toLowerCase(),
      reason: 'Username must be between 3 and 32 characters.',
    };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    return {
      ok: false,
      available: false,
      normalized: value.toLowerCase(),
      reason: 'Username may only contain letters, numbers, underscores, and hyphens.',
    };
  }
  return {
    ok: true,
    available: true,
    normalized: value.toLowerCase(),
    reason: null,
  };
}

export function createAccountService({ db, sessions }) {
  return {
    describeSchema() {
      return db.describeSchema();
    },
    validateUsername(username) {
      const base = validateUsernameInput(username);
      if (!base.ok) return base;
      const existing = db.getUserByUsername(base.normalized);
      const available = !existing;
      return {
        ...base,
        available,
        reason: available ? null : 'Username is already taken.',
      };
    },
    getAuthStatus(input = {}) {
      const username = normalizeUsername(input.username).toLowerCase();
      if (!username) {
        throw new Error('username is required.');
      }

      const user = db.getUserByUsername(username);
      return {
        ok: true,
        exists: Boolean(user),
        username,
        hasPasskey: Boolean(String(user?.api || '').trim()),
      };
    },
    createAccount(input = {}) {
      const network = String(input.network || '').trim().toLowerCase();
      const usernameInput = normalizeUsername(input.username);

      const usernameCheck = this.validateUsername(usernameInput);
      if (!usernameCheck.ok || !usernameCheck.available) {
        throw new Error(usernameCheck.reason || 'Invalid username.');
      }

      const user = db.upsertUser({
        uuid: randomUUID(),
        username: usernameCheck.normalized,
        api: null,
      });

      const wallet = createWallet({ network });
      const walletRecord = db.createWallet({
        uuid: user.uuid,
        address: wallet.addresses,
        lockArg: wallet.lockArg,
        pubkey: wallet.publicKey,
        privkey: wallet.privateKey,
        mnemonic: wallet.mnemonic,
        label: usernameCheck.normalized,
      });

      return {
        ok: true,
        createdAt: nowIso(),
        owner: {
          uuid: user.uuid,
          username: user.username,
        },
        wallet: {
          ...walletRecord,
          address: wallet.address,
          addresses: wallet.addresses,
        },
      };
    },
    login(input = {}) {
      const username = normalizeUsername(input.username);
      const passkeyProof = normalizePasskeyProof(input.passkeyProof);
      const deviceId = normalizeDeviceId(input.deviceId);
      if (!username) {
        throw new Error('username is required.');
      }

      const user = db.getUserByUsername(username);
      if (!user) {
        throw new Error('User not found.');
      }

      const wallet = db.getWalletByUuid(user.uuid);
      if (!wallet) {
        throw new Error('Wallet not found for user.');
      }

      const updatedUser = db.upsertUser({
        uuid: user.uuid,
        username: user.username,
        api: passkeyProof,
      });
      const session = sessions.createSession(updatedUser, { deviceId });

      return {
        ok: true,
        accessToken: session.token,
        owner: {
          uuid: updatedUser.uuid,
          username: updatedUser.username,
        },
        wallet: {
          uuid: wallet.uuid,
          address: wallet.address?.devnet,
          addresses: wallet.address,
          lockArg: wallet.lockArg,
          pubkey: wallet.pubkey,
          label: wallet.label,
        },
      };
    },
    recoverAccount(input = {}) {
      const username = normalizeUsername(input.username);
      const mnemonic = String(input.mnemonic || '').trim();
      const passkeyProof = input.passkeyProof ? normalizePasskeyProof(input.passkeyProof) : null;
      const deviceId = normalizeDeviceId(input.deviceId);
      if (!username) {
        throw new Error('username is required.');
      }
      if (!mnemonic) {
        throw new Error('mnemonic is required.');
      }

      const user = db.getUserByUsername(username);
      if (!user) {
        throw new Error('User not found.');
      }

      const wallet = db.getWalletByUuid(user.uuid);
      if (!wallet) {
        throw new Error('Wallet not found for user.');
      }

      const recoveredWallet = createWalletFromMnemonic(mnemonic, {
        network: 'devnet',
      });
      if (recoveredWallet.addresses.devnet !== wallet.address?.devnet) {
        throw new Error('Mnemonic does not match the stored wallet.');
      }

      const updatedUser = db.upsertUser({
        uuid: user.uuid,
        username: user.username,
        api: passkeyProof,
      });
      db.updateWalletByUuid(user.uuid, {
        mnemonic,
        privkey: recoveredWallet.privateKey,
        pubkey: recoveredWallet.publicKey,
        lockArg: recoveredWallet.lockArg,
        address: recoveredWallet.addresses,
      });
      const updatedWallet = db.getWalletByUuid(user.uuid);
      const session = sessions.createSession(updatedUser, { deviceId });

      return {
        ok: true,
        accessToken: session.token,
        owner: {
          uuid: updatedUser.uuid,
          username: updatedUser.username,
        },
        wallet: {
          uuid: updatedWallet.uuid,
          address: updatedWallet.address?.devnet,
          addresses: updatedWallet.address,
          lockArg: updatedWallet.lockArg,
          pubkey: updatedWallet.pubkey,
          label: updatedWallet.label,
        },
        passkeyProof: updatedWallet.privkey,
      };
    },
  };
}
