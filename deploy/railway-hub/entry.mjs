import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, get, request } from 'node:http';

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

const publicPort = port('PORT', 8080);
const panelPort = port('PANEL_PORT', 8125);
const knowledgePort = port('KNOWLEDGE_PORT', 8424);
if (new Set([publicPort, panelPort, knowledgePort]).size !== 3) {
  throw new Error('PORT, PANEL_PORT and KNOWLEDGE_PORT must be distinct');
}
if (!process.env.KNOWLEDGE_SERVICE_KEY?.trim() ||
    process.env.KNOWLEDGE_AUTH_TOKEN !== process.env.KNOWLEDGE_SERVICE_KEY) {
  throw new Error('KNOWLEDGE_SERVICE_KEY and KNOWLEDGE_AUTH_TOKEN must be nonempty and identical');
}
if (process.env.HUB_PUBLIC_TOKEN === process.env.KNOWLEDGE_SERVICE_KEY) {
  throw new Error('HUB_PUBLIC_TOKEN must differ from KNOWLEDGE_SERVICE_KEY');
}
if (process.env.API_PREFIX && process.env.API_PREFIX !== '/v3') {
  throw new Error('The Hub ingress requires API_PREFIX=/v3');
}
process.env.API_PREFIX = '/v3';
process.env.PANEL_PORT = String(panelPort);
process.env.KNOWLEDGE_PORT = String(knowledgePort);

// The upstream KS deliberately permits anonymous reads; public ingress must not.
// A missing public token disables the entire public KS surface, not its auth.
const publicToken = process.env.HUB_PUBLIC_TOKEN
  ? Buffer.from(process.env.HUB_PUBLIC_TOKEN)
  : null;
const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function endJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function publicAuthorized(req) {
  const supplied = req.headers['x-hub-token'] ??
    /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '')?.[1];
  if (typeof supplied !== 'string') return false;
  const candidate = Buffer.from(supplied);
  return candidate.length === publicToken.length && timingSafeEqual(candidate, publicToken);
}

function forwardingHeaders(headers) {
  const result = { ...headers };
  for (const name of (headers.connection || '').split(',')) delete result[name.trim().toLowerCase()];
  for (const name of hopHeaders) delete result[name];
  delete result['x-hub-token'];
  return result;
}

function backendHealthy(port) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => probe.destroy(), 2000);
    const finish = (healthy) => {
      clearTimeout(timer);
      resolve(healthy);
    };
    const probe = get({ hostname: '127.0.0.1', port, path: '/health', agent: false }, (upstream) => {
      upstream.on('error', () => finish(false));
      upstream.on('end', () => finish(upstream.statusCode === 200));
      upstream.resume();
    });
    probe.on('error', () => finish(false));
  });
}

function forward(req, res, port) {
  const outgoing = request({
    hostname: '127.0.0.1', port, method: req.method, path: req.url,
    headers: forwardingHeaders(req.headers),
  }, (upstream) => {
    upstream.on('error', () => res.destroy());
    res.writeHead(upstream.statusCode, forwardingHeaders(upstream.headers));
    res.flushHeaders();
    upstream.pipe(res);
  });
  outgoing.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else endJson(res, 502, { code: 502, message: 'backend unavailable', data: null });
  });
  req.on('aborted', () => outgoing.destroy());
  req.on('error', () => outgoing.destroy());
  res.on('close', () => outgoing.destroy());
  // Native pipes preserve backpressure for uploads, downloads and SSE.
  req.pipe(outgoing);
}

let stopping = false;
const server = createServer(async (req, res) => {
  const path = req.url.split('?', 1)[0];
  if (path === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      endJson(res, 405, { code: 405, message: 'method not allowed', data: null });
      return;
    }
    const [panel, knowledge] = await Promise.all([
      backendHealthy(panelPort), backendHealthy(knowledgePort),
    ]);
    const healthy = panel && knowledge && !stopping;
    endJson(res, healthy ? 200 : 503, {
      status: healthy ? 'ok' : 'unavailable', backends: { panel, knowledge },
    });
    return;
  }
  const knowledgePath = path === '/v3' || path.startsWith('/v3/') ||
    path === '/docs' || path.startsWith('/docs/') || path === '/openapi.json';
  if (knowledgePath) {
    if (!publicToken) {
      endJson(res, 503, { code: 503, message: 'public knowledge access disabled', data: null });
      return;
    }
    if (!publicAuthorized(req)) {
      endJson(res, 401, { code: 401, message: 'valid Hub public token required', data: null });
      return;
    }
  }
  forward(req, res, knowledgePath ? knowledgePort : panelPort);
});
// Ingest and streamed responses can legitimately run longer than five minutes.
server.requestTimeout = 0;

// A separate process group includes bash, both upstream Nodes and their tees.
// Signal the group, not only bash (the upstream launcher tracks pipeline tees).
const combined = spawn('/usr/local/bin/start-combined.sh', [], {
  detached: true, stdio: 'inherit', env: process.env,
});
let combinedExited = false;
let serverClosed = false;
let shutdownTimer;

function finishShutdown() {
  if (!combinedExited || !serverClosed) return;
  if (!combined.pid) {
    clearTimeout(shutdownTimer);
    return;
  }
  // Bash can exit before a backend finishes its own signal handler. Keep the
  // grace deadline alive while any descendant remains in the process group.
  try {
    process.kill(-combined.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') clearTimeout(shutdownTimer);
    else process.exitCode = 1;
  }
}

function signalCombined(signal) {
  if (!combined.pid) return;
  try {
    process.kill(-combined.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') process.exitCode = 1;
  }
}

function shutdown(exitCode, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  shutdownTimer = setTimeout(() => {
    signalCombined('SIGKILL');
    server.closeAllConnections();
    process.exit(process.exitCode || 0);
  }, 10000);
  server.close(() => {
    serverClosed = true;
    finishShutdown();
  });
  signalCombined(signal);
  finishShutdown();
}

combined.on('error', () => {
  combinedExited = true;
  console.error('[railway-hub] combined launcher could not start');
  shutdown(1);
});
combined.on('exit', (code, signal) => {
  combinedExited = true;
  if (!stopping) {
    console.error(`[railway-hub] combined launcher exited (${signal || code}); stopping ingress`);
    shutdown(code || 1);
  }
  finishShutdown();
});
process.once('SIGTERM', () => shutdown(0));
process.once('SIGINT', () => shutdown(0, 'SIGINT'));
server.on('error', () => {
  console.error('[railway-hub] HTTP ingress failed');
  shutdown(1);
});
server.listen(publicPort, '0.0.0.0', () => {
  console.log(`[railway-hub] ingress listening on :${publicPort}; public KS ${publicToken ? 'token-protected' : 'disabled'}`);
});
