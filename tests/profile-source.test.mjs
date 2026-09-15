import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const instances = [];
let script, schema;
const headers = { 'X-Clawnify-Org-Id': 'test-org', 'X-Clawnify-Caller': 'user', 'Content-Type': 'application/json' };
before(async () => {
  script = (await build({ entryPoints: ['src/server/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*'] })).outputFiles[0].text;
  schema = await readFile('schema.sql', 'utf8');
});
after(async () => { await Promise.all(instances.map(mf => mf.dispose())); });
async function runtime(bindings = {}) {
  const calls = [];
  const mf = new Miniflare({ modules: true, script,
    compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { CLAWNIFY_TOKEN: 'test-token', ...bindings },
    outboundService: request => {
      const url = new URL(request.url); calls.push(url);
      assert.equal(url.hostname, 'provision.clawnify.com');
      assert.equal(request.headers.get('authorization'), 'Bearer test-token');
      if (url.pathname.startsWith('/v1/apps/crm-app/proxy/')) return Response.json({ contacts: [{ id: 'jamie', first_name: 'Jamie', email: 'jamie@example.test', phone: '' }] });
      if (url.pathname.startsWith('/v1/apps/people-app/proxy/')) return Response.json({ people: [{ id: 'alex', fullName: 'Alex Morgan' }] });
      return new Response('Not found', { status: 404 });
    },
  });
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  const request = (path, method = 'GET', body) => mf.dispatchFetch('https://app.test' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {request, calls};
}
test('an unconnected inbox has no profile source and makes no sibling call', async () => {
  const {request, calls} = await runtime();
  assert.deepEqual(await (await request('/api/profile-source')).json(), {source:null});
  assert.deepEqual(await (await request('/api/profile-source/search?q=Jamie')).json(), {items:[]});
  assert.equal(calls.length, 0);
});
test('the optional CRM connection uses the existing picker and custom settings take precedence', async () => {
  const {request, calls} = await runtime({ CRM_APP_ID: 'crm-app' });
  const source = (await (await request('/api/profile-source')).json()).source;
  assert.equal(source.appId, 'crm-app');
  const found = await request('/api/profile-source/search?q=Jamie');
  assert.equal(found.status, 200, await found.clone().text());
  assert.deepEqual((await found.json()).items, [{ref:'jamie', name:'Jamie', email:'jamie@example.test', phone:null, profileUrl:null}]);
  assert.equal(calls[0].pathname, '/v1/apps/crm-app/proxy/api/contacts');
  assert.equal(calls[0].searchParams.get('search'), 'Jamie');
  const custom = {appId:'people-app', search:{path:'/api/people',query:'q',collection:'people'}, fields:{ref:'id',name:'fullName'}};
  assert.equal((await request('/api/profile-source', 'PUT', custom)).status, 200);
  assert.equal((await (await request('/api/profile-source')).json()).source.appId, 'people-app');
  const replaced = await request('/api/profile-source/search?q=Alex');
  assert.equal((await replaced.json()).items[0].name, 'Alex Morgan');
});
