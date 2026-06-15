import http from 'node:http';
import https from 'node:https';
import { loadConfig } from './common.mjs';
import { resolveServerApiKey } from './serverevents.mjs';

export const DEFAULT_SUPABASE_FUNCTION_URL = 'https://eiwifodbwwingurqifjx.supabase.co/functions/v1/orbital-api';

export function resolveSupabaseFunctionUrl(input = {}) {
  const cfg = input.config || loadConfig(input.configPath || undefined);
  const raw = String(
    input.supabaseUrl
    || input.functionUrl
    || process.env.ORBITAL_SUPABASE_FUNCTION_URL
    || cfg?.supabase?.functionUrl
    || DEFAULT_SUPABASE_FUNCTION_URL,
  ).trim();
  return raw.replace(/\/+$/, '');
}

export function shouldUseFirebaseTransport(input = {}) {
  const mode = String(input.backendMode || process.env.ORBKIT_BACKEND_MODE || '').trim().toLowerCase();
  if (mode === 'firebase' || mode === 'supabase') return true;
  return Boolean(resolveSupabaseFunctionUrl(input));
}

async function requestJson(url, apiKey, path, options = {}) {
  if (!url) throw new Error('ORBITAL_SUPABASE_FUNCTION_URL is required for firebase orbkit transport.');
  const target = `${url}${path}`;
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const transport = target.startsWith('https://') ? https : http;
    const req = transport.request(target, {
      method: options.method || (body ? 'POST' : 'GET'),
      headers: {
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk.toString();
      });
      res.on('end', () => {
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          payload = { raw };
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(payload.message || payload.error || `Supabase request failed (${res.statusCode})`));
          return;
        }
        resolve(payload);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function base(input = {}) {
  const url = resolveSupabaseFunctionUrl(input);
  const apiKey = resolveServerApiKey(input);
  return { url, apiKey };
}

export async function registerFirebaseService(input = {}) {
  const { url, apiKey } = base(input);
  const service = String(input.service || '').trim();
  if (!service) throw new Error('service is required.');
  return requestJson(url, apiKey, '/orbkit/services/register', {
    method: 'POST',
    body: {
      service,
      role: input.role || 'orbkit',
      metadata: input.metadata || null,
    },
  });
}

export async function unregisterFirebaseService(input = {}) {
  const { url, apiKey } = base(input);
  const service = String(input.service || '').trim();
  if (!service) return { ok: true };
  return requestJson(url, apiKey, '/orbkit/services/unregister', {
    method: 'POST',
    body: { service },
  });
}

export async function fetchFirebaseCommands(input = {}) {
  const { url, apiKey } = base(input);
  const service = encodeURIComponent(String(input.serviceName || input.service || '').trim());
  if (!service) throw new Error('serviceName is required.');
  const limit = Number(input.limit || 10);
  const payload = await requestJson(url, apiKey, `/orbkit/commands?service=${service}&limit=${limit}`, {
    method: 'GET',
  });
  return Array.isArray(payload.commands) ? payload.commands : [];
}

export async function ackFirebaseCommand(input = {}) {
  const { url, apiKey } = base(input);
  return requestJson(url, apiKey, '/orbkit/commands/ack', {
    method: 'POST',
    body: {
      commandId: input.commandId,
      status: input.status || 'accepted',
    },
  });
}

export async function publishFirebaseEvent(input = {}) {
  const { url, apiKey } = base(input);
  return requestJson(url, apiKey, '/orbkit/events', {
    method: 'POST',
    body: {
      channel: input.channel,
      service: input.service,
      target: input.target,
      network: input.network,
      body: input.body || {},
    },
  });
}
