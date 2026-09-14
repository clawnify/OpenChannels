import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
const org = 'media-test-org';
let mf, db;
const headers = { 'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'system' };
const request = (path, body) => mf.dispatchFetch(`https://app.test${path}`, {
  headers: { ...headers, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
});
const ingest = async (ref, externalId = crypto.randomUUID()) => {
  const res = await request('/api/ingest', {
    channel: 'email', contact: { handle: 'media-test@example.test' },
    message: { body: '', externalId, media: { ref, type: 'image' } },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};

before(async () => {
  const bundle = await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] });
  mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['UPLOADS'],
    bindings: { 'WHATSAPP-BUSINESS_BEARER_TOKEN': 'test-token', WHATSAPP_BUSINESS_WABA_ID: '12345' },
    outboundService: (req) => {
      const url = new URL(req.url);
      if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/67890')) {
        assert.equal(req.headers.get('authorization'), 'Bearer test-token');
        return Response.json({ url: 'https://provider.test/meta.png', mime_type: 'image/png' });
      }
      if (url.pathname === '/meta.png') assert.equal(req.headers.get('authorization'), 'Bearer test-token');
      return ['/image.png', '/meta.png'].includes(url.pathname)
        ? new Response(png, { headers: { 'Content-Type': 'image/png' } })
        : new Response('unavailable', { status: 503 });
    },
  });
  db = await mf.getD1Database('DB');
  const schema = await readFile('schema.sql', 'utf8');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
});
after(async () => mf?.dispose());

test('captionless incoming image stores bytes and serves the nested storage key', async () => {
  const input = await ingest('https://provider.test/image.png');
  const msg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(input.messageId).first();
  assert.equal(msg.media_key, `media/${org}/${input.messageId}`);
  assert.equal(msg.media_mime, 'image/png');
  const res = await mf.dispatchFetch(`https://app.test/api/media/${msg.media_key}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-security-policy'), 'sandbox');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
});

test('duplicate delivery does not insert a second message', async () => {
  const id = crypto.randomUUID();
  const first = await ingest('https://provider.test/image.png', id);
  const duplicate = await ingest('https://provider.test/image.png', id);
  assert.equal(duplicate.messageId, first.messageId);
  assert.equal(duplicate.duplicate, true);
});

test('failed download keeps the message and original reference', async () => {
  const input = await ingest('https://provider.test/unavailable');
  const msg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(input.messageId).first();
  assert.equal(msg.media_ref, 'https://provider.test/unavailable');
  assert.equal(msg.media_key, null);
});

test('uploaded file round trips and may be queued without a caption', async () => {
  const res = await mf.dispatchFetch('https://app.test/api/uploads?filename=test.png', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(res.status, 201, await res.clone().text());
  const upload = await res.json();
  const image = await mf.dispatchFetch(upload.url);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const { conversationId } = await ingest('https://provider.test/image.png');
  const sent = await request(`/api/conversations/${conversationId}/reply`, { attachment: { url: upload.url } });
  assert.equal(sent.status, 201, await sent.clone().text());
  assert.equal((await sent.json()).mediaKey, upload.key);
  const foreign = await request(`/api/conversations/${conversationId}/reply`, {
    attachment: { url: upload.url.replace('app.test', 'foreign.test') },
  });
  assert.equal(foreign.status, 400);
});

test('template-only replies reach template validation rather than failing as empty', async () => {
  const { conversationId } = await ingest('https://provider.test/image.png');
  const res = await request(`/api/conversations/${conversationId}/reply`, {
    template: { name: 'not_synced', language: 'en', variables: {} },
  });
  assert.equal(res.status, 422, await res.clone().text());
});

test('unrelated bucket prefixes are not public', async () => {
  const res = await mf.dispatchFetch('https://app.test/api/media/private/secret');
  assert.equal(res.status, 404);
});


test('WhatsApp media ID resolves with the connection token and stores the authenticated download', async () => {
  const input = await ingest('whatsapp-media:67890');
  const msg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(input.messageId).first();
  assert.equal(msg.media_key, `media/${org}/${input.messageId}`);
  assert.equal(msg.media_mime, 'image/png');
});
