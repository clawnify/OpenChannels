import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// "Needs reply" is the contact waiting on us. Reading the thread doesn't answer
// them, and neither does a template, whoever sends it; a freeform reply that
// goes out does. A reaction counts as hearing from them, never as a question.
// Threads written before the columns existed get the same answer from their
// history on the org's first request.

const org = 'reply-state-org';
let mf, db;
const PERSON = { 'X-Clawnify-User-Id': 'u1', 'X-Clawnify-User-Name': 'Mill' };
const headersFor = (who) => ({
  'X-Clawnify-Org-Id': org,
  'Content-Type': 'application/json',
  // `person` is someone in the inbox itself; `claude` is the same person
  // calling the API from outside it, the way a scripted batch arrives.
  ...(who === 'person' ? { 'X-Clawnify-Caller': 'user', ...PERSON }
    : who === 'claude' ? { 'X-Clawnify-Caller': 'api', ...PERSON }
    : { 'X-Clawnify-Caller': who }),
});
const call = async (who, path, body, method = body === undefined ? 'GET' : 'POST') => {
  const res = await mf.dispatchFetch(`https://app.test${path}`, {
    method, headers: headersFor(who), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(res.ok, `${method} ${path} → ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const ids = async (only) =>
  (await call('person', `/api/conversations?only=${only}&limit=100`)).items.map((c) => c.id);
const thread = (id) => call('person', `/api/conversations/${id}`);
const ingest = (channel, handle, message) =>
  call('agent', '/api/ingest', { channel, contact: { handle }, message });

before(async () => {
  const script = (await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] })).outputFiles[0].text;
  const schema = await readFile('schema.sql', 'utf8');
  mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));

  const T = '2026-09-01T08:00:00.000Z';
  const rows = [db.prepare(
    `INSERT INTO templates (id,org_id,channel,name,language,category,status,body_text,variables,components,synced_at)
     VALUES ('t1',?,'email','reminder','en','MARKETING','APPROVED','See you Thursday!','[]','[]',?)`).bind(org, T)];
  const history = (id) => {
    rows.push(db.prepare(`INSERT INTO contacts (id,org_id,channel,handle,created_at) VALUES (?,?,?,?,?)`)
      .bind(id, org, 'email', `${id}@example.test`, T));
    rows.push(db.prepare(`INSERT INTO conversations (id,org_id,contact_id,channel,last_message_at,created_at) VALUES (?,?,?,?,?,?)`)
      .bind(id, org, id, 'email', T, T));
  };
  const msg = (conv, kind, at, extra = {}) => rows.push(db.prepare(
    `INSERT INTO messages (id,org_id,conversation_id,kind,body,status,user_id,template_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), org, conv, kind, 'body', extra.status ?? null, extra.user ?? null,
      extra.template ?? null, at));

  // Asked, then a batch reminder went out: still waiting.
  history('h1');
  msg('h1', 'inbound', '2026-09-01T10:00:00.000Z');
  msg('h1', 'outbound', '2026-09-02T10:00:00.000Z', { status: 'sent', template: 'reminder' });
  // Answered in freeform by the agent.
  history('h2');
  msg('h2', 'inbound', '2026-09-02T10:00:00.000Z');
  msg('h2', 'outbound', '2026-09-03T10:00:00.000Z', { status: 'sent' });
  // Answered, but the answer failed: still waiting.
  history('h3');
  msg('h3', 'inbound', '2026-09-03T10:00:00.000Z');
  msg('h3', 'outbound', '2026-09-04T10:00:00.000Z', { status: 'failed', user: 'u1' });
  // Only ever sent to; never wrote back.
  history('h4');
  msg('h4', 'outbound', '2026-09-01T10:00:00.000Z', { status: 'sent', template: 'reminder' });
  // A template carrying a person's id, as a batch run from outside the inbox
  // does, answers nothing either.
  history('h5');
  msg('h5', 'inbound', '2026-09-04T10:00:00.000Z');
  msg('h5', 'outbound', '2026-09-05T10:00:00.000Z', { status: 'sent', template: 'reminder', user: 'u1' });
  // Reacted to a batch message: heard from, nothing to answer.
  history('h6');
  msg('h6', 'outbound', '2026-09-01T10:00:00.000Z', { status: 'sent', template: 'reminder' });
  msg('h6', 'reaction', '2026-09-06T10:00:00.000Z');
  await db.batch(rows);
});
after(async () => { await mf?.dispose(); });

test('existing history is read into the views on the first request', async () => {
  assert.deepEqual(await ids('needs_reply'), ['h5', 'h3', 'h1'], 'waiting, newest message first');
  assert.deepEqual(await ids('replied'), ['h6', 'h5', 'h3', 'h2', 'h1'], 'everyone heard from, by when');
  assert.equal((await call('person', '/api/stats')).needsReply, 3);
});

test('reading or a template leaves a question waiting; a reply answers it until it fails', async () => {
  const { conversationId: id } = await ingest('email', 'guest@example.test',
    { kind: 'inbound', body: 'Can I bring a friend?', externalId: 'in-1' });
  let c = await thread(id);
  assert.equal(c.needsReply, true);
  assert.equal(c.unread, 1);
  assert.ok(c.lastInboundAt);
  assert.ok((await ids('unread')).includes(id));

  const reminder = { template: { name: 'reminder', language: 'en', variables: {} } };
  await call('app', `/api/conversations/${id}/reply`, reminder);
  await call('claude', `/api/conversations/${id}/reply`, reminder);
  c = await thread(id);
  assert.equal(c.needsReply, true, 'a template is not an answer, whoever sends it');
  assert.equal(c.unread, 1, 'nor is a send from outside the inbox anyone reading the thread');

  await call('person', `/api/conversations/${id}`, { unread: 0 }, 'PATCH');
  c = await thread(id);
  assert.equal(c.unread, 0);
  assert.equal(c.needsReply, true, 'reading is not answering');

  const reply = await call('person', `/api/conversations/${id}/reply`, { body: 'Of course!' });
  c = await thread(id);
  assert.equal(c.needsReply, false);
  assert.ok(!(await ids('needs_reply')).includes(id));

  await call('agent', `/api/messages/${reply.id}/status`, { status: 'failed', error: 'bounced' });
  assert.equal((await thread(id)).needsReply, true, 'a reply that never went out answers nobody');

  const retry = await call('person', `/api/conversations/${id}/reply`, { body: 'Of course, see you there!' });
  assert.equal((await thread(id)).needsReply, false);
  await call('person', `/api/messages/${retry.id}`, undefined, 'DELETE');
  assert.equal((await thread(id)).needsReply, true, 'a discarded draft answers nobody');
  assert.equal((await call('person', '/api/stats')).needsReply, 4);
});

test('a reaction is hearing from them, not a question, and leaves the thread where it was', async () => {
  const handle = '+31600000009';
  const { conversationId: id } = await ingest('whatsapp', handle,
    { kind: 'outbound', body: "YOU'RE IN! See you Thursday.", externalId: 'out-1' });
  await call('person', `/api/conversations/${id}`, { status: 'closed' }, 'PATCH');
  const before = await thread(id);

  await ingest('whatsapp', handle, { kind: 'reaction', body: '❤️', externalId: 'r-1' });
  // The shape flows sent before kind=reaction existed.
  await ingest('whatsapp', handle,
    { kind: 'inbound', body: '👍', externalId: 'r-2', media: { ref: '', type: 'reaction' } });
  const removed = await ingest('whatsapp', handle, { kind: 'reaction', body: '', externalId: 'r-3' });
  assert.equal(removed.messageId, null, 'a removed reaction is dropped');

  const c = await thread(id);
  assert.equal(c.needsReply, false, 'nothing to answer');
  assert.equal(c.unread, 0, 'nobody needs to look');
  assert.equal(c.status, 'closed', 'a closed thread stays closed');
  assert.equal(c.lastMessagePreview, before.lastMessagePreview, 'the thread does not move up the list');
  assert.ok(c.lastInboundAt, 'but we heard from them');
  assert.ok(c.window.freeformAllowed, 'and the reply window opens as it always did');
  const { items } = await call('person', `/api/conversations/${id}/messages`);
  assert.deepEqual(items.map((m) => m.kind), ['outbound', 'reaction', 'reaction']);

  await call('person', `/api/conversations/${id}`, { status: 'open' }, 'PATCH');
  assert.ok((await ids('replied')).includes(id));
  assert.ok(!(await ids('needs_reply')).includes(id));

  await ingest('whatsapp', handle, { kind: 'inbound', body: 'Can I come at 8 instead?', externalId: 'in-9' });
  assert.equal((await thread(id)).needsReply, true, 'a real question still lands');
});
