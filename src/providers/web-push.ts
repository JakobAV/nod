import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Agent, request } from 'node:https';
import type { PushSender } from '../ports/push.ts';
import { isIP } from 'node:net';
import { isPublicAddress, publicLookup } from './agent-browser/network.ts';

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export function createWebPush(options: { privateKey: string; subject: string }): PushSender {
  const key = createPrivateKey(options.privateKey);
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  const publicKey = base64url(
    Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]),
  );
  const lookup = publicLookup();
  const agent = new Agent({ lookup });
  function token(audience: string) {
    const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = base64url(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: options.subject,
      }),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${header}.${claims}.${base64url(signature)}`;
  }
  return {
    publicKey,
    send(endpoint, ttl) {
      const url = new URL(endpoint);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        (isIP(host) > 0 && !isPublicAddress(host)) ||
        url.password ||
        (url.port && url.port !== '443')
      )
        return Promise.reject(new Error('Push endpoints must be public HTTPS addresses.'));
      return new Promise((resolve, reject) => {
        const sent = request(
          url,
          {
            method: 'POST',
            agent,
            lookup,
            timeout: 15_000,
            headers: {
              TTL: String(ttl),
              Urgency: 'normal',
              Topic: 'reply',
              'Content-Length': '0',
              Authorization: `vapid t=${token(url.origin)}, k=${publicKey}`,
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        sent.on('timeout', () =>
          sent.destroy(new Error('The push service did not answer in 15 seconds.')),
        );
        sent.on('error', reject);
        sent.end();
      });
    },
  };
}
