import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { loadConfig } from './common.mjs';

const CLIENTS = new Map();
export const DEFAULT_ORBITAL_GRAPHQL_URL = 'http://127.0.0.1:4000/graphql';

function toWebSocketUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new Error('GraphQL WebSocket URL is required.');
  }
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw;
  if (raw.startsWith('http://')) return `ws://${raw.slice('http://'.length)}`;
  if (raw.startsWith('https://')) return `wss://${raw.slice('https://'.length)}`;
  throw new Error(`Unsupported GraphQL endpoint URL: ${raw}`);
}

export function resolveGraphqlWebSocketUrl(input = {}) {
  const cfg = input.config || loadConfig(input.configPath || undefined);
  const explicit = String(
    input.wsUrl
    || process.env.ORBITAL_GRAPHQL_WS_URL
    || cfg?.graphql?.wsUrl
    || cfg?.graphql?.url
    || process.env.ORBITAL_GRAPHQL_URL
    || cfg?.graphql?.httpUrl
    || DEFAULT_ORBITAL_GRAPHQL_URL,
  ).trim();
  return toWebSocketUrl(explicit);
}

export function resolveGraphqlAuthToken(input = {}) {
  const cfg = input.config || loadConfig(input.configPath || undefined);
  return String(
    input.authToken
    || input.apiKey
    || process.env.ORBKIT_API_KEY
    || process.env.ORBITAL_API_KEY
    || cfg?.graphql?.authToken
    || cfg?.api?.authToken
    || '',
  ).trim();
}

export function buildGraphqlConnectionParams(input = {}) {
  const authToken = resolveGraphqlAuthToken(input);
  const base = {
    ...(input.connectionParams || {}),
  };
  if (!authToken) return base;
  return {
    ...base,
    headers: {
      ...(base.headers || {}),
      authorization: `Bearer ${authToken}`,
    },
  };
}

class PersistentGraphqlWsClient {
  constructor(options = {}) {
    this.url = options.url;
    this.connectionParams = options.connectionParams || {};
    this.protocol = options.protocol || 'graphql-transport-ws';
    this.ackTimeoutMs = Math.max(250, Number(options.ackTimeoutMs || 5000));
    this.reconnectDelayMs = Math.max(250, Number(options.reconnectDelayMs || 1000));
    this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, Number(options.maxReconnectDelayMs || 8000));
    this.lazyDisconnectMs = Math.max(0, Number(options.lazyDisconnectMs || 15000));
    this.socket = null;
    this.connectPromise = null;
    this.connectionAcked = false;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.reconnectAttempt = 0;
    this.operations = new Map();
  }

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.connectionAcked) {
      return this;
    }
    if (this.connectPromise) return this.connectPromise;

    this.clearIdleTimer();
    this.manualClose = false;

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, this.protocol);
      let ackTimer = null;
      let settled = false;

      const cleanupPending = () => {
        if (ackTimer) clearTimeout(ackTimer);
        ackTimer = null;
      };

      socket.on('open', () => {
        this.socket = socket;
        this.connectionAcked = false;
        socket.send(JSON.stringify({
          type: 'connection_init',
          payload: this.connectionParams,
        }));
        ackTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.connectPromise = null;
          try {
            socket.close(4408, 'Connection acknowledgement timeout');
          } catch {
            // ignore
          }
          reject(new Error(`GraphQL WebSocket connection ack timeout for ${this.url}`));
        }, this.ackTimeoutMs);
      });

      socket.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        this.handleMessage(message);
        if (message?.type === 'connection_ack' && !settled) {
          settled = true;
          cleanupPending();
          this.connectionAcked = true;
          this.reconnectAttempt = 0;
          this.connectPromise = null;
          this.resubscribeActiveOperations();
          resolve(this);
        }
      });

      socket.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanupPending();
        this.connectPromise = null;
        reject(error);
      });

      socket.on('close', () => {
        cleanupPending();
        this.socket = null;
        this.connectionAcked = false;
        this.connectPromise = null;
        if (!this.manualClose && this.operations.size > 0) {
          this.scheduleReconnect();
        }
      });
    });

    return this.connectPromise;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.manualClose) return;
    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.reconnectDelayMs * (2 ** Math.min(this.reconnectAttempt, 5)),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        if (this.operations.size > 0) this.scheduleReconnect();
      });
    }, delay);
  }

  resubscribeActiveOperations() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.connectionAcked) return;
    for (const operation of this.operations.values()) {
      this.socket.send(JSON.stringify({
        id: operation.id,
        type: 'subscribe',
        payload: operation.payload,
      }));
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ping') {
      this.socket?.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    const id = message.id ? String(message.id) : '';
    if (!id || !this.operations.has(id)) return;
    const operation = this.operations.get(id);
    if (!operation) return;

    if (message.type === 'next') {
      operation.onNext?.(message.payload);
      return;
    }
    if (message.type === 'error') {
      const error = new Error(JSON.stringify(message.payload));
      operation.onError?.(error);
      operation.reject(error);
      this.operations.delete(id);
      this.scheduleIdleDisconnect();
      return;
    }
    if (message.type === 'complete') {
      operation.onComplete?.();
      operation.resolve();
      this.operations.delete(id);
      this.scheduleIdleDisconnect();
    }
  }

  async subscribe(payload, handlers = {}) {
    await this.connect();
    const id = randomUUID();
    const operation = {
      id,
      payload,
      onNext: handlers.onNext,
      onError: handlers.onError,
      onComplete: handlers.onComplete,
      resolve: null,
      reject: null,
    };
    const completed = new Promise((resolve, reject) => {
      operation.resolve = resolve;
      operation.reject = reject;
    });
    this.operations.set(id, operation);
    this.clearIdleTimer();
    this.socket.send(JSON.stringify({
      id,
      type: 'subscribe',
      payload,
    }));

    return {
      id,
      completed,
      unsubscribe: () => {
        if (!this.operations.has(id)) return;
        this.socket?.send(JSON.stringify({ id, type: 'complete' }));
        const current = this.operations.get(id);
        this.operations.delete(id);
        current?.resolve?.();
        this.scheduleIdleDisconnect();
      },
    };
  }

  scheduleIdleDisconnect() {
    if (this.lazyDisconnectMs <= 0 || this.operations.size > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.operations.size === 0) {
        this.close();
      }
    }, this.lazyDisconnectMs);
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  close() {
    this.manualClose = true;
    this.clearIdleTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      try {
        this.socket.close(1000, 'Client closed');
      } catch {
        // ignore
      }
    }
    this.socket = null;
    this.connectionAcked = false;
    this.connectPromise = null;
    for (const operation of this.operations.values()) {
      operation.resolve?.();
    }
    this.operations.clear();
  }
}

export function getGraphqlWebSocketClient(input = {}) {
  const url = resolveGraphqlWebSocketUrl(input);
  if (!CLIENTS.has(url)) {
    CLIENTS.set(url, new PersistentGraphqlWsClient({
      url,
      connectionParams: buildGraphqlConnectionParams(input),
      protocol: input.protocol,
      ackTimeoutMs: input.ackTimeoutMs,
      reconnectDelayMs: input.reconnectDelayMs,
      maxReconnectDelayMs: input.maxReconnectDelayMs,
      lazyDisconnectMs: input.lazyDisconnectMs,
    }));
  }
  return CLIENTS.get(url);
}

export async function subscribeGraphqlStream(input = {}) {
  const client = getGraphqlWebSocketClient(input);
  return client.subscribe({
    query: input.query,
    variables: input.variables || {},
    operationName: input.operationName,
  }, {
    onNext: input.onNext,
    onError: input.onError,
    onComplete: input.onComplete,
  });
}

export function closeGraphqlWebSocketClient(input = {}) {
  const url = resolveGraphqlWebSocketUrl(input);
  const client = CLIENTS.get(url);
  if (!client) return;
  client.close();
  CLIENTS.delete(url);
}

export function closeAllGraphqlWebSocketClients() {
  for (const client of CLIENTS.values()) client.close();
  CLIENTS.clear();
}
