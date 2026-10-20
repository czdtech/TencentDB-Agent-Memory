import assert from 'node:assert/strict';

// Read-only checks against a real running Hub; no mock servers or mutations.
const base = new URL(process.env.HUB_BASE_URL || 'http://127.0.0.1:8080');
const publicToken = process.env.HUB_PUBLIC_TOKEN;
const serviceKey = process.env.KNOWLEDGE_SERVICE_KEY;

async function call(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { response, text };
}

function envelope(result, expectedStatus) {
  assert.equal(result.response.status, expectedStatus);
  assert.match(result.response.headers.get('content-type') || '', /application\/json/);
  const body = JSON.parse(result.text);
  assert.equal(typeof body.code, 'number');
  assert.equal(typeof body.message, 'string');
  assert.ok(Object.hasOwn(body, 'data'));
  return body;
}

const health = await call('/health');
const healthBody = JSON.parse(health.text);
if (process.env.HUB_EXPECT_UNHEALTHY === '1') {
  assert.equal(health.response.status, 503);
  assert.equal(healthBody.status, 'unavailable');
  assert.ok(!healthBody.backends.panel || !healthBody.backends.knowledge);
  console.log('PASS: a real unavailable backend prevents healthy ingress');
} else {
  assert.equal(health.response.status, 200);
  assert.equal(healthBody.status, 'ok');
  assert.deepEqual(healthBody.backends, { panel: true, knowledge: true });

  const panel = await call('/');
  assert.equal(panel.response.status, 200);
  assert.match(panel.response.headers.get('content-type') || '', /text\/html/);
  assert.match(panel.text, /<html[\s>]/i);

  const panelApi = await call('/api/v1/meta/agent/list', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(envelope(panelApi, 400).message, 'MISSING_INSTANCE_ID');

  const publicStatus = publicToken ? 401 : 503;
  for (const path of ['/v3/tools/list', '/docs', '/openapi.json']) {
    envelope(await call(path), publicStatus);
  }
  envelope(await call('/v3/tools/list', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }), publicStatus);

  if (publicToken) {
    const headers = { 'x-hub-token': publicToken, 'content-type': 'application/json' };
    // This exact 400 is emitted by KS's real tools route, never by Panel's SPA.
    const tools = envelope(await call('/v3/tools/list', {
      method: 'POST', headers, body: '{}',
    }), 400);
    assert.equal(tools.message, 'x-tdai-service-id header is required');
    const bearerTools = envelope(await call('/v3/tools/list', {
      method: 'POST', headers: {
        authorization: `Bearer ${publicToken}`, 'content-type': 'application/json',
      }, body: '{}',
    }), 400);
    assert.equal(bearerTools.message, tools.message);

    const docs = await call('/docs', { headers });
    assert.equal(docs.response.status, 200);
    assert.match(docs.response.headers.get('content-type') || '', /text\/html/);
    assert.match(docs.text, /swagger-ui/i);
    const spec = await call('/openapi.json', { headers });
    assert.equal(spec.response.status, 200);
    assert.match(spec.text, /openapi:\s*["']?3\./);

    const internalPath = '/v3/internal/llm-binding/list';
    envelope(await call(internalPath, { method: 'POST', headers, body: '{}' }), 401);
    envelope(await call(internalPath, {
      method: 'POST', headers: { ...headers, authorization: 'Bearer invalid-smoke-key' }, body: '{}',
    }), 401);
    if (serviceKey) {
      const authorized = envelope(await call(internalPath, {
        method: 'POST', headers: { ...headers, authorization: `Bearer ${serviceKey}` }, body: '{}',
      }), 200);
      assert.equal(authorized.code, 0);
    }
  }
  console.log(`PASS: Panel, dual-backend health and ${publicToken ? 'protected KS routes/auth/docs' : 'disabled public KS'}`);
}
