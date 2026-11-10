import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// SMS through the org's Twilio connection: replies go out from the app, and
// Twilio's webhooks reach the app directly, trusted only on a valid signature.

const org = 'sms-test-org';
const SID = 'AC' + 'a'.repeat(32);
const AUTH = 'test-auth-token';
const US_NUMBER = 'PN' + '1'.repeat(32);
const NL_NUMBER = 'PN' + '2'.repeat(32);
const ORIGIN = 'https://app.test';

let bundle, mf, db, calls, numbers;

const headers = { 'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'system', 'Content-Type': 'application/json' };
const post = (path, body, instance = mf) =>
  instance.dispatchFetch(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

/** Twilio's signature: HMAC-SHA1 of the URL plus sorted name+value pairs. */
const sign = (url, fields, token = AUTH) =>
  createHmac('sha1', token)
    .update(url + Object.keys(fields).sort().map((k) => k + fields[k]).join(''))
    .digest('base64');

const webhook = (path, fields, { signature, instance = mf } = {}) => {
  const url = `${ORIGIN}${path}`;
  return instance.dispatchFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature ?? sign(url, fields),
    },
    body: new URLSearchParams(fields).toString(),
  });
};

const twilio = async (req) => {
  const url = new URL(req.url);
  const body = req.method === 'POST' ? Object.fromEntries(new URLSearchParams(await req.text())) : null;
  calls.push({ method: req.method, path: url.pathname, body, auth: req.headers.get('authorization') });
  if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) {
    return Response.json({ incoming_phone_numbers: numbers });
  }
  if (url.pathname.endsWith('/Messages.json')) {
    return Response.json({ sid: `SM${crypto.randomUUID().replace(/-/g, '')}`, status: 'queued' }, { status: 201 });
  }
  if (/\/IncomingPhoneNumbers\/PN\w+\.json$/.test(url.pathname)) return Response.json({ sid: 'ok' });
  return new Response('not found', { status: 404 });
};

const instance = (bindings) =>
  new Miniflare({ modules: true, script: bundle,
    compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['UPLOADS'], bindings, outboundService: twilio });

before(async () => {
  const out = await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] });
  bundle = out.outputFiles[0].text;
  mf = instance({ TWILIO_BEARER_TOKEN: `${SID}:${AUTH}`, CLAWNIFY_ORG_ID: org });
  db = await mf.getD1Database('DB');
  const schema = await readFile('schema.sql', 'utf8');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
});
after(async () => mf?.dispose());
beforeEach(() => {
  calls = [];
  numbers = [
    { sid: US_NUMBER, phone_number: '+16465550100', friendly_name: 'NY', capabilities: { sms: true }, sms_url: '' },
    { sid: NL_NUMBER, phone_number: '+3197010250000', friendly_name: 'NL', capabilities: { sms: true }, sms_url: '' },
  ];
});

async function thread(handle) {
  const res = await post('/api/conversations', { channel: 'sms', handle });
  assert.equal(res.status, 200, await res.clone().text());
  calls = [];
  return (await res.json()).id;
}

const messages = async (convId) =>
  (await db.prepare('SELECT kind, body, status, error, external_id FROM messages WHERE conversation_id = ? ORDER BY created_at').bind(convId).all()).results;

test('a reply to a US number goes out from the US number, with a status callback', async () => {
  const convId = await thread('+12125551234');
  const res = await post(`/api/conversations/${convId}/reply`, { body: 'See you Thursday at 8' });
  assert.equal(res.status, 201, await res.clone().text());
  const msg = await res.json();
  assert.equal(msg.status, 'accepted');
  const sent = calls.find((c) => c.path.endsWith('/Messages.json'));
  assert.equal(sent.path, `/2010-04-01/Accounts/${SID}/Messages.json`);
  assert.deepEqual(sent.body, {
    To: '+12125551234',
    From: '+16465550100',
    Body: 'See you Thursday at 8',
    StatusCallback: `${ORIGIN}/api/sms/status`,
  });
  assert.equal(sent.auth, `Basic ${btoa(`${SID}:${AUTH}`)}`);
});

test('without Twilio connected, an SMS reply stays queued for the agent as before', async () => {
  const bare = instance({ CLAWNIFY_ORG_ID: org });
  try {
    const bareDb = await bare.getD1Database('DB');
    const schema = await readFile('schema.sql', 'utf8');
    await bareDb.batch(schema.split(';').filter(s => s.trim()).map(s => bareDb.prepare(s)));
    const conv = await (await post('/api/conversations', { channel: 'sms', handle: '+12125551234' }, bare)).json();
    const msg = await (await post(`/api/conversations/${conv.id}/reply`, { body: 'hi' }, bare)).json();
    assert.equal(msg.status, 'queued');
    assert.equal(msg.error ?? null, null);
  } finally {
    await bare.dispose();
  }
});

test('without a connection, the TWILIO_* variables OpenDialer uses are enough', async () => {
  const envOnly = instance({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: AUTH, CLAWNIFY_ORG_ID: org });
  try {
    const envDb = await envOnly.getD1Database('DB');
    const schema = await readFile('schema.sql', 'utf8');
    await envDb.batch(schema.split(';').filter(s => s.trim()).map(s => envDb.prepare(s)));
    const conv = await (await post('/api/conversations', { channel: 'sms', handle: '+12125551234' }, envOnly)).json();
    calls = [];
    const msg = await (await post(`/api/conversations/${conv.id}/reply`, { body: 'hi' }, envOnly)).json();
    assert.equal(msg.status, 'accepted');
    const sent = calls.find((c) => c.path.endsWith('/Messages.json'));
    assert.equal(sent.auth, `Basic ${btoa(`${SID}:${AUTH}`)}`);
  } finally {
    await envOnly.dispose();
  }
});

test('an inbound SMS with a valid signature lands in the thread, and Twilio gets empty TwiML', async () => {
  const fields = { AccountSid: SID, MessageSid: 'SM' + 'b'.repeat(32), From: '+13105550199', To: '+16465550100', Body: 'Running 10 min late', NumMedia: '0' };
  const res = await webhook('/api/sms/inbound', fields);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Response><\/Response>/);
  const conv = await db.prepare("SELECT c.id FROM conversations c JOIN contacts p ON p.id = c.contact_id WHERE p.channel = 'sms' AND p.handle = '+13105550199'").first();
  assert.ok(conv, 'conversation created');
  const [m] = await messages(conv.id);
  assert.equal(m.kind, 'inbound');
  assert.equal(m.body, 'Running 10 min late');

  // Twilio retries: the same MessageSid is not stored twice.
  await webhook('/api/sms/inbound', fields);
  assert.equal((await messages(conv.id)).length, 1);
});

test('an inbound SMS with a bad signature is refused and stores nothing', async () => {
  const fields = { AccountSid: SID, MessageSid: 'SM' + 'c'.repeat(32), From: '+14155550123', Body: 'forged' };
  const res = await webhook('/api/sms/inbound', fields, { signature: sign(`${ORIGIN}/api/sms/inbound`, fields, 'wrong-token') });
  assert.equal(res.status, 403);
  const row = await db.prepare("SELECT id FROM messages WHERE body = 'forged'").first();
  assert.equal(row, null);
});

test('a correctly signed webhook for another Twilio account is refused', async () => {
  const fields = { AccountSid: 'AC' + 'f'.repeat(32), MessageSid: 'SM' + 'd'.repeat(32), From: '+14155550124', Body: 'other account' };
  assert.equal((await webhook('/api/sms/inbound', fields)).status, 403);
});

test('an undelivered status marks the message undelivered with the reason', async () => {
  const convId = await thread('+19295550123');
  const msg = await (await post(`/api/conversations/${convId}/reply`, { body: 'Your table is ready' })).json();
  const sid = (await messages(convId)).at(-1).external_id;
  assert.ok(sid);
  const res = await webhook('/api/sms/status', { AccountSid: SID, MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30007' });
  assert.equal(res.status, 204);
  const [m] = await messages(convId);
  assert.equal(m.status, 'undelivered');
  assert.match(m.error, /30007.*spam/);
  assert.equal(msg.status, 'accepted');
});

test('connecting a number whose texts go elsewhere needs replace, then repoints it and makes it the default', async () => {
  numbers[0].sms_url = 'https://old-system.example/sms';
  const refused = await post(`/api/sms/numbers/${US_NUMBER}/connect`, {});
  assert.equal(refused.status, 409);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);

  const ok = await post(`/api/sms/numbers/${US_NUMBER}/connect`, { replace: true });
  assert.equal(ok.status, 200, await ok.clone().text());
  const update = calls.find((c) => c.method === 'POST');
  assert.equal(update.path, `/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers/${US_NUMBER}.json`);
  assert.deepEqual(update.body, { SmsUrl: `${ORIGIN}/api/sms/inbound`, SmsMethod: 'POST' });

  numbers[0].sms_url = `${ORIGIN}/api/sms/inbound`;
  const list = await (await mf.dispatchFetch(`${ORIGIN}/api/sms/numbers`, { headers })).json();
  const us = list.items.find((n) => n.id === US_NUMBER);
  assert.equal(us.connected, true);
  assert.equal(us.isDefault, true);
});
