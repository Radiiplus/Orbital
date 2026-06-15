import mercurius from 'mercurius';

const schema = `
  type Query {
    health: HealthStatus!
    serviceState: ServiceState!
    validateUsername(username: String!): UsernameValidation!
    accountInfo(username: String!): AccountInfo!
    accountAuthStatus(username: String!): AccountAuthStatus!
    userWallets(username: String!, network: String!): [UserWallet!]!

    dbSchema: String!
    runtimeDbSchema: String!
  }

  type Mutation {
    registerService(service: String!, role: String, metadata: String): ServiceState!
    unregisterService(service: String!): ServiceState!
    publishServiceEvent(
      channel: String!
      service: String!
      body: String!
      direction: String
      target: String
      network: String
    ): ServiceEvent!
    createAccount(username: String!, network: String!): AccountCreationResult!
    login(username: String!, passkeyProof: String!, deviceId: String!): LoginResult!
    recoverAccount(username: String!, mnemonic: String!, passkeyProof: String, deviceId: String!): RecoveryResult!
    updateWalletLabel(input: UpdateWalletLabelInput!): UserWallet!
    createAccountWallet(input: AddAccountWalletInput!): UserWallet!
    linkAccountWallet(input: LinkAccountWalletInput!): UserWallet!
    deleteWallet(username: String!, walletAddress: String!, network: String!): Boolean!
    publishOrbkitBalanceUpdate(address: String!, balance: String!): DevnetBalance!
  }

  type Subscription {
    serviceEvents(service: String, channel: String, target: String): ServiceEvent!
    accountInfoStream(username: String!): AccountInfo!
    projectStructureEvents(service: String, contractPath: String): ProjectStructureEvent!
    buildDeployEvents(action: String, contractPath: String, network: String): BuildDeployEvent!
  }

  type HealthStatus {
    ok: Boolean!
    service: String!
  }

  type ServiceState {
    connectedServices: [ConnectedService!]!
    connectedCount: Int!
    updatedAt: String!
  }

  type ConnectedService {
    service: String!
    role: String!
    status: String!
    metadata: String
    connectedAt: String!
    updatedAt: String!
  }

  type ServiceEvent {
    id: String!
    channel: String!
    service: String!
    target: String
    body: String!
    direction: String!
    network: String
    createdAt: String!
  }

  type UsernameValidation {
    ok: Boolean!
    available: Boolean!
    normalized: String!
    reason: String
  }

  type AccountInfo {
    username: String!
    wallets: [AccountWallet!]!
  }

  type AccountAuthStatus {
    ok: Boolean!
    exists: Boolean!
    username: String!
    hasPasskey: Boolean!
  }

  type AccountWallet {
    address: String!
    network: String!
    balance: String
  }

  type UserWallet {
    uuid: String!
    username: String!
    address: String!
    label: String!
    network: String!
    lockArg: String
    publicKey: String
    source: String!
    createdAt: String!
  }

  type AccountCreationResult {
    ok: Boolean!
    createdAt: String!
    owner: AccountOwner
    wallet: WalletRecord!
  }

  type AccountOwner {
    uuid: String!
    username: String
  }

  type LoginResult {
    ok: Boolean!
    accessToken: String!
    owner: AccountOwner!
    wallet: LoginWallet!
  }

  type RecoveryResult {
    ok: Boolean!
    accessToken: String!
    owner: AccountOwner!
    wallet: LoginWallet!
    passkeyProof: String!
  }

  type WalletRecord {
    uuid: String
    address: String!
    addresses: WalletAddresses!
    lockArg: String!
    pubkey: String!
    privkey: String!
    mnemonic: String!
    label: String!
    createdAt: String!
    updatedAt: String!
  }

  type LoginWallet {
    uuid: String
    address: String!
    addresses: WalletAddresses!
    lockArg: String!
    pubkey: String!
    label: String!
  }

  type WalletAddresses {
    devnet: String!
    testnet: String!
    mainnet: String!
  }

  input UpdateWalletLabelInput {
    username: String!
    walletAddress: String!
    label: String!
    network: String!
  }

  input AddAccountWalletInput {
    username: String!
    label: String!
    network: String!
  }

  input LinkAccountWalletInput {
    username: String!
    mnemonic: String!
    label: String!
    network: String!
  }

  type DevnetBalance {
    address: String!
    balance: String!
    updatedAt: String!
  }

  type ProjectStructureEvent {
    streamId: String!
    contractPath: String!
    service: String!
    target: String
    status: String!
    liveSyncEnabled: Boolean!
    syncMode: String!
    changeType: String!
    sequence: Int!
    message: String!
    error: String
    snapshot: String
    createdAt: String!
  }

  type BuildDeployEvent {
    requestId: String!
    action: String!
    status: String!
    phase: String!
    service: String!
    target: String
    network: String
    contractPath: String
    scriptName: String
    message: String!
    error: String
    result: String
    createdAt: String!
  }
`;

function shouldDeliverEvent(event, filter = {}) {
  if (filter.service && event.service !== filter.service) return false;
  if (filter.channel && event.channel !== filter.channel) return false;
  if (filter.target && event.target !== filter.target) return false;
  return true;
}

export default async function graphqlRoutes(fastify) {
  const bridge = fastify.serviceBridge;
  const accountService = fastify.accountService;
  const accountWalletService = fastify.accountWalletService;
  const accountInfoService = fastify.accountInfoService;
  const orbkitEventService = fastify.orbkitEventService;
  const authService = fastify.authService;

  async function flushDbWrites() {
    if (typeof fastify.db?.flush === 'function') {
      await fastify.db.flush();
    }
  }

  async function ensureDbReady() {
    if (typeof fastify.db?.ready === 'function') {
      await fastify.db.ready();
    }
  }

  function requestAuth(context) {
    return {
      headers: context.reply?.request?.headers || context.app?.request?.headers || {},
      reply: context.reply,
    };
  }

  async function maybePublishProjectStructureProgress(pubsub, event) {
    if (event.channel !== 'project-structure-progress') return null;

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      body = {};
    }

    if (!body.contractPath) return null;

    return bridge.publishProjectStructureEvent(pubsub, {
      streamId: body.streamId,
      ownerKey: body.ownerKey,
      projectKey: body.projectKey || body.contractPath,
      contractPath: body.contractPath,
      service: event.service,
      target: event.target,
      status: body.status || 'ready',
      liveSyncEnabled: Boolean(body.liveSyncEnabled),
      syncMode: body.syncMode || 'manual',
      changeType: body.changeType || 'snapshot',
      sequence: Number(body.sequence || 0),
      message: body.message || '',
      error: body.error || null,
      snapshot: body.snapshot ? JSON.stringify(body.snapshot) : null,
      createdAt: body.createdAt || event.createdAt,
    });
  }

  async function maybePublishFundingProgress(pubsub, event) {
    if (event.channel !== 'devnet-fund-wallet-progress') return null;

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      body = {};
    }

    if (!body.requestId) return null;

    return bridge.publishFundingEvent(pubsub, {
      requestId: body.requestId,
      ownerKey: body.ownerKey,
      phase: body.phase || 'progress',
      status: body.status || 'running',
      address: body.address || '',
      amountInCKB: body.amountInCKB || '',
      service: event.service,
      target: event.target,
      txHash: body.txHash || null,
      message: body.message || '',
      error: body.error || null,
      result: body.result || null,
      createdAt: body.createdAt || event.createdAt,
    });
  }

  async function maybePublishBuildDeployProgress(pubsub, event) {
    if (event.channel !== 'build-deploy-progress') return null;

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      body = {};
    }

    if (!body.requestId) return null;

    return bridge.publishBuildDeployEvent(pubsub, {
      requestId: body.requestId,
      ownerKey: body.ownerKey,
      projectKey: body.projectKey || body.contractPath,
      action: body.action || 'build',
      status: body.status || 'running',
      phase: body.phase || 'progress',
      service: event.service,
      target: event.target,
      network: body.network || event.network || null,
      contractPath: body.contractPath || null,
      scriptName: body.scriptName || null,
      message: body.message || '',
      error: body.error || null,
      result: body.result ? JSON.stringify(body.result) : null,
      createdAt: body.createdAt || event.createdAt,
    });
  }

  async function maybeResolveBalanceRequest(event) {
    if (event.channel !== 'wallet-balance-response') return null;

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      body = {};
    }

    const resolved = bridge.resolveBalanceRequest({
      requestId: body.requestId,
      address: body.address,
      network: body.network || event.network || null,
      balance: body.balance ?? body.result?.spendableShannons ?? body.totalShannons ?? body.result?.totalShannons ?? null,
      ok: body.ok,
      error: body.error || null,
      result: body.result || null,
      service: event.service,
      createdAt: body.createdAt || event.createdAt,
    });

    if (resolved.network === 'devnet' && resolved.address && resolved.balance !== null) {
      bridge.setDevnetBalance(resolved.address, resolved.balance);
      await accountInfoService.publishAccountInfoForAddress(pubsub, resolved.address);
    }

    return resolved;
  }

  const resolvers = {
    Query: {
      health: async () => ({
        ok: true,
        service: 'orbital-server',
      }),
      serviceState: async () => bridge.getState(),
      validateUsername: async (_, args) => {
        await ensureDbReady();
        return accountService.validateUsername(args.username);
      },
      accountAuthStatus: async (_, args) => {
        await ensureDbReady();
        return accountService.getAuthStatus(args);
      },
      accountInfo: async (_, args) => {
        await ensureDbReady();
        return accountInfoService.getAccountInfo(args);
      },
      userWallets: async (_, args, context) => {
        await ensureDbReady();
        return accountWalletService.listUserWallets(args, requestAuth(context));
      },

      dbSchema: async () => JSON.stringify(accountService.describeSchema()),
      runtimeDbSchema: async () => JSON.stringify(fastify.db.describeRuntimeSchema?.() || {}),
    },
    Mutation: {
      registerService: async (_, args, context) => {
        try {
          await authService.requireOrbkitAuth(context.app?.request?.headers || context.reply?.request?.headers || {});
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : 'Unauthorized orbkit client.');
        }
        const metadata = args.metadata ? { raw: args.metadata } : null;
        return bridge.registerService({
          service: args.service,
          role: args.role,
          metadata,
        });
      },
      unregisterService: async (_, args, context) => {
        try {
          await authService.requireOrbkitAuth(context.app?.request?.headers || context.reply?.request?.headers || {});
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : 'Unauthorized orbkit client.');
        }
        return bridge.unregisterService(args.service);
      },
      publishServiceEvent: async (_, args, context) => {
        try {
          await authService.requireOrbkitAuth(context.app?.request?.headers || context.reply?.request?.headers || {});
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : 'Unauthorized orbkit client.');
        }
        const published = await bridge.publishServiceEvent(context.pubsub, args);
        await maybePublishFundingProgress(context.pubsub, published);
        await maybePublishProjectStructureProgress(context.pubsub, published);
        await maybePublishBuildDeployProgress(context.pubsub, published);
        await maybeResolveBalanceRequest(published);
        await accountInfoService.handleOrbkitEvent(context.pubsub, {
          serviceEvents: published,
        });
        return published;
      },
      createAccount: async (_, args) => {
        await ensureDbReady();
        const result = accountService.createAccount(args);
        await flushDbWrites();
        return result;
      },
      login: async (_, args) => {
        await ensureDbReady();
        const result = accountService.login(args);
        await flushDbWrites();
        return result;
      },
      recoverAccount: async (_, args) => {
        await ensureDbReady();
        const result = accountService.recoverAccount(args);
        await flushDbWrites();
        return result;
      },
      updateWalletLabel: async (_, args, context) => {
        await ensureDbReady();
        const result = accountWalletService.updateWalletLabel(args.input, requestAuth(context));
        await flushDbWrites();
        return result;
      },
      createAccountWallet: async (_, args, context) => {
        await ensureDbReady();
        const result = accountWalletService.createAccountWallet(args.input, requestAuth(context));
        await flushDbWrites();
        return result;
      },
      linkAccountWallet: async (_, args, context) => {
        await ensureDbReady();
        const result = accountWalletService.linkAccountWallet(args.input, requestAuth(context));
        await flushDbWrites();
        return result;
      },
      deleteWallet: async (_, args, context) => {
        await ensureDbReady();
        const result = accountWalletService.deleteWallet(args, requestAuth(context));
        await flushDbWrites();
        return result;
      },

      publishOrbkitBalanceUpdate: async (_, args, context) => orbkitEventService.publishBalanceUpdate(args, {
        headers: context.reply.request.headers,
        pubsub: context.pubsub,
      }),
    },
    Subscription: {
      serviceEvents: {
        subscribe: async (_, args, context) => {
          const iterator = await context.pubsub.subscribe(bridge.serviceEventTopic);
          return iterator.filter((payload) => shouldDeliverEvent(payload.serviceEvents, args));
        },
      },
      accountInfoStream: {
        subscribe: async (_, args, context) => {
          const iterator = await context.pubsub.subscribe(bridge.accountInfoTopic);
          queueMicrotask(() => {
            (async () => {
              const initial = await accountInfoService.getAccountInfo(args);
              await bridge.publishAccountInfo(context.pubsub, initial);
            })().catch(() => {
              // ignore initial publish failures in subscription bootstrap
            });
          });
          return iterator.filter((payload) => payload?.accountInfo?.username === args.username);
        },
      },
      projectStructureEvents: {
        subscribe: async (_, args, context) => {
          const iterator = await context.pubsub.subscribe(bridge.projectStructureTopic);
          return iterator.filter((payload) => {
            const event = payload?.projectStructureEvents;
            if (!event) return false;
            if (args.service && event.service !== args.service) return false;
            if (args.contractPath && event.contractPath !== args.contractPath) return false;
            return true;
          });
        },
        resolve: (payload) => ({
          ...payload.projectStructureEvents,
          snapshot: payload.projectStructureEvents?.snapshot ?? null,
        }),
      },
      buildDeployEvents: {
        subscribe: async (_, args, context) => {
          const iterator = await context.pubsub.subscribe(bridge.buildDeployTopic);
          return iterator.filter((payload) => {
            const event = payload?.buildDeployEvents;
            if (!event) return false;
            if (args.action && event.action !== args.action) return false;
            if (args.contractPath && event.contractPath !== args.contractPath) return false;
            if (args.network && event.network !== args.network) return false;
            return true;
          });
        },
        resolve: (payload) => ({
          ...payload.buildDeployEvents,
          result: payload.buildDeployEvents?.result ?? null,
        }),
      },
    },
  };

  await fastify.register(mercurius, {
    schema,
    resolvers,
    graphiql: true,
    path: '/graphql',
    subscription: {
      verifyClient: (_info, next) => {
        next(true);
      },
      onConnect: async () => true,
    },
  });
}
