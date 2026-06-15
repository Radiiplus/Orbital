export function createOrbkitEventService({ bridge, accountInfoService, authService }) {
  return {
    async publishBalanceUpdate(input = {}, context = {}) {
      try {
        await authService.requireOrbkitAuth(context.headers || {});
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'Unauthorized orbkit client.');
      }
      const result = bridge.setDevnetBalance(input.address, input.balance);
      await accountInfoService.publishAccountInfoForAddress(context.pubsub, input.address);
      return result;
    },
    async publishFundingProgress(input = {}, context = {}) {
      try {
        await authService.requireOrbkitAuth(context.headers || {});
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'Unauthorized orbkit client.');
      }
      return bridge.publishFundingEvent(context.pubsub, input);
    },
  };
}
