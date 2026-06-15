import { randomBytes, randomUUID } from 'node:crypto';
import { getApps, initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { describeSchema as describeAccountSchema } from './schema.js';
import { describeRuntimeSchema } from './runtime-schema.js';

function nowIso() {
  return new Date().toISOString();
}

function createHelperKey() {
  return `orb_${randomBytes(24).toString('hex')}`;
}

function toHelperApiKeyRecord(user) {
  if (!String(user?.helperApiKey || '').trim()) return null;
  return {
    username: user.username,
    key: user.helperApiKey,
    createdAt: user.helperApiKeyCreatedAt || user.updatedAt || nowIso(),
  };
}

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function hasExplicitFirebaseCredentials() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID
    && process.env.FIREBASE_CLIENT_EMAIL
    && process.env.FIREBASE_PRIVATE_KEY,
  );
}

export function isFirebaseConfigured() {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.FIREBASE_DATABASE_URL
    || hasExplicitFirebaseCredentials(),
  );
}

function createFirebaseApp() {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  if (hasExplicitFirebaseCredentials()) {
    return initializeApp({
      credential: cert({
        projectId: String(process.env.FIREBASE_PROJECT_ID).trim(),
        clientEmail: String(process.env.FIREBASE_CLIENT_EMAIL).trim(),
        privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
    });
  }

  return initializeApp({
    credential: applicationDefault(),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  });
}

function trackPendingWrite(pendingWrites, writeFailures, work) {
  const promise = Promise.resolve()
    .then(work)
    .catch((error) => {
      console.error(`[firebase-db] write failed: ${error instanceof Error ? error.message : String(error)}`);
      writeFailures.push(error);
      throw error;
    })
    .finally(() => {
      pendingWrites.delete(promise);
    });
  pendingWrites.add(promise);
}

function runtimeDocId(value) {
  return Buffer.from(String(value || '').trim()).toString('base64url');
}

function ownerKey(value) {
  return String(value || 'runtime').trim() || 'runtime';
}

function projectKey(value, fallback = 'runtime') {
  return String(value || fallback || 'runtime').trim().replace(/\\/g, '/') || 'runtime';
}

function stateKey(parts) {
  return parts.map((part) => String(part || 'runtime').trim() || 'runtime').join(':');
}

export function createFirebaseDb() {
  const app = createFirebaseApp();
  const firestore = getFirestore(app);
  const schema = describeAccountSchema();
  const runtimeSchema = describeRuntimeSchema();
  const users = new Map();
  const wallets = new Map();
  const sessions = new Map();
  const pendingWrites = new Set();
  const writeFailures = [];

  const collections = {
    users: firestore.collection(process.env.FIREBASE_USERS_COLLECTION || 'users'),
    wallets: firestore.collection(process.env.FIREBASE_WALLETS_COLLECTION || 'wallets'),
    sessions: firestore.collection(process.env.FIREBASE_SESSIONS_COLLECTION || 'sessions'),
  };
  const runtimeCollections = {
    services: firestore.collection(process.env.FIREBASE_RUNTIME_SERVICES_COLLECTION || 'services'),
    messages: firestore.collection(process.env.FIREBASE_RUNTIME_MESSAGES_COLLECTION || 'messages'),
    funding: firestore.collection(process.env.FIREBASE_RUNTIME_FUNDING_COLLECTION || 'funding'),
    structures: firestore.collection(process.env.FIREBASE_RUNTIME_STRUCTURES_COLLECTION || 'structures'),
    builds: firestore.collection(process.env.FIREBASE_RUNTIME_BUILDS_COLLECTION || 'builds'),
    deployments: firestore.collection(process.env.FIREBASE_RUNTIME_DEPLOYMENTS_COLLECTION || 'deployments'),
  };
  const metadataCollection = firestore.collection(process.env.FIREBASE_METADATA_COLLECTION || '_meta');

  async function ensureCollections() {
    const accountWrites = Object.entries(collections).map(async ([name, collectionRef]) => {
      await metadataCollection.doc(`collection:${name}`).set({
        kind: 'collection',
        collection: collectionRef.id,
        schema: schema[name] || null,
        ensuredAt: nowIso(),
      }, { merge: true });
      await collectionRef.doc('_schema').set({
        kind: 'schema',
        collection: collectionRef.id,
        schema: schema[name] || null,
        updatedAt: nowIso(),
      }, { merge: true });
    });
    const runtimeWrites = Object.entries(runtimeCollections).map(async ([name, collectionRef]) => {
      await metadataCollection.doc(`runtime:${name}`).set({
        kind: 'runtime-collection',
        collection: collectionRef.id,
        schema: runtimeSchema[name] || null,
        ensuredAt: nowIso(),
      }, { merge: true });
      await collectionRef.doc('_schema').set({
        kind: 'schema',
        collection: collectionRef.id,
        schema: runtimeSchema[name] || null,
        updatedAt: nowIso(),
      }, { merge: true });
    });
    await Promise.all([...accountWrites, ...runtimeWrites]);
  }

  async function hydrate() {
    await ensureCollections();
    const [userSnap, walletSnap, sessionSnap] = await Promise.all([
      collections.users.get(),
      collections.wallets.get(),
      collections.sessions.get(),
    ]);

    users.clear();
    wallets.clear();
    sessions.clear();

    for (const doc of userSnap.docs) {
      if (doc.id === '_schema') continue;
      const data = doc.data() || {};
      users.set(doc.id, {
        uuid: doc.id,
        username: data.username ?? null,
        api: data.api ?? null,
        helperApiKey: data.helperApiKey ?? null,
        helperApiKeyCreatedAt: data.helperApiKeyCreatedAt ?? null,
        createdAt: data.createdAt || nowIso(),
        updatedAt: data.updatedAt || nowIso(),
      });
    }

    for (const doc of walletSnap.docs) {
      if (doc.id === '_schema') continue;
      const data = doc.data() || {};
      wallets.set(doc.id, {
        id: doc.id,
        uuid: data.uuid || doc.id,
        address: data.address || null,
        lockArg: data.lockArg || '',
        pubkey: data.pubkey || '',
        privkey: data.privkey || '',
        mnemonic: data.mnemonic || '',
        label: data.label || '',
        createdAt: data.createdAt || nowIso(),
        updatedAt: data.updatedAt || nowIso(),
      });
    }

    for (const doc of sessionSnap.docs) {
      if (doc.id === '_schema') continue;
      const data = doc.data() || {};
      sessions.set(doc.id, {
        uuid: doc.id,
        token: data.token || '',
        deviceId: data.deviceId || null,
        user: data.user ? { ...data.user } : null,
        expiresAt: Number(data.expiresAt || 0),
        createdAt: data.createdAt || nowIso(),
        updatedAt: data.updatedAt || nowIso(),
      });
    }
  }

  const readyPromise = hydrate();

  return {
    provider: 'firebase',
    ready() {
      return readyPromise;
    },
    warmup() {
      readyPromise
        .then(() => {
          process.stdout.write('[firebase-db] ready\n');
        })
        .catch((error) => {
          process.stderr.write(`[firebase-db] startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      return readyPromise;
    },
    async flush(options = {}) {
      await Promise.allSettled(Array.from(pendingWrites));
      const failures = writeFailures.splice(0);
      if (failures.length > 0 && options.throwOnError !== false) {
        const message = failures
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join('; ');
        throw new Error(`Firebase write failed: ${message}`);
      }
    },
    describeSchema() {
      return {
        ...describeAccountSchema(),
        runtime: runtimeSchema,
      };
    },
    describeRuntimeSchema,
    getUserByUuid(uuid) {
      return users.get(String(uuid || '').trim()) || null;
    },
    getUserByUsername(username) {
      const value = String(username || '').trim().toLowerCase();
      if (!value) return null;
      for (const user of users.values()) {
        if (String(user.username || '').trim().toLowerCase() === value) {
          return { ...user };
        }
      }
      return null;
    },
    getWalletByUuid(uuid) {
      const value = String(uuid || '').trim();
      if (!value) return null;
      const records = Array.from(wallets.values())
        .filter((record) => String(record.uuid || '').trim() === value)
        .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
      return records[0] ? { ...records[0] } : null;
    },
    listWalletsByUuid(uuid) {
      const value = String(uuid || '').trim();
      if (!value) return [];
      return Array.from(wallets.values())
        .filter((record) => String(record.uuid || '').trim() === value)
        .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
        .map((record) => ({ ...record }));
    },
    isUsernameAvailable(username) {
      return !this.getUserByUsername(username);
    },
    upsertUser(input) {
      const existing = this.getUserByUuid(input.uuid);
      const record = {
        ...existing,
        ...input,
        uuid: String(input.uuid || existing?.uuid || '').trim(),
        username: input.username ?? existing?.username ?? null,
        api: input.api ?? existing?.api ?? null,
        helperApiKey: input.helperApiKey ?? existing?.helperApiKey ?? null,
        helperApiKeyCreatedAt: input.helperApiKeyCreatedAt ?? existing?.helperApiKeyCreatedAt ?? null,
        updatedAt: nowIso(),
        createdAt: existing?.createdAt || nowIso(),
      };
      users.set(record.uuid, record);
      trackPendingWrite(pendingWrites, writeFailures, () => collections.users.doc(record.uuid).set(record, { merge: true }));
      return { ...record };
    },
    getHelperApiKey(username) {
      const user = this.getUserByUsername(username);
      return toHelperApiKeyRecord(user);
    },
    createHelperApiKey(username) {
      const user = this.getUserByUsername(username);
      if (!user) {
        throw new Error('User not found.');
      }
      let key = createHelperKey();
      while (Array.from(users.values()).some((record) => record.helperApiKey === key || record.api === key)) {
        key = createHelperKey();
      }
      const createdAt = nowIso();
      const existing = users.get(user.uuid) || user;
      const record = {
        ...existing,
        api: key,
        helperApiKey: key,
        helperApiKeyCreatedAt: createdAt,
        updatedAt: createdAt,
      };
      users.set(record.uuid, record);
      trackPendingWrite(pendingWrites, writeFailures, () => collections.users.doc(record.uuid).set(record, { merge: true }));
      return toHelperApiKeyRecord(record);
    },
    findUserByHelperApiKey(key) {
      const value = String(key || '').trim();
      if (!value) return null;
      for (const user of users.values()) {
        if (String(user.helperApiKey || '').trim() === value) return { ...user };
        if (String(user.api || '').trim() === value) return { ...user };
      }
      return null;
    },
    createWallet(input) {
      const ownerUuid = String(input.uuid ?? '').trim();
      if (!ownerUuid) {
        throw new Error('wallet uuid is required.');
      }
      const networkAddresses = input.address || {};
      const existing = Array.from(wallets.values()).find((record) => (
        String(record.uuid || '').trim() === ownerUuid
        && Object.entries(networkAddresses).some(([network, address]) => (
          String(record.address?.[network] || '').trim()
          && String(record.address?.[network] || '').trim() === String(address || '').trim()
        ))
      ));
      const record = {
        ...(existing || {}),
        ...input,
        id: existing?.id || input.id || `${ownerUuid}:${randomUUID()}`,
        uuid: ownerUuid,
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso(),
      };
      wallets.set(record.id, record);
      trackPendingWrite(pendingWrites, writeFailures, () => collections.wallets.doc(record.id).set(record, { merge: true }));
      return { ...record };
    },
    updateWalletByUuid(uuid, patch) {
      const value = String(uuid || '').trim();
      const existing = Array.from(wallets.values())
        .filter((record) => String(record.uuid || '').trim() === value)
        .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))[0];
      if (!existing) return null;
      const record = {
        ...existing,
        ...patch,
        uuid: existing.uuid,
        updatedAt: nowIso(),
      };
      wallets.set(record.id, record);
      trackPendingWrite(pendingWrites, writeFailures, () => collections.wallets.doc(record.id).set(record, { merge: true }));
      return { ...record };
    },
    updateWalletByAddress(uuid, walletAddress, network, patch) {
      const ownerUuid = String(uuid || '').trim();
      const address = String(walletAddress || '').trim();
      const networkName = String(network || '').trim().toLowerCase();
      const existing = Array.from(wallets.values()).find((record) => (
        String(record.uuid || '').trim() === ownerUuid
        && String(record.address?.[networkName] || '').trim() === address
      ));
      if (!existing) return null;
      const record = {
        ...existing,
        ...patch,
        uuid: existing.uuid,
        updatedAt: nowIso(),
      };
      wallets.set(record.id, record);
      trackPendingWrite(pendingWrites, writeFailures, () => collections.wallets.doc(record.id).set(record, { merge: true }));
      return { ...record };
    },
    deleteWalletByAddress(uuid, walletAddress, network) {
      const ownerUuid = String(uuid || '').trim();
      const address = String(walletAddress || '').trim();
      const networkName = String(network || '').trim().toLowerCase();
      const existing = Array.from(wallets.values()).find((record) => (
        String(record.uuid || '').trim() === ownerUuid
        && String(record.address?.[networkName] || '').trim() === address
      ));
      if (!existing) return false;
      wallets.delete(existing.id);
      trackPendingWrite(pendingWrites, writeFailures, () => collections.wallets.doc(existing.id).delete());
      return true;
    },
    getSessionByUuid(uuid) {
      const record = sessions.get(String(uuid || '').trim()) || null;
      return record ? { ...record, user: record.user ? { ...record.user } : null } : null;
    },
    getSessionByToken(token) {
      const value = String(token || '').trim();
      if (!value) return null;
      for (const record of sessions.values()) {
        if (String(record.token || '').trim() === value) {
          return { ...record, user: record.user ? { ...record.user } : null };
        }
      }
      return null;
    },
    upsertSession(input) {
      const uuid = String(input?.uuid || '').trim();
      if (!uuid) {
        throw new Error('session uuid is required.');
      }
      const existing = sessions.get(uuid) || null;
      const record = {
        ...existing,
        ...input,
        uuid,
        token: String(input?.token || existing?.token || '').trim(),
        deviceId: String(input?.deviceId || existing?.deviceId || '').trim() || null,
        user: input?.user ? { ...input.user } : (existing?.user ? { ...existing.user } : null),
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso(),
      };
      sessions.set(uuid, record);
      trackPendingWrite(pendingWrites, writeFailures, () => collections.sessions.doc(uuid).set(record, { merge: true }));
      return { ...record, user: record.user ? { ...record.user } : null };
    },
    deleteSessionByUuid(uuid) {
      const value = String(uuid || '').trim();
      const existed = sessions.delete(value);
      if (existed) {
        trackPendingWrite(pendingWrites, writeFailures, () => collections.sessions.doc(value).delete());
      }
      return existed;
    },
    listSessions() {
      return Array.from(sessions.values()).map((item) => ({
        ...item,
        user: item.user ? { ...item.user } : null,
      }));
    },
    listWallets() {
      return Array.from(wallets.values()).map((item) => ({ ...item }));
    },
    upsertOrbkitService(record) {
      const service = String(record?.service || '').trim();
      if (!service) return null;
      const next = { ...record, service };
      trackPendingWrite(pendingWrites, writeFailures, () => runtimeCollections.services.doc(runtimeDocId(service)).set(next, { merge: true }));
      return { ...next };
    },
    deleteOrbkitService(service) {
      const value = String(service || '').trim();
      if (!value) return false;
      trackPendingWrite(pendingWrites, writeFailures, () => runtimeCollections.services.doc(runtimeDocId(value)).delete());
      return true;
    },
    async listOrbkitServices() {
      const snap = await runtimeCollections.services.get();
      return snap.docs
        .filter((doc) => doc.id !== '_schema')
        .map((doc) => ({ service: doc.id, ...doc.data() }));
    },
    upsertRuntimeMessage(record) {
      const owner = ownerKey(record?.ownerKey);
      const project = projectKey(record?.projectKey, 'runtime');
      const key = record?.key || stateKey([
        owner,
        project,
        record?.channel,
        record?.target || record?.service,
      ]);
      const next = { ...record, key, ownerKey: owner, projectKey: project };
      trackPendingWrite(pendingWrites, writeFailures, () => runtimeCollections.messages.doc(runtimeDocId(key)).set(next, { merge: true }));
      return { ...next };
    },
    upsertFundingState(record) {
      const owner = ownerKey(record?.ownerKey);
      const key = record?.key || stateKey([owner, 'funding']);
      const next = { ...record, key, ownerKey: owner };
      trackPendingWrite(pendingWrites, writeFailures, () => runtimeCollections.funding.doc(runtimeDocId(key)).set(next, { merge: true }));
      return { ...next };
    },
    async getLatestFundingEvent(requestId) {
      const key = String(requestId || '').trim();
      if (!key) return null;
      const snap = await runtimeCollections.funding
        .where('requestId', '==', key)
        .get();
      return snap.docs
        .map((doc) => doc.data())
        .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
    },
    upsertProjectStructureState(record) {
      const owner = ownerKey(record?.ownerKey);
      const project = projectKey(record?.projectKey || record?.contractPath);
      const key = record?.key || stateKey([owner, project, 'structure']);
      const next = { ...record, key, ownerKey: owner, projectKey: project, updatedAt: nowIso() };
      if (next.snapshot === null || next.snapshot === undefined) {
        delete next.snapshot;
      }
      trackPendingWrite(pendingWrites, writeFailures, () => runtimeCollections.structures.doc(runtimeDocId(key)).set(next, { merge: true }));
      return { ...next };
    },
    async getLatestProjectStructureEvent(input = {}) {
      const owner = input.ownerKey ? ownerKey(input.ownerKey) : '';
      const project = projectKey(input.projectKey || input.contractPath, '');
      if (owner && project) {
        const doc = await runtimeCollections.structures.doc(runtimeDocId(stateKey([owner, project, 'structure']))).get();
        if (doc.exists) return doc.data();
      }
      const contractPath = String(input.contractPath || '').trim();
      if (!contractPath) return null;
      const snap = await runtimeCollections.structures
        .where('contractPath', '==', contractPath)
        .get();
      return snap.docs
        .map((doc) => doc.data())
        .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0] || null;
    },
    upsertBuildDeployState(record) {
      const owner = ownerKey(record?.ownerKey);
      const project = projectKey(record?.projectKey || record?.contractPath, 'runtime');
      const key = record?.key || stateKey([owner, project, record?.network || 'network', record?.action || 'build']);
      const next = { ...record, key, ownerKey: owner, projectKey: project };
      trackPendingWrite(pendingWrites, writeFailures, () => runtimeCollections.builds.doc(runtimeDocId(key)).set(next, { merge: true }));
      return { ...next };
    },
    async getLatestBuildDeployEvent(requestId) {
      const key = String(requestId || '').trim();
      if (!key) return null;
      const snap = await runtimeCollections.builds
        .where('requestId', '==', key)
        .get();
      return snap.docs
        .map((doc) => doc.data())
        .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
    },
    upsertDeploymentReceipt(record) {
      const owner = ownerKey(record?.ownerKey);
      const project = projectKey(record?.projectKey || record?.contractPath);
      const network = String(record?.network || '').trim().toLowerCase();
      const contractPath = String(record?.contractPath || '').trim();
      if (!network || !contractPath) return null;
      const key = record?.key || stateKey([owner, project, network, contractPath, 'deployment']);
      const next = { ...record, key, ownerKey: owner, projectKey: project, network, contractPath, updatedAt: nowIso() };
      trackPendingWrite(pendingWrites, writeFailures, () => runtimeCollections.deployments.doc(runtimeDocId(key)).set(next, { merge: true }));
      return { ...next };
    },
    async getDeploymentReceipt(input = {}) {
      const owner = ownerKey(input.ownerKey);
      const project = projectKey(input.projectKey || input.contractPath);
      const network = String(input.network || '').trim().toLowerCase();
      const contractPath = String(input.contractPath || '').trim();
      if (!network || !contractPath) return null;
      const primary = await runtimeCollections.deployments.doc(runtimeDocId(stateKey([owner, project, network, contractPath, 'deployment']))).get();
      if (primary.exists) return primary.data();
      const fallback = await runtimeCollections.deployments.doc(runtimeDocId(stateKey(['runtime', project, network, contractPath, 'deployment']))).get();
      return fallback.exists ? fallback.data() : null;
    },
  };
}
