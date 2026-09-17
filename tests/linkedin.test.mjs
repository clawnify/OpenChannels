import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// LinkedIn is reply-only: threads start when the contact writes, and every
// reply is written by a person in the app. These run the real worker.

const org = 'linkedin-test-org';
const agent = { 'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'agent', 'Content-Type': 'application/json' };
const person = {
  'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'user', 'Content-Type': 'application/json',
  'X-Clawnify-User-Id': 'user-1', 'X-Clawnify-User-Name': 'Sam Reviewer',
};

let mf;
before(async () => {
  const script = (await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] })).outputFiles[0].text;
  const schema = await readFile('schema.sql', 'utf8');
  mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['UPLOADS'] });
  const db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
});
after(async () => { await mf?.dispose(); });

const call = async (path, headers, method = 'GET', body) => {
  const res = await mf.dispatchFetch('https://app.test' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const ingest = (handle, kind, text, externalId) => call('/api/ingest', agent, 'POST', {
  channel: 'linkedin', contact: { handle, name: 'Jane Doe' },
  message: { kind, body: text, externalId },
});

test('every spelling of a profile URL lands in one LinkedIn thread', async () => {
  const a = await ingest('linkedin.com/in/Jane-Doe/', 'inbound', 'Hi, saw your post', 'li-1');
  const b = await ingest('https://nl.linkedin.com/in/jane-doe?trk=abc', 'inbound', 'Are you around?', 'li-2');
  assert.equal(a.status, 200);
  assert.equal(b.body.conversationId, a.body.conversationId);
  const conv = await call(`/api/conversations/${a.body.conversationId}`, person);
  assert.equal(conv.body.contact.handle, 'https://www.linkedin.com/in/jane-doe');
  assert.equal(conv.body.channel, 'linkedin');
  // The contact wrote, so a reply is allowed — and the window never expires.
  assert.equal(conv.body.window.freeformAllowed, true);
  assert.equal(conv.body.window.expiresAt, null);
});

test('a person can reply in a thread the contact started, and it queues for the agent', async () => {
  const { body: { conversationId } } = await ingest('https://www.linkedin.com/in/reply-ok', 'inbound', 'Hello', 'li-3');
  const sent = await call(`/api/conversations/${conversationId}/reply`, person, 'POST', { body: 'Thanks, happy to talk' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'queued');
  assert.equal(sent.body.authorName, 'Sam Reviewer');

  const outbox = await call('/api/outbox', agent);
  const item = outbox.body.items.find((i) => i.message.id === sent.body.id);
  assert.ok(item, 'the reply is handed to the agent');
  assert.equal(item.channel, 'linkedin');
  assert.equal(item.contact.handle, 'https://www.linkedin.com/in/reply-ok');
  assert.equal(item.template, null);
});

test('the agent cannot author a LinkedIn reply', async () => {
  const { body: { conversationId } } = await ingest('https://www.linkedin.com/in/agent-no', 'inbound', 'Hello', 'li-4');
  const r = await call(`/api/conversations/${conversationId}/reply`, agent, 'POST', { body: 'Auto answer' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /written by a person/);
});

test('LinkedIn replies are text only', async () => {
  const { body: { conversationId } } = await ingest('https://www.linkedin.com/in/text-only', 'inbound', 'Hello', 'li-5');
  const r = await call(`/api/conversations/${conversationId}/reply`, person, 'POST', {
    body: 'See attached', attachment: { url: 'https://app.test/api/media/att/x.pdf' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /text only/);
});

test('no reply until the contact has written, even if our side already did', async () => {
  // Our account's own earlier message, mirrored as outbound, opens nothing.
  const { body: { conversationId } } = await ingest('https://www.linkedin.com/in/not-yet', 'outbound', 'Hi Jane', 'li-6');
  const conv = await call(`/api/conversations/${conversationId}`, person);
  assert.equal(conv.body.window.freeformAllowed, false);
  const r = await call(`/api/conversations/${conversationId}/reply`, person, 'POST', { body: 'Following up' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /hasn't written to you on LinkedIn/);

  // Once they answer, the same thread takes a reply.
  await ingest('https://www.linkedin.com/in/not-yet', 'inbound', 'Sure', 'li-7');
  const ok = await call(`/api/conversations/${conversationId}/reply`, person, 'POST', { body: 'Great' });
  assert.equal(ok.status, 201);
});

test('a LinkedIn conversation cannot be started from the app', async () => {
  const r = await call('/api/conversations', person, 'POST', {
    channel: 'linkedin', handle: 'https://www.linkedin.com/in/cold-lead',
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /can't be started here/);
});

test('other channels keep their rules: an agent may still queue a Telegram reply', async () => {
  const { body: { conversationId } } = await call('/api/ingest', agent, 'POST', {
    channel: 'telegram', contact: { handle: '@someone' },
    message: { kind: 'inbound', body: 'hey', externalId: 'tg-1' },
  });
  const r = await call(`/api/conversations/${conversationId}/reply`, agent, 'POST', { body: 'hi' });
  assert.equal(r.status, 201);
});
