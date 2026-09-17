import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// LinkedIn daily limits: over a rolling 24 hours, an org's LinkedIn account
// sends at most N messages and M opening messages. Items past a limit stay
// queued and are held back from the outbox. Real worker, small limits.

const person = (org) => ({
  'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'user', 'Content-Type': 'application/json',
  'X-Clawnify-User-Id': 'user-1', 'X-Clawnify-User-Name': 'Sam Reviewer',
});
const agent = (org) => ({ 'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'agent', 'Content-Type': 'application/json' });

let mf;
before(async () => {
  const script = (await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] })).outputFiles[0].text;
  const schema = await readFile('schema.sql', 'utf8');
  mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['UPLOADS'],
    bindings: { LINKEDIN_DAILY_MESSAGES: '3', LINKEDIN_DAILY_OPENERS: '1' } });
  const db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').filter((s) => s.trim()).map((s) => db.prepare(s)));
});
after(async () => { await mf?.dispose(); });

const call = async (path, headers, method = 'GET', body) => {
  const res = await mf.dispatchFetch('https://app.test' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const ingest = (org, slug, kind, text, externalId, at) => call('/api/ingest', agent(org), 'POST', {
  channel: 'linkedin', contact: { handle: `https://www.linkedin.com/in/${slug}` },
  message: { kind, body: text, externalId, ...(at ? { at } : {}) },
});
const linkedinOutbox = async (org) =>
  (await call('/api/outbox', agent(org))).body.items.filter((i) => i.channel === 'linkedin');
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test('messages past the daily limit stay queued and are held back', async () => {
  const org = 'limits-messages';
  // Two sends in the last day count; one from two days ago does not.
  await ingest(org, 'a', 'inbound', 'hi', 'm-a1', hoursAgo(50));
  await ingest(org, 'a', 'outbound', 'old reply', 'm-a2', hoursAgo(48));
  await ingest(org, 'a', 'outbound', 'reply 1', 'm-a3', hoursAgo(5));
  await ingest(org, 'a', 'outbound', 'reply 2', 'm-a4', hoursAgo(1));
  const { body: { conversationId } } = await ingest(org, 'b', 'inbound', 'hello', 'm-b1');

  const first = await call(`/api/conversations/${conversationId}/reply`, person(org), 'POST', { body: 'one' });
  const second = await call(`/api/conversations/${conversationId}/reply`, person(org), 'POST', { body: 'two' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  // Limit 3, two already sent: exactly one is handed out, the oldest.
  const out = await linkedinOutbox(org);
  assert.deepEqual(out.map((i) => i.message.id), [first.body.id]);

  // Once it is confirmed sent, the day is full and nothing more comes out.
  assert.equal((await call(`/api/messages/${first.body.id}/status`, agent(org), 'POST', { status: 'sent' })).status, 200);
  assert.deepEqual(await linkedinOutbox(org), []);

  // The held message is still queued, not failed.
  const msgs = (await call(`/api/conversations/${conversationId}/messages`, person(org))).body;
  const held = (msgs.messages ?? msgs.items ?? msgs).find((m) => m.id === second.body.id);
  assert.equal(held.status, 'queued');
});

test('opening messages have their own, smaller limit', async () => {
  const org = 'limits-openers';
  const open = async (slug) => (await call('/api/conversations', person(org), 'POST', {
    channel: 'linkedin', handle: `https://www.linkedin.com/in/${slug}`,
  })).body.id;
  const c1 = await open('first-lead');
  const c2 = await open('second-lead');
  const o1 = await call(`/api/conversations/${c1}/reply`, person(org), 'POST', { body: 'Hi first' });
  const o2 = await call(`/api/conversations/${c2}/reply`, person(org), 'POST', { body: 'Hi second' });
  // A reply in a thread the contact started is not an opener.
  const { body: { conversationId: c3 } } = await ingest(org, 'wrote-first', 'inbound', 'hey', 'o-c3');
  const r3 = await call(`/api/conversations/${c3}/reply`, person(org), 'POST', { body: 'hey back' });

  // Opener limit 1: one opener goes, the second waits; the reply still goes.
  const out = (await linkedinOutbox(org)).map((i) => i.message.id);
  assert.deepEqual(out, [o1.body.id, r3.body.id]);
  assert.ok(!out.includes(o2.body.id));

  await call(`/api/messages/${o1.body.id}/status`, agent(org), 'POST', { status: 'sent' });
  const after = (await linkedinOutbox(org)).map((i) => i.message.id);
  assert.ok(!after.includes(o2.body.id), 'the second opener waits for the rolling day');
});

test('failed sends do not use up the day', async () => {
  const org = 'limits-failed';
  const { body: { conversationId } } = await ingest(org, 'c', 'inbound', 'hello', 'f-c1');
  const ids = [];
  for (const text of ['a', 'b', 'c']) {
    ids.push((await call(`/api/conversations/${conversationId}/reply`, person(org), 'POST', { body: text })).body.id);
  }
  for (const id of ids) {
    await call(`/api/messages/${id}/status`, agent(org), 'POST', { status: 'failed', error: 'LinkedIn asked to sign in' });
  }
  const next = await call(`/api/conversations/${conversationId}/reply`, person(org), 'POST', { body: 'd' });
  assert.deepEqual((await linkedinOutbox(org)).map((i) => i.message.id), [next.body.id]);
});

test('other channels are not limited', async () => {
  const org = 'limits-other';
  const { body: { conversationId } } = await call('/api/ingest', agent(org), 'POST', {
    channel: 'telegram', contact: { handle: '@someone' }, message: { kind: 'inbound', body: 'hey', externalId: 'tg-l1' },
  });
  for (let i = 0; i < 5; i++) {
    await call(`/api/conversations/${conversationId}/reply`, agent(org), 'POST', { body: `m${i}` });
  }
  const items = (await call('/api/outbox', agent(org))).body.items;
  assert.equal(items.filter((i) => i.channel === 'telegram').length, 5);
});
