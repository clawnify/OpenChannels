import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// WhatsApp does not deliver marketing templates to US numbers. The sender
// refuses those before anything leaves, re-reading the category from Meta
// first, and leaves every other +1 country alone.

const org = 'us-marketing-org';
const PHONE = '555000222';
let mf, db, calls, meta;

const headers = { 'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'system', 'Content-Type': 'application/json' };
const post = (path, body) =>
  mf.dispatchFetch(`https://app.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
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
        return Response.json({ data: [{ id: PHONE, display_phone_number: '+31 6 1234 5678', platform_type: 'CLOUD_API' }] });
      }
      const edge = url.pathname.split('/').pop();
      calls.push({ method: req.method, edge });
      return meta(req.method, edge);
    },
  });
  db = await mf.getD1Database('DB');
  const schema = await readFile('schema.sql', 'utf8');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
});
after(async () => mf?.dispose());
beforeEach(() => { calls = []; });

let n = 0;
async function setup(category, handle) {
  n += 1;
  const name = `event_${n}`;
  await db.prepare(`INSERT INTO templates (id, org_id, channel, name, language, category, status, external_id, synced_at)
    VALUES (?, ?, 'whatsapp', ?, 'en_US', ?, 'APPROVED', ?, '2026-10-01T00:00:00Z')`)
    .bind(`tpl-us-${n}`, org, name, category, `7700${n}`).run();
  const res = await post('/api/conversations', { channel: 'whatsapp', handle });
  assert.equal(res.status, 200, await res.clone().text());
  calls = [];
  return { convId: (await res.json()).id, name, templateId: `tpl-us-${n}` };
}

const send = async ({ convId, name }) => {
  const res = await post(`/api/conversations/${convId}/reply`, { template: { name, language: 'en_US', variables: {} } });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
};
const sends = () => calls.filter(c => c.method === 'POST').map(c => c.edge);
const storedCategory = async (id) =>
  (await db.prepare('SELECT category FROM templates WHERE id = ?').bind(id).first()).category;
const metaSays = (category) => (method, edge) =>
  method === 'GET' ? Response.json({ id: edge, category }) : accepted(`wamid.${edge}`);

test('a MARKETING template to a US number is refused before it is sent', async () => {
  const t = await setup('MARKETING', '+12125551234');
  meta = metaSays('MARKETING');
  const msg = await send(t);
  assert.equal(msg.status, 'failed');
  assert.match(msg.error, /does not deliver marketing templates to US numbers/);
  assert.deepEqual(sends(), []);
});

test('a stale MARKETING that Meta now holds as UTILITY goes out to a US number, and the row is corrected', async () => {
  const t = await setup('MARKETING', '+13105550199');
  meta = metaSays('UTILITY');
  const msg = await send(t);
  assert.equal(msg.status, 'accepted');
  assert.deepEqual(sends(), ['messages']);
  assert.equal(await storedCategory(t.templateId), 'UTILITY');
});

test('a UTILITY template to a US number is sent without asking Meta', async () => {
  const t = await setup('UTILITY', '+19295550123');
  meta = metaSays('UTILITY');
  const msg = await send(t);
  assert.equal(msg.status, 'accepted');
  assert.deepEqual(sends(), ['messages']);
  assert.equal(calls.filter(c => c.method === 'GET').length, 0);
});

for (const [where, handle] of [['a Canadian', '+14165550123'], ['a Puerto Rican', '+17875550123'], ['an unplaceable', '+15551230001']]) {
  test(`a MARKETING template to ${where} +1 number is sent as before`, async () => {
    const t = await setup('MARKETING', handle);
    meta = metaSays('MARKETING');
    const msg = await send(t);
    assert.equal(msg.status, 'accepted');
    assert.deepEqual(sends(), ['marketing_messages']);
  });
}
