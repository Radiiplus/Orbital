function normalizeUsername(username) {
  return String(username || '').trim();
}

export function createAccountInfoService({ db, bridge, balanceService }) {
  async function balanceForWallet(address, network, options = {}) {
    if (!balanceService?.getWalletBalance) {
      if (network === 'devnet') return bridge.getDevnetBalance(address)?.balance ?? null;
      return null;
    }
    return balanceService.getWalletBalance({
      address,
      network,
      preferCache: options.preferCache,
    });
  }

  return {
    async getAccountInfo(input = {}) {
      const username = normalizeUsername(input.username);
      if (!username) {
        throw new Error('username is required.');
      }

      const user = db.getUserByUsername(username);
      if (!user) {
        throw new Error('User not found.');
      }

      const wallets = (await Promise.all(db.listWalletsByUuid(user.uuid).map(async (wallet) => {
        const addresses = wallet.address || {};
        return Promise.all(Object.entries(addresses).map(async ([network, address]) => ({
          address,
          network,
          balance: await balanceForWallet(address, network, {
            preferCache: input.preferCache === undefined ? false : input.preferCache,
          }),
        })));
      }))).flat();

      return {
        username: user.username,
        wallets,
      };
    },
    async getAccountInfoByAddress(address) {
      const value = String(address || '').trim();
      if (!value) return null;
      const wallet = db.listWallets().find((item) => (
        item.address
        && Object.values(item.address).includes(value)
      ));
      if (!wallet?.uuid) return null;
      const user = db.getUserByUuid(wallet.uuid);
      if (!user?.username) return null;
      return this.getAccountInfo({
        username: user.username,
        preferCache: true,
      });
    },
    async publishAccountInfoForAddress(pubsub, address) {
      const info = await this.getAccountInfoByAddress(address);
      if (!info) return null;
      await bridge.publishAccountInfo(pubsub, info);
      return info;
    },
    async handleOrbkitEvent(pubsub, payload = {}) {
      const event = payload?.data?.serviceEvents || payload?.serviceEvents || payload || null;
      if (!event) return null;
      if (event.channel !== 'devnet-balance-update') return null;

      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        body = {};
      }

      const address = String(body.address || '').trim();
      const balance = body.balance === undefined || body.balance === null
        ? ''
        : String(body.balance).trim();
      if (!address || !balance) return null;

      bridge.setDevnetBalance(address, balance);
      return this.publishAccountInfoForAddress(pubsub, address);
    },
  };
}
