import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// "Needs reply" is the contact waiting on us. Reading the thread doesn't answer
// them and neither does a batch template; a person's reply or any freeform
// message does, unless it never went out. Threads written before the columns
// existed get the same answer from their history on the org's first request.

const org = 'reply-state-org';
let mf, db;
const headersFor = (who) => ({
  'X-Clawnify-Org-Id': org,
  'Content-Type': 'application/json',
  ...(who === 'person'
    ? { 'X-Clawnify-Caller': 'user', 'X-Clawnify-User-Id': 'u1', 'X-Clawnify-User-Name': 'Mill' }
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
  // A person answered with a template after the window shut.
  history('h5');
  msg('h5', 'inbound', '2026-09-04T10:00:00.000Z');
  msg('h5', 'outbound', '2026-09-05T10:00:00.000Z', { status: 'sent', template: 'reminder', user: 'u1' });
  await db.batch(rows);
});
after(async () => { await mf?.dispose(); });

test('existing history is read into the views on the first request', async () => {
  assert.deepEqual(await ids('needs_reply'), ['h3', 'h1'], 'waiting, newest message first');
  assert.deepEqual(await ids('replied'), ['h5', 'h3', 'h2', 'h1'], 'everyone who wrote, by when they wrote');
  assert.equal((await call('person', '/api/stats')).needsReply, 2);
});

test('reading or a batch template leaves a question waiting; a reply answers it until it fails', async () => {
  const { conversationId: id } = await call('agent', '/api/ingest', {
    channel: 'email', contact: { handle: 'guest@example.test' },
    message: { kind: 'inbound', body: 'Can I bring a friend?', externalId: 'in-1' },
  });
  let c = await thread(id);
  assert.equal(c.needsReply, true);
  assert.equal(c.unread, 1);
  assert.ok(c.lastInboundAt);
  assert.ok((await ids('unread')).includes(id));

  await call('app', `/api/conversations/${id}/reply`, {
    template: { name: 'reminder', language: 'en', variables: {} },
  });
  c = await thread(id);
  assert.equal(c.needsReply, true, 'a batch reminder is not an answer');
  assert.equal(c.unread, 1, 'nor is it anyone reading the thread');

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
  assert.equal((await call('person', '/api/stats')).needsReply, 3);
});
