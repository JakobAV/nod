import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PushSender } from '../ports/push.ts';
import { dataRoot, ownerId } from './config.ts';
import { pool } from './db.ts';
import { events } from './events.ts';
import { logFailure } from './failure-log.ts';
import { getPreferences } from './triage.ts';
import { isQuietTime } from './preferences.ts';

const subscriptionSchema = z
  .object({ endpoint: z.string().url().max(2048).startsWith('https://') })
  .strict();

export async function pushPrivateKey() {
  const path = join(dataRoot, 'push-key.pem');
  const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) return existing;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const draft = `${path}.${randomUUID()}`;
  await writeFile(draft, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    flag: 'wx',
    mode: 0o600,
  });
  await link(draft, path)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    })
    .finally(() => rm(draft, { force: true }));
  return readFile(path, 'utf8');
}

function pushLifetime(preferences: Parameters<typeof isQuietTime>[0], now = Date.now()) {
  const day = 86400;
  const minute = 60000;
  const start = now - (now % minute);
  for (let time = start + minute; time < now + day * 1000; time += minute)
    if (isQuietTime(preferences, new Date(time))) return Math.floor((time - now) / 1000);
  return day;
}

export async function createPush(sender: PushSender) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      owner_id text NOT NULL, endpoint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,endpoint)
    )`);
  const latest = async () =>
    (
      await pool.query<{ id: string }>(
        `SELECT id FROM messages WHERE owner_id=$1 AND role='assistant'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [ownerId],
      )
    ).rows[0]?.id;
  let notified = await latest();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  async function check() {
    const newest = await latest();
    if (!newest || newest === notified) return;
    notified = newest;
    const preferences = await getPreferences();
    if (isQuietTime(preferences)) return;
    const ttl = pushLifetime(preferences);
    const { rows } = await pool.query<{ endpoint: string }>(
      'SELECT endpoint FROM push_subscriptions WHERE owner_id=$1',
      [ownerId],
    );
    await Promise.all(
      rows.map(async ({ endpoint }) => {
        const status = await sender.send(endpoint, ttl).catch((error: unknown) => {
          logFailure('push_send', error);
          return 0;
        });
        console.log(JSON.stringify({ event: 'push_send', status }));
        if (status === 404 || status === 410)
          await pool.query('DELETE FROM push_subscriptions WHERE owner_id=$1 AND endpoint=$2', [
            ownerId,
            endpoint,
          ]);
        else if (status && (status < 200 || status >= 300))
          logFailure('push_send', new Error(`The push service answered HTTP ${status}.`));
      }),
    );
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = running.then(check).catch((error: unknown) => logFailure('push_check', error));
    }, 1000);
  }
  events.on('event', (event) => {
    if (event.type === 'refresh') schedule();
  });
  setInterval(schedule, 60_000).unref();
  function registerRoutes(app: FastifyInstance) {
    app.get('/api/push', async () => ({ publicKey: sender.publicKey }));
    app.put('/api/push', async (request) => {
      const { endpoint } = subscriptionSchema.parse(request.body);
      await pool.query(
        'INSERT INTO push_subscriptions(owner_id,endpoint) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [ownerId, endpoint],
      );
      return { ok: true };
    });
    app.delete('/api/push', async (request) => {
      const { endpoint } = subscriptionSchema.parse(request.body);
      await pool.query('DELETE FROM push_subscriptions WHERE owner_id=$1 AND endpoint=$2', [
        ownerId,
        endpoint,
      ]);
      return { ok: true };
    });
  }
  return { registerRoutes };
}
