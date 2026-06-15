import http from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';

function defaultRpcUrl() {
  return String(process.env.ORBITAL_DEVNET_RPC_URL || 'http://127.0.0.1:8114').trim();
}

async function rpcCall(rpcUrl, method, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const transport = String(rpcUrl).startsWith('https://') ? https : http;
    const req = transport.request(
      rpcUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw || '{}');
            if (parsed.error) {
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function createDevnetService(options = {}) {
  const rpcUrl = String(options.rpcUrl || defaultRpcUrl()).trim();
  const retryCount = Math.max(1, Number(options.retryCount || process.env.ORBITAL_DEVNET_RETRY_COUNT || 3));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || process.env.ORBITAL_DEVNET_RETRY_DELAY_MS || 250));

  return {
    getRpcUrl() {
      return rpcUrl;
    },
    async assertReachable(input = {}) {
      const attempts = Math.max(1, Number(input.retryCount || retryCount));
      const delayMs = Math.max(0, Number(input.retryDelayMs || retryDelayMs));
      let lastError = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await rpcCall(rpcUrl, 'get_tip_block_number', []);
          return {
            ok: true,
            rpcUrl,
            attempt,
            attempts,
          };
        } catch (error) {
          lastError = error;
          if (attempt < attempts && delayMs > 0) {
            // small backoff between transient reachability checks
            // keeps the route responsive while still smoothing startup/rpc blips
            // eslint-disable-next-line no-await-in-loop
            await sleep(delayMs);
          }
        }
      }

      throw lastError || new Error('Devnet reachability check failed.');
    },
  };
}
