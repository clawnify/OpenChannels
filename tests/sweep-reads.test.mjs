import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// The two reads an automation makes before it sends: what already went out
// (sent-templates) and which numbers are failing (the conversation list). Both
// must answer from one list, so a sweep never has to open thread after thread.

let mf, db;
const headers = { 'X-Clawnify-Org-Id': 'test-org', 'X-Clawnify-Caller': 'user' };
before(async () => {
  const script = (await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] })).outputFiles[0].text;
  const schema = await readFile('schema.sql', 'utf8');
  mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));

  const T = '2026-09-01T10:00:00.000Z';
  const rows = [];
  const thread = (n, handle) => {
    rows.push(db.prepare(`INSERT INTO contacts (id,org_id,channel,handle,created_at) VALUES (?,?,?,?,?)`)
      .bind(`c${n}`, 'test-org', 'whatsapp', handle, T));
    rows.push(db.prepare(`INSERT INTO conversations (id,org_id,contact_id,channel,last_message_at,created_at) VALUES (?,?,?,?,?,?)`)
      .bind(`v${n}`, 'test-org', `c${n}`, 'whatsapp', T, T));
  };
  const msg = (id, conv, kind, at, extra = {}) => rows.push(db.prepare(
    `INSERT INTO messages (id,org_id,conversation_id,kind,body,status,error,template_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, 'test-org', conv, kind, extra.body ?? `body ${id}`, extra.status ?? null, extra.error ?? null,
      extra.template ?? null, at));

  // Dead number: the last thing in the thread is a template the provider refused.
  thread(1, '+31600000001');
  msg('m1', 'v1', 'outbound', '2026-09-02T10:00:00.000Z',
    { status: 'undelivered', error: 'Message undeliverable', template: 'reminder' });
  // Refused, then they wrote in: not failing any more.
  thread(2, '+31600000002');
  msg('m2', 'v2', 'outbound', '2026-09-02T10:00:00.000Z', { status: 'undelivered', error: 'x', template: 'reminder' });
  msg('m3', 'v2', 'inbound', '2026-09-03T10:00:00.000Z');
  // A note written after the failure must not hide it.
  thread(3, '+31600000003');
  msg('m4', 'v3', 'outbound', '2026-09-02T10:00:00.000Z', { status: 'failed', error: 'throttled' });
  msg('m5', 'v3', 'comment', '2026-09-04T10:00:00.000Z');
  // Three sends in the same millisecond, to prove paging is stable.
  for (const id of ['s1', 's2', 's3'])
    msg(id, 'v2', 'outbound', '2026-09-05T10:00:00.000Z', { status: 'sent', template: 'relay', body: `about ${id}` });
  await db.batch(rows);
});
after(async () => { await mf?.dispose(); });

const get = async (path) => {
  const res = await mf.dispatchFetch('https://app.test' + path, { headers });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};

test('the conversation list says when and why a number is failing', async () => {
  const { items } = await get('/api/conversations?channel=whatsapp&status=all&limit=100');
  const by = Object.fromEntries(items.map(i => [i.contact.handle, i]));
  assert.deepEqual(by['+31600000001'].lastFailure, { at: '2026-09-02T10:00:00.000Z', error: 'Message undeliverable' });
  assert.equal(by['+31600000001'].undelivered, true);
  assert.equal(by['+31600000002'].lastFailure, null);
  assert.equal(by['+31600000002'].undelivered, false);
  assert.deepEqual(by['+31600000003'].lastFailure, { at: '2026-09-02T10:00:00.000Z', error: 'throttled' });
});

test('sent-templates carries the text as sent, and pages without skipping a row', async () => {
  const pages = [];
  for (let offset = 0; ; offset += 2) {
    const { items } = await get(`/api/sent-templates?channel=whatsapp&limit=2&offset=${offset}`);
    pages.push(...items);
    if (items.length < 2) break;
  }
  // m1, m2 (undelivered still counts as sent), s1-s3; m4 never left (failed).
  assert.equal(pages.length, 5);
  assert.deepEqual(new Set(pages.map(i => i.body)).size, 5);
  assert.ok(pages.some(i => i.body === 'about s2' && i.templateName === 'relay'));
});
