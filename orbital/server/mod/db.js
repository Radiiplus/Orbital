import { randomUUID } from 'node:crypto';
import { describeSchema as describeAccountSchema } from './schema.js';
import { describeRuntimeSchema } from './runtime-schema.js';
import { createFirebaseDb, isFirebaseConfigured } from './firebase-db.js';

function nowIso() {
  return new Date().toISOString();
}

function toHelperApiKeyRecord(user) {
  if (!String(user?.helperApiKey || '').trim()) return null;
  return {
    username: user.username,
    key: user.helperApiKey,
    createdAt: user.helperApiKeyCreatedAt || user.updatedAt || nowIso(),
  };
}

export function createDbStub() {
  const users = new Map();
  const wallets = [];
  const sessions = [];
  const runtime = {
    orbkitServices: new Map(),
    messages: new Map(),
    funding: new Map(),
    structures: new Map(),
    builds: new Map(),
    deploymentReceipts: new Map(),
  };

  function seedUser(user) {
    users.set(user.uuid, {
      ...user,
      helperApiKey: user.helperApiKey ?? null,
      helperApiKeyCreatedAt: user.helperApiKeyCreatedAt ?? null,
      createdAt: user.createdAt || nowIso(),
      updatedAt: nowIso(),
    });
  }

  seedUser({
    uuid: 'user_demo_001',
    username: 'demo-user',
    api: '766962653a594a6c53486544524e656d39624945334e696548624c456a777051456c5130483650625f45424b32713134',
    helperApiKey: '766962653a594a6c53486544524e656d39624945334e696548624c456a777051456c5130483650625f45424b32713134',
  });

  function listWallets() {
    return wallets.map((item) => ({ ...item }));
  }

  function listSessions() {
    return sessions.map((item) => ({
      ...item,
      user: item.user ? { ...item.user } : null,
    }));
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

  return {
    provider: 'stub',
    describeSchema() {
      return {
        ...describeAccountSchema(),
        runtime: describeRuntimeSchema(),
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
        if (String(user.username || '').trim().toLowerCase() === value) return { ...user };
      }
      return null;
    },
    getWalletByUuid(uuid) {
      const value = String(uuid || '').trim();
      if (!value) return null;
      const matches = wallets.filter((item) => String(item.uuid || '').trim() === value);
      return matches.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))[0] || null;
    },
    listWalletsByUuid(uuid) {
      const value = String(uuid || '').trim();
      if (!value) return [];
      return wallets
        .filter((item) => String(item.uuid || '').trim() === value)
        .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
        .map((item) => ({ ...item }));
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
      return { ...record };
    },
    getHelperApiKey(username) {
      const user = this.getUserByUsername(username);
      return toHelperApiKeyRecord(user);
    },
    createHelperApiKey(username, keyInput) {
      const user = this.getUserByUsername(username);
      if (!user) {
        throw new Error('User not found.');
      }
      const key = String(keyInput || '').trim().toLowerCase();
      if (!/^[a-f0-9]{16,128}$/.test(key)) {
        throw new Error('API key must be a hex-like string between 16 and 128 characters.');
      }
      if (Array.from(users.values()).some((item) => item.uuid !== user.uuid && (item.helperApiKey === key || item.api === key))) {
        throw new Error('API key already belongs to another user.');
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
      return toHelperApiKeyRecord(record);
    },
    findUserByHelperApiKey(key) {
      const value = String(key || '').trim();
      if (!value) return null;
      for (const user of users.values()) {
        // Check both 'api' and 'helperApiKey' fields for compatibility
        if (String(user.helperApiKey || '').trim() === value) return { ...user };
        if (String(user.api || '').trim() === value) return { ...user };
      }
      return null;
    },
    createWallet(input) {
      const record = {
        ...input,
        uuid: input.uuid ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      wallets.push(record);
      return { ...record };
    },
    updateWalletByUuid(uuid, patch) {
      const value = String(uuid || '').trim();
      const index = wallets.findIndex((item) => String(item.uuid || '').trim() === value);
      if (index < 0) return null;
      wallets[index] = {
        ...wallets[index],
        ...patch,
        uuid: wallets[index].uuid,
        updatedAt: nowIso(),
      };
      return { ...wallets[index] };
    },
    updateWalletByAddress(uuid, walletAddress, network, patch) {
      const ownerUuid = String(uuid || '').trim();
      const address = String(walletAddress || '').trim();
      const networkName = String(network || '').trim().toLowerCase();
      const index = wallets.findIndex((item) => (
        String(item.uuid || '').trim() === ownerUuid
        && String(item.address?.[networkName] || '').trim() === address
      ));
      if (index < 0) return null;
      wallets[index] = {
        ...wallets[index],
        ...patch,
        uuid: wallets[index].uuid,
        updatedAt: nowIso(),
      };
      return { ...wallets[index] };
    },
    deleteWalletByAddress(uuid, walletAddress, network) {
      const ownerUuid = String(uuid || '').trim();
      const address = String(walletAddress || '').trim();
      const networkName = String(network || '').trim().toLowerCase();
      const index = wallets.findIndex((item) => (
        String(item.uuid || '').trim() === ownerUuid
        && String(item.address?.[networkName] || '').trim() === address
      ));
      if (index < 0) return false;
      wallets.splice(index, 1);
      return true;
    },
    getSessionByUuid(uuid) {
      const value = String(uuid || '').trim();
      if (!value) return null;
      const record = sessions.find((item) => String(item.uuid || '').trim() === value) || null;
      return record ? { ...record, user: record.user ? { ...record.user } : null } : null;
    },
    getSessionByToken(token) {
      const value = String(token || '').trim();
      if (!value) return null;
      const record = sessions.find((item) => String(item.token || '').trim() === value) || null;
      return record ? { ...record, user: record.user ? { ...record.user } : null } : null;
    },
    upsertSession(input) {
      const uuid = String(input?.uuid || '').trim();
      if (!uuid) {
        throw new Error('session uuid is required.');
      }
      const existingIndex = sessions.findIndex((item) => String(item.uuid || '').trim() === uuid);
      const existing = existingIndex >= 0 ? sessions[existingIndex] : null;
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
      if (existingIndex >= 0) {
        sessions[existingIndex] = record;
      } else {
        sessions.push(record);
      }
      return {
        ...record,
        user: record.user ? { ...record.user } : null,
      };
    },
    deleteSessionByUuid(uuid) {
      const value = String(uuid || '').trim();
      const index = sessions.findIndex((item) => String(item.uuid || '').trim() === value);
      if (index < 0) return false;
      sessions.splice(index, 1);
      return true;
    },
    listSessions,
    listWallets,
    upsertOrbkitService(record) {
      const service = String(record?.service || '').trim();
      if (!service) return null;
      runtime.orbkitServices.set(service, { ...record, service });
      return { ...runtime.orbkitServices.get(service) };
    },
    deleteOrbkitService(service) {
      return runtime.orbkitServices.delete(String(service || '').trim());
    },
    listOrbkitServices() {
      return Array.from(runtime.orbkitServices.values()).map((record) => ({ ...record }));
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
      runtime.messages.set(key, next);
      return { ...next };
    },
    upsertFundingState(record) {
      const owner = ownerKey(record?.ownerKey);
      const key = record?.key || stateKey([owner, 'funding']);
      const next = { ...record, key, ownerKey: owner };
      runtime.funding.set(key, next);
      return { ...next };
    },
    getLatestFundingEvent(requestId) {
      const key = String(requestId || '').trim();
      if (!key) return null;
      return Array.from(runtime.funding.values())
        .filter((record) => String(record.requestId || '').trim() === key)
        .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
    },
    upsertProjectStructureState(record) {
      const owner = ownerKey(record?.ownerKey);
      const project = projectKey(record?.projectKey || record?.contractPath);
      const key = record?.key || stateKey([owner, project, 'structure']);
      const existing = runtime.structures.get(key) || {};
      const next = { ...record, key, ownerKey: owner, projectKey: project };
      if (next.snapshot === null || next.snapshot === undefined) {
        delete next.snapshot;
      }
      const merged = { ...existing, ...next };
      runtime.structures.set(key, merged);
      return { ...merged };
    },
    getLatestProjectStructureEvent(input = {}) {
      const owner = input.ownerKey ? ownerKey(input.ownerKey) : '';
      const project = projectKey(input.projectKey || input.contractPath, '');
      if (owner && project) {
        const exact = runtime.structures.get(stateKey([owner, project, 'structure']));
        if (exact) return exact;
      }
      const contractPath = String(input.contractPath || '').trim();
      const service = String(input.service || '').trim();
      if (!contractPath) return null;
      return Array.from(runtime.structures.values())
        .filter((record) => (
          String(record.contractPath || '').trim() === contractPath
          && (
            !service
            || String(record.service || '').trim() === service
            || String(record.target || '').trim() === service
          )
        ))
        .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0] || null;
    },
    upsertBuildDeployState(record) {
      const owner = ownerKey(record?.ownerKey);
      const project = projectKey(record?.projectKey || record?.contractPath, 'runtime');
      const key = record?.key || stateKey([owner, project, record?.network || 'network', record?.action || 'build']);
      const next = { ...record, key, ownerKey: owner, projectKey: project };
      runtime.builds.set(key, next);
      return { ...next };
    },
    getLatestBuildDeployEvent(requestId) {
      const key = String(requestId || '').trim();
      if (!key) return null;
      return Array.from(runtime.builds.values())
        .filter((record) => String(record.requestId || '').trim() === key)
        .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
    },
    upsertDeploymentReceipt(record) {
      const owner = ownerKey(record?.ownerKey);
      const project = projectKey(record?.projectKey || record?.contractPath);
      const network = String(record?.network || '').trim().toLowerCase();
      const contractPath = String(record?.contractPath || '').trim();
      if (!network || !contractPath) return null;
      const key = record?.key || stateKey([owner, project, network, contractPath, 'deployment']);
      const next = { ...record, key, ownerKey: owner, projectKey: project, network, contractPath };
      runtime.deploymentReceipts.set(key, next);
      return { ...next };
    },
    getDeploymentReceipt(input = {}) {
      const owner = ownerKey(input.ownerKey);
      const project = projectKey(input.projectKey || input.contractPath);
      const network = String(input.network || '').trim().toLowerCase();
      const contractPath = String(input.contractPath || '').trim();
      if (!network || !contractPath) return null;
      return runtime.deploymentReceipts.get(stateKey([owner, project, network, contractPath, 'deployment']))
        || runtime.deploymentReceipts.get(stateKey(['runtime', project, network, contractPath, 'deployment']))
        || null;
    },
  };
}

export function createDb() {
  if (process.env.ORBITAL_DB_PROVIDER === 'stub') {
    return createDbStub();
  }
  if (isFirebaseConfigured()) {
    return createFirebaseDb();
  }
  return createDbStub();
}
