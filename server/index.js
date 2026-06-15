import './mod/env.js';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { createAccountService } from './mod/account.js';
import { createAccountWalletService } from './mod/account-wallets.js';
import { createAccountInfoService } from './mod/account-info.js';
import { createAuthService } from './mod/auth.js';
import { createBuildDeployService } from './mod/build-deploy.js';
import { createBalanceService } from './mod/balances.js';
import { createDb } from './mod/db.js';
import { createDevnetService } from './mod/devnet.js';
import { createDeploySimService } from './mod/deploy-sim.js';
import { createFundingService } from './mod/funding.js';
import { createHelperApiKeyService } from './mod/helper-api-keys.js';
import { postGraphql } from './mod/graphql-client.js';
import { createOrbkitEventService } from './mod/orbkit-events.js';
import { createProjectStructureService } from './mod/project-structure.js';
import { createSessionManager } from './mod/session.js';
import { createSessionInfoService } from './mod/session-info.js';
import { createServiceBridge } from './mod/service-bridge.js';
import { createWalletAccessService } from './mod/wallet-access.js';
import { broadcastSignedDeployTransaction } from '../orbkit/mod/deploy-prepare.mjs';
import registerRoutes from './routes/index.js';

const DEFAULT_PORT = Number(process.env.PORT || 4000);
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const ENTRY_PATH = process.argv[1] || '';
const IS_DIRECT_RUN = fileURLToPath(import.meta.url) === ENTRY_PATH;

export function buildServer(options = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  function resolveGraphqlUrl() {
    if (options.graphqlUrl) return String(options.graphqlUrl).trim();
    const address = app.server.address();
    if (address && typeof address === 'object' && 'port' in address) {
      const host = String(options.host || DEFAULT_HOST || '127.0.0.1').trim();
      return `http://${host}:${address.port}/graphql`;
    }
    if (process.env.ORBITAL_SERVER_GRAPHQL_URL) return String(process.env.ORBITAL_SERVER_GRAPHQL_URL).trim();
    return 'http://127.0.0.1:4000/graphql';
  }

  const db = options.db || createDb();
  const sessions = options.sessions || createSessionManager({ db, logger: app.log });
  const serviceBridge = options.serviceBridge || createServiceBridge({ db, logger: app.log });
  const devnetService = options.devnetService || createDevnetService({
    rpcUrl: options.devnetRpcUrl,
  });
  const authService = options.authService || createAuthService({
    orbkitApiKey: options.orbkitApiKey,
    db,
    sessions,
  });
  const internalOrbkitHeaders = {
    authorization: `Bearer ${String(options.orbkitApiKey || process.env.ORBKIT_API_KEY || 'orbkit-dev-key').trim()}`,
  };
  app.decorate('serviceBridge', serviceBridge);
  app.decorate('db', db);
  app.decorate('sessions', sessions);
  app.decorate('devnetService', devnetService);
  app.decorate('authService', authService);
  app.decorate('accountService', options.accountService || createAccountService({ db, sessions }));
  app.decorate('walletAccessService', options.walletAccessService || createWalletAccessService({ db, sessions, authService }));
  app.decorate('accountWalletService', options.accountWalletService || createAccountWalletService({
    db,
    walletAccessService: app.walletAccessService,
  }));
  app.decorate('helperApiKeyService', options.helperApiKeyService || createHelperApiKeyService({
    db,
    walletAccessService: app.walletAccessService,
  }));
  const publishInternalServiceEvent = async (input) => {
    const data = await postGraphql(
      resolveGraphqlUrl(),
      'mutation PublishServiceEvent($channel: String!, $service: String!, $body: String!, $direction: String, $target: String, $network: String) { publishServiceEvent(channel: $channel, service: $service, body: $body, direction: $direction, target: $target, network: $network) { id } }',
      input,
      internalOrbkitHeaders,
    );
    return data.publishServiceEvent || null;
  };
  app.decorate('internalPublishServiceEvent', publishInternalServiceEvent);
  const balanceService = options.balanceService || createBalanceService({
    bridge: serviceBridge,
    publishServiceEvent: publishInternalServiceEvent,
    configPath: options.balanceConfigPath,
    logger: app.log,
  });
  app.decorate('balanceService', balanceService);
  const accountInfoService = options.accountInfoService || createAccountInfoService({
    db,
    bridge: serviceBridge,
    balanceService,
  });
  app.decorate('accountInfoService', accountInfoService);
  app.decorate('orbkitEventService', options.orbkitEventService || createOrbkitEventService({
    bridge: serviceBridge,
    accountInfoService,
    authService,
  }));
  app.decorate('fundingService', options.fundingService || createFundingService({
    bridge: serviceBridge,
    devnetService,
    publishServiceEvent: publishInternalServiceEvent,
  }));
  app.decorate('buildDeployService', options.buildDeployService || createBuildDeployService({
    bridge: serviceBridge,
    db,
    accountInfoService,
    balanceService,
    walletAccessService: app.walletAccessService,
    broadcastSignedDeployTransaction,
    publishServiceEvent: publishInternalServiceEvent,
  }));
  app.decorate('deploySimService', options.deploySimService || createDeploySimService({
    walletAccessService: app.walletAccessService,
    bridge: serviceBridge,
  }));
  app.decorate('projectStructureService', options.projectStructureService || createProjectStructureService({
    bridge: serviceBridge,
    db,
    publishServiceEvent: publishInternalServiceEvent,
  }));
  app.decorate('sessionInfoService', options.sessionInfoService || createSessionInfoService({
    db,
    walletAccessService: app.walletAccessService,
    logger: app.log,
  }));

  if (typeof db.warmup === 'function') {
    db.warmup().catch(() => {
      // The logged warmup error will surface again when a request needs the DB.
    });
  }

  app.addHook('onClose', async () => {
    if (typeof db.flush === 'function') {
      await db.flush({ throwOnError: false });
    }
  });

  app.register(registerRoutes);

  return app;
}

export async function startServer(options = {}) {
  const app = buildServer(options);
  const port = Number(options.port ?? DEFAULT_PORT);
  const host = options.host ?? DEFAULT_HOST;

  await app.listen({ port, host });
  return {
    app,
    host,
    port,
  };
}

if (IS_DIRECT_RUN) {
  startServer()
    .then(({ app, host, port }) => {
      process.stdout.write(`orbital-server listening on http://${host}:${port}\n`);
      process.stdout.write(`orbital-server db provider: ${app.db?.provider || 'stub'}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exit(1);
    });
}
