import http from 'node:http';
import https from 'node:https';
import { loadConfig } from './common.mjs';

export const DEFAULT_ORBITAL_SERVER_GRAPHQL_URL = 'http://127.0.0.1:4000/graphql';

export function resolveServerGraphqlUrl(input = {}) {
  const cfg = input.config || loadConfig(input.configPath || undefined);
  return String(
    input.url
    || process.env.ORBITAL_SERVER_GRAPHQL_URL
    || cfg?.graphql?.httpUrl
    || cfg?.graphql?.url
    || DEFAULT_ORBITAL_SERVER_GRAPHQL_URL,
  ).trim();
}

export function resolveServerApiKey(input = {}) {
  const cfg = input.config || loadConfig(input.configPath || undefined);
  return String(
    input.apiKey
    || process.env.ORBKIT_API_KEY
    || cfg?.api?.authToken
    || cfg?.graphql?.authToken
    || '',
  ).trim();
}

async function postGraphql(url, apiKey, query, variables) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const transport = String(url).startsWith('https://') ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk.toString();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw || '{}');
          if (parsed.errors?.length) {
            reject(new Error(parsed.errors[0].message || 'GraphQL request failed.'));
            return;
          }
          resolve(parsed.data || {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function registerOrbkitService(input = {}) {
  const url = resolveServerGraphqlUrl(input);
  const apiKey = resolveServerApiKey(input);
  const service = String(input.service || '').trim();
  if (!service) throw new Error('service is required.');
  const data = await postGraphql(
    url,
    apiKey,
    'mutation RegisterService($service: String!, $role: String, $metadata: String) { registerService(service: $service, role: $role, metadata: $metadata) { connectedCount updatedAt } }',
    {
      service,
      role: input.role || 'orbkit',
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    },
  );
  return data.registerService;
}

export async function unregisterOrbkitService(input = {}) {
  const url = resolveServerGraphqlUrl(input);
  const apiKey = resolveServerApiKey(input);
  const service = String(input.service || '').trim();
  if (!service) throw new Error('service is required.');
  const data = await postGraphql(
    url,
    apiKey,
    'mutation UnregisterService($service: String!) { unregisterService(service: $service) { connectedCount updatedAt } }',
    {
      service,
    },
  );
  return data.unregisterService;
}

export async function publishServiceEvent(input = {}) {
  const url = resolveServerGraphqlUrl(input);
  const apiKey = resolveServerApiKey(input);
  const data = await postGraphql(
    url,
    apiKey,
    'mutation PublishServiceEvent($channel: String!, $service: String!, $body: String!, $direction: String, $target: String, $network: String) { publishServiceEvent(channel: $channel, service: $service, body: $body, direction: $direction, target: $target, network: $network) { id channel service target body direction network createdAt } }',
    {
      channel: String(input.channel || '').trim(),
      service: String(input.service || '').trim(),
      body: String(input.body || ''),
      direction: input.direction || 'outbound',
      target: input.target ? String(input.target).trim() : null,
      network: input.network ? String(input.network).trim() : null,
    },
  );
  return data.publishServiceEvent;
}

export async function publishOrbkitBalanceUpdate(input = {}) {
  const url = resolveServerGraphqlUrl(input);
  const apiKey = resolveServerApiKey(input);
  const data = await postGraphql(
    url,
    apiKey,
    'mutation PublishOrbkitBalanceUpdate($address: String!, $balance: String!) { publishOrbkitBalanceUpdate(address: $address, balance: $balance) { address balance updatedAt } }',
    {
      address: input.address,
      balance: String(input.balance),
    },
  );
  return data.publishOrbkitBalanceUpdate;
}

export async function publishProjectStructureProgress(input = {}) {
  return publishServiceEvent({
    ...input,
    channel: 'project-structure-progress',
    direction: input.direction || 'outbound',
    body: JSON.stringify({
      streamId: input.streamId,
      contractPath: input.contractPath,
      status: input.status,
      liveSyncEnabled: Boolean(input.liveSyncEnabled),
      syncMode: input.syncMode,
      changeType: input.changeType,
      sequence: input.sequence || 0,
      message: input.message || '',
      error: input.error || null,
      snapshot: input.snapshot ?? null,
      createdAt: input.createdAt,
    }),
  });
}
