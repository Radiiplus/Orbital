import http from 'node:http';
import https from 'node:https';

export async function postGraphql(url, query, variables, headers = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const transport = String(url).startsWith('https://') ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
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
