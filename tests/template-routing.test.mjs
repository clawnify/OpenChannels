import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Which endpoint a WhatsApp template leaves on: MARKETING on the Marketing
// Messages API, everything else on /messages, and what happens when Meta
// disagrees with the category we stored.

const org = 'routing-test-org';
const PHONE = '555000111';
let mf, db, calls, meta;

const headers = { 'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'system', 'Content-Type': 'application/json' };
const post = (path, body) =>
  mf.dispatchFetch(`https://app.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

const refusal = (code) =>
  Response.json({ error: { message: 'refused', type: 'OAuthException', code } }, { status: 400 });
const accepted = (id) => Response.json({ messaging_product: 'whatsapp', messages: [{ id: `${id}.${crypto.randomUUID()}` }] });

before(async () => {
  const bundle = await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] });
  mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['UPLOADS'],
    bindings: { 'WHATSAPP-BUSINESS_BEARER_TOKEN': 'test-token', WHATSAPP_BUSINESS_WABA_ID: '12345' },
    outboundService: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/12345/phone_numbers')) {
        return Response.json({ data: [{ id: PHONE, display_phone_number: '+1 555 000 111', platform_type: 'CLOUD_API' }] });
      }
      const edge = url.pathname.split('/').pop();
      calls.push({ method: req.method, edge, query: url.search });
      return meta(req.method, edge, url);
    },
  });
  db = await mf.getD1Database('DB');
  const schema = await readFile('schema.sql', 'utf8');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
});
after(async () => mf?.dispose());
beforeEach(() => { calls = []; });

let n = 0;
/** A thread with a contact plus one approved template stored under `category`. */
async function setup(category) {
  n += 1;
  const name = `promo_${n}`;
  await db.prepare(`INSERT INTO templates (id, org_id, channel, name, language, category, status, external_id, synced_at)
    VALUES (?, ?, 'whatsapp', ?, 'en_US', ?, 'APPROVED', ?, '2026-10-01T00:00:00Z')`)
    .bind(`tpl-${n}`, org, name, category, `9900${n}`).run();
  const res = await post('/api/conversations', { channel: 'whatsapp', handle: `+1555123000${n}` });
  assert.equal(res.status, 200, await res.clone().text());
  const conv = await res.json();
  calls = [];
  return { convId: conv.id, name, templateId: `tpl-${n}` };
}

const send = ({ convId, name }) =>
  post(`/api/conversations/${convId}/reply`, { template: { name, language: 'en_US', variables: {} } });
const sends = () => calls.filter(c => c.method === 'POST').map(c => c.edge);
const storedCategory = async (id) =>
  (await db.prepare('SELECT category FROM templates WHERE id = ?').bind(id).first()).category;

test('a MARKETING template goes to the Marketing Messages API', async () => {
  const t = await setup('MARKETING');
  meta = (method, edge) => (edge === 'marketing_messages' ? accepted('wamid.mm') : refusal(100));
  const res = await send(t);
  assert.equal(res.status, 201, await res.clone().text());
  const msg = await res.json();
  assert.equal(msg.status, 'accepted');
  assert.deepEqual(sends(), ['marketing_messages']);
});

test('a UTILITY template stays on /messages', async () => {
  const t = await setup('UTILITY');
  meta = (method, edge) => (edge === 'messages' ? accepted('wamid.cloud') : refusal(100));
  const msg = await (await send(t)).json();
  assert.equal(msg.status, 'accepted');
  assert.deepEqual(sends(), ['messages']);
});

test('a template Meta reclassified to MARKETING is re-read, resent there, and its category stored', async () => {
  const t = await setup('UTILITY');
  meta = (method, edge) => {
    if (method === 'GET') return Response.json({ id: edge, category: 'MARKETING' });
    return edge === 'marketing_messages' ? accepted('wamid.mm') : refusal(131000);
  };
  const msg = await (await send(t)).json();
  assert.equal(msg.status, 'accepted');
  assert.deepEqual(sends(), ['messages', 'marketing_messages']);
  assert.equal(await storedCategory(t.templateId), 'MARKETING');
});

test('a MARKETING template moved to UTILITY is resent on /messages', async () => {
  const t = await setup('MARKETING');
  meta = (method, edge) => {
    if (method === 'GET') return Response.json({ id: edge, category: 'UTILITY' });
    return edge === 'messages' ? accepted('wamid.cloud') : refusal(131055);
  };
  const msg = await (await send(t)).json();
  assert.equal(msg.status, 'accepted');
  assert.deepEqual(sends(), ['marketing_messages', 'messages']);
  assert.equal(await storedCategory(t.templateId), 'UTILITY');
});

test('an account not on the Marketing Messages API falls back to /messages', async () => {
  const t = await setup('MARKETING');
  meta = (method, edge) => {
    if (method === 'GET') return Response.json({ id: edge, category: 'MARKETING' });
    return edge === 'messages' ? accepted('wamid.cloud') : refusal(134102);
  };
  const msg = await (await send(t)).json();
  assert.equal(msg.status, 'accepted');
  assert.deepEqual(sends(), ['marketing_messages', 'messages']);
  assert.equal(await storedCategory(t.templateId), 'MARKETING');
});

test('when the fallback fails too, the thread shows the Marketing Messages API reason', async () => {
  const t = await setup('MARKETING');
  meta = (method, edge) => {
    if (method === 'GET') return Response.json({ id: edge, category: 'MARKETING' });
    return refusal(edge === 'marketing_messages' ? 134102 : 131049);
  };
  const msg = await (await send(t)).json();
  assert.equal(msg.status, 'failed');
  assert.match(msg.error, /134102/);
});

test('a send that may have gone out (5xx) is never repeated', async () => {
  const t = await setup('MARKETING');
  meta = () => new Response('upstream unavailable', { status: 503 });
  const msg = await (await send(t)).json();
  assert.equal(msg.status, 'failed');
  assert.deepEqual(sends(), ['marketing_messages']);
  assert.equal(calls.filter(c => c.method === 'GET').length, 0);
});
