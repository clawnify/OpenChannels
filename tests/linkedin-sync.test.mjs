import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// LinkedIn sync: one schedule on the org's agent, created and managed by the
// app through the platform's agents API (faked below), and a run record the
// agent opens and closes. These run the real worker.

const org = 'sync-test-org';
const person = {
  'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'user', 'Content-Type': 'application/json',
  'X-Clawnify-User-Id': 'user-1', 'X-Clawnify-User-Name': 'Sam Reviewer',
};
const agent = { 'X-Clawnify-Org-Id': org, 'X-Clawnify-Caller': 'agent', 'Content-Type': 'application/json' };
const PEDRO = '46d3c39e-d490-433d-b27c-db7e2d6fd396';
const OTHER = '9a1c2b3d-0000-4000-8000-000000000002';
const settings = (over = {}) => ({ serverId: PEDRO, cadence: 'workday-hourly', timezone: 'Europe/Amsterdam', active: true, ...over });

let script, schema;
const instances = [];
before(async () => {
  script = (await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] })).outputFiles[0].text;
  schema = await readFile('schema.sql', 'utf8');
});
after(async () => { await Promise.all(instances.map((mf) => mf.dispose())); });

/** A fresh worker plus a fake agents API that records every call. */
async function runtime({ failDeleteOn } = {}) {
  const calls = [];
  const schedules = new Map();
  let next = 1;
  const mf = new Miniflare({
    modules: true, script, compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['UPLOADS'], bindings: { CLAWNIFY_TOKEN: 'test-token' },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'provision.clawnify.com');
      assert.equal(request.headers.get('authorization'), 'Bearer test-token');
      const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.json();
      calls.push({ method: request.method, path: url.pathname, body, key: request.headers.get('idempotency-key') });
      const m = url.pathname.match(/^\/v1\/agents\/servers\/([^/]+)\/schedules(?:\/([^/]+))?$/);
      if (url.pathname === '/v1/agents/servers') {
        return Response.json({ servers: [{ id: PEDRO, name: 'Pedro', status: 'ready' }], page: { limit: 50, offset: 0, has_more: false } });
      }
      if (url.pathname === '/v1/agents/tasks') {
        return Response.json({ task_id: 't1', server_id: body.server_id, agent: 'main', status: 'queued' }, { status: 202 });
      }
      if (m && request.method === 'POST' && !m[2]) {
        const s = { id: `sch-${next++}`, server: m[1], enabled: true, ...body, state: { next_run_at: '2026-09-18T07:00:00Z' } };
        schedules.set(s.id, s);
        return Response.json({ schedule: s, replayed: false }, { status: 201 });
      }
      if (m && m[2]) {
        const s = schedules.get(m[2]);
        if (request.method === 'DELETE') {
          if (failDeleteOn === m[1]) return Response.json({ error: 'agent_unreachable' }, { status: 502 });
          schedules.delete(m[2]);
          return new Response(null, { status: 204 });
        }
        if (!s) return Response.json({ error: 'not_found' }, { status: 404 });
        if (request.method === 'PATCH') Object.assign(s, body);
        return Response.json({ schedule: s });
      }
      return new Response('unexpected', { status: 500 });
    },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').filter((s) => s.trim()).map((s) => db.prepare(s)));
  const call = async (path, headers, method = 'GET', body) => {
    const res = await mf.dispatchFetch('https://inbox.example' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, calls, schedules, db };
}

const uuid = () => crypto.randomUUID();

test('sync is off until a person turns it on, and the agent is told to stop', async () => {
  const { call, calls } = await runtime();
  const r = await call('/api/linkedin-sync/runs', agent, 'POST', { id: uuid() });
  assert.equal(r.status, 410);
  assert.deepEqual((await call('/api/linkedin-sync', person)).body.sync, null);
  assert.equal(calls.length, 0);
});

test('only a person can change sync, with a known cadence and time zone', async () => {
  const { call, calls } = await runtime();
  assert.equal((await call('/api/linkedin-sync', agent, 'PUT', settings())).status, 403);
  assert.equal((await call('/api/linkedin-sync/run-now', agent, 'POST', { id: uuid() })).status, 403);
  assert.equal((await call('/api/linkedin-sync', person, 'PUT', settings({ cadence: 'every-minute' }))).status, 400);
  assert.equal((await call('/api/linkedin-sync', person, 'PUT', settings({ timezone: 'Mars/Olympus' }))).status, 400);
  assert.equal(calls.length, 0);
});

test('turning it on creates one schedule on the chosen agent', async () => {
  const { call, calls } = await runtime();
  const r = await call('/api/linkedin-sync', person, 'PUT', settings());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/schedules'));
  assert.equal(creates.length, 1);
  const [create] = creates;
  assert.equal(create.path, `/v1/agents/servers/${PEDRO}/schedules`);
  assert.deepEqual(create.body.trigger, { kind: 'cron', expr: '0 8-18 * * 1-5', tz: 'Europe/Amsterdam' });
  assert.equal(create.body.name, 'OpenChannels: LinkedIn sync');
  assert.match(create.body.text, /# LinkedIn sync/);
  assert.match(create.body.text, /Task data: \{"app":"OpenChannels","app_url":"https:\/\/inbox\.example"\}/);
  assert.ok(create.body.text.length <= 4000);
  assert.match(create.key, /^openchannels-linkedin-sync:[0-9a-f-]{36}$/);
  assert.deepEqual(r.body.sync, {
    serverId: PEDRO, cadence: 'workday-hourly', timezone: 'Europe/Amsterdam',
    active: true, scheduled: true, scheduleError: null, nextRunAt: '2026-09-18T07:00:00Z',
  });
});

test('saving again changes the same schedule, never adds a second', async () => {
  const { call, calls, schedules } = await runtime();
  await call('/api/linkedin-sync', person, 'PUT', settings());
  const r = await call('/api/linkedin-sync', person, 'PUT', settings({ cadence: 'workday-10m' }));
  assert.equal(r.status, 200);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/schedules')).length, 1);
  assert.equal(schedules.size, 1);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.trigger.expr, '*/10 8-18 * * 1-5');
  assert.equal(patch.body.enabled, true);
  assert.match(patch.body.text, /Snapshot sha256: [0-9a-f]{64}/);
});

test('turning it off pauses the schedule, and runs are refused', async () => {
  const { call, calls, schedules } = await runtime();
  await call('/api/linkedin-sync', person, 'PUT', settings());
  const r = await call('/api/linkedin-sync', person, 'PUT', settings({ active: false }));
  assert.equal(r.status, 200);
  assert.equal(r.body.sync.active, false);
  assert.equal([...schedules.values()][0].enabled, false);
  assert.equal((await call('/api/linkedin-sync/runs', agent, 'POST', { id: uuid() })).status, 410);
  assert.equal((await call('/api/linkedin-sync/run-now', person, 'POST', { id: uuid() })).status, 409);
  assert.equal(calls.filter((c) => c.path === '/v1/agents/tasks').length, 0);
});

test('one run at a time, opened and closed by the agent', async () => {
  const { call } = await runtime();
  await call('/api/linkedin-sync', person, 'PUT', settings());
  const a = uuid();
  const first = await call('/api/linkedin-sync/runs', agent, 'POST', { id: a });
  assert.equal(first.status, 201);
  assert.equal(first.body.run.status, 'running');
  // A retry with the same id is the same run.
  const retry = await call('/api/linkedin-sync/runs', agent, 'POST', { id: a });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created, false);
  // An overlapping fire is told to stop.
  const b = uuid();
  assert.equal((await call('/api/linkedin-sync/runs', agent, 'POST', { id: b })).status, 409);
  // A person cannot open or close runs.
  assert.equal((await call('/api/linkedin-sync/runs', person, 'POST', { id: uuid() })).status, 403);
  assert.equal((await call(`/api/linkedin-sync/runs/${a}`, person, 'PATCH', { status: 'done' })).status, 403);

  const done = await call(`/api/linkedin-sync/runs/${a}`, agent, 'PATCH', { status: 'done', mirrored: 4, sent: 1, failed: 0 });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.run.status, done.body.run.mirrored, done.body.run.sent], ['done', 4, 1]);
  assert.equal((await call(`/api/linkedin-sync/runs/${a}`, agent, 'PATCH', { status: 'done' })).status, 409);

  // Now the next run may start; a failure must say why.
  assert.equal((await call('/api/linkedin-sync/runs', agent, 'POST', { id: b })).status, 201);
  assert.equal((await call(`/api/linkedin-sync/runs/${b}`, agent, 'PATCH', { status: 'failed' })).status, 400);
  const failed = await call(`/api/linkedin-sync/runs/${b}`, agent, 'PATCH', { status: 'failed', error: 'LinkedIn asked to sign in' });
  assert.equal(failed.body.run.error, 'LinkedIn asked to sign in');

  const history = (await call('/api/linkedin-sync', person)).body.runs;
  assert.deepEqual(history.map((r) => r.status).sort(), ['done', 'failed']);
});

test('a run that never reported back stops blocking after 45 minutes', async () => {
  const { call, db } = await runtime();
  await call('/api/linkedin-sync', person, 'PUT', settings());
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await db.prepare("INSERT INTO linkedin_sync_runs (id, org_id, status, started_at) VALUES ('dead-run', ?, 'running', ?)").bind(org, old).run();
  const r = await call('/api/linkedin-sync/runs', agent, 'POST', { id: uuid() });
  assert.equal(r.status, 201);
  const dead = await db.prepare("SELECT status, error FROM linkedin_sync_runs WHERE id = 'dead-run'").first();
  assert.equal(dead.status, 'failed');
  assert.match(dead.error, /No result reported within 45 minutes/);
});

test('moving to another agent removes the old schedule before creating the new one', async () => {
  const { call, calls, schedules } = await runtime();
  await call('/api/linkedin-sync', person, 'PUT', settings());
  const firstKey = calls.find((c) => c.method === 'POST').key;
  const r = await call('/api/linkedin-sync', person, 'PUT', settings({ serverId: OTHER }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const order = calls.map((c) => `${c.method} ${c.path}`);
  const del = order.indexOf(`DELETE /v1/agents/servers/${PEDRO}/schedules/sch-1`);
  const create = order.indexOf(`POST /v1/agents/servers/${OTHER}/schedules`);
  assert.ok(del >= 0 && create > del, order.join('\n'));
  assert.notEqual(calls.filter((c) => c.method === 'POST')[1].key, firstKey);
  assert.deepEqual([...schedules.values()].map((s) => s.server), [OTHER]);
});

test('if the old schedule cannot be removed, no second schedule is created', async () => {
  const { call, calls } = await runtime({ failDeleteOn: PEDRO });
  await call('/api/linkedin-sync', person, 'PUT', settings());
  const r = await call('/api/linkedin-sync', person, 'PUT', settings({ serverId: OTHER }));
  assert.equal(r.status, 503);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.includes(OTHER)).length, 0);
  const state = (await call('/api/linkedin-sync', person)).body.sync;
  assert.equal(state.serverId, PEDRO);
  assert.match(state.scheduleError, /previous agent/);
});

test('run now dispatches one task per request id', async () => {
  const { call, calls } = await runtime();
  await call('/api/linkedin-sync', person, 'PUT', settings());
  const id = uuid();
  assert.equal((await call('/api/linkedin-sync/run-now', person, 'POST', { id })).status, 202);
  const task = calls.find((c) => c.path === '/v1/agents/tasks');
  assert.equal(task.body.server_id, PEDRO);
  assert.equal(task.body.idempotency_key, `openchannels-linkedin-sync-now:${id}`);
  assert.match(task.body.instruction, /# LinkedIn sync/);
});

test('removing sync deletes the schedule and the settings', async () => {
  const { call, schedules } = await runtime();
  await call('/api/linkedin-sync', person, 'PUT', settings());
  assert.equal((await call('/api/linkedin-sync', person, 'DELETE')).status, 200);
  assert.equal(schedules.size, 0);
  assert.equal((await call('/api/linkedin-sync', person)).body.sync, null);
});

test('agents discover the run routes but not the settings routes', async () => {
  const { call } = await runtime();
  const spec = (await call('/api/openapi.json', agent)).body;
  const paths = Object.keys(spec.paths);
  assert.ok(paths.includes('/api/linkedin-sync/runs'));
  assert.ok(paths.includes('/api/linkedin-sync/runs/{id}'));
  assert.ok(!paths.includes('/api/linkedin-sync'));
  assert.ok(!paths.some((p) => p.includes('run-now') || p.includes('/agents')));
});
