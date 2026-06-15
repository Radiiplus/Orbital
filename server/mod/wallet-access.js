function normalizeAccessToken(value) {
  return String(value || '').trim();
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function resolveAccessToken(input = {}, authService) {
  const directToken = normalizeAccessToken(input.accessToken);
  if (directToken) return directToken;
  if (authService) {
    return authService.getBearerToken(input.headers || {});
  }
  return '';
}

function resolveDeviceId(input = {}) {
  return normalizeDeviceId(input.deviceId || input.headers?.['x-device-id'] || input.headers?.['X-Device-Id']);
}

function normalizeNetwork(value) {
  const network = String(value || '').trim().toLowerCase();
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) {
    throw new Error('network must be one of: devnet, testnet, mainnet.');
  }
  return network;
}

function normalizeWalletAddress(value) {
  return String(value || '').trim();
}

export function createWalletAccessService({ db, sessions, authService }) {
  function resolveUserByAccessToken(input = {}) {
    const accessToken = resolveAccessToken(input, authService);
    if (!accessToken) {
      throw new Error('accessToken is required.');
    }
    const session = sessions.validateToken(accessToken, {
      deviceId: resolveDeviceId(input),
    });
    if (!session?.user?.uuid) {
      throw new Error('Invalid access token.');
    }
    const user = db.getUserByUuid(session.user.uuid);
    if (!user) {
      throw new Error('User not found for access token.');
    }
      return user;
  }

  return {
    resolveSession(input = {}) {
      const accessToken = resolveAccessToken(input, authService);
      if (!accessToken) {
        throw new Error('accessToken is required.');
      }
      const session = sessions.validateToken(accessToken, {
        deviceId: resolveDeviceId(input),
      });
      if (!session?.user?.uuid) {
        throw new Error('Invalid access token.');
      }
      return session;
    },
    refreshSession(input = {}) {
      const accessToken = resolveAccessToken(input, authService);
      if (!accessToken) {
        throw new Error('accessToken is required.');
      }
      const session = sessions.refreshToken(accessToken, {
        deviceId: resolveDeviceId(input),
      });
      if (!session?.user?.uuid) {
        throw new Error('Invalid access token.');
      }
      return session;
    },
    resolveDeployWallet(input = {}) {
      const session = this.resolveSession(input);
      const user = db.getUserByUuid(session.user.uuid);
      if (!user) {
        throw new Error('User not found for access token.');
      }
      const network = normalizeNetwork(input.network);
      const requestedAddress = normalizeWalletAddress(input.walletAddress || input.address);
      const wallet = requestedAddress
        ? db.listWalletsByUuid(user.uuid).find((item) => String(item.address?.[network] || '').trim() === requestedAddress)
        : db.getWalletByUuid(user.uuid);
      if (!wallet) {
        throw new Error('Wallet not found for user.');
      }

      const address = wallet.address?.[network] || null;
      if (!address) {
        throw new Error(`No ${network} wallet address found for user.`);
      }

      return {
        userUuid: user.uuid,
        username: user.username,
        network,
        label: wallet.label || user.username || null,
        address,
        session,
        privkey: wallet.privkey,
      };
    },
  };
}
