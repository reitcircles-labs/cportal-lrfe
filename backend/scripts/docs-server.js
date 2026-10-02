#!/usr/bin/env node
/**
 * Browse the API docs with Swagger UI:  npm run docs:serve   → http://localhost:3510
 *
 * Serves services/<name>/docs/openapi.yaml with a picker, and forwards "Try it out" requests to
 * the running services from the same origin (no CORS setup needed):
 *   /api/...            → the gateway (GATEWAY_URL, default http://localhost:3500)
 *   /direct/<name>/...  → a service on its own port (identity 3501 … intake 3504)
 * Sign in with POST /api/auth/login (+ /api/auth/mfa), copy `accessToken`, then "Authorize".
 * Swagger UI itself is loaded from the jsDelivr CDN, so the browser needs internet access.
 */
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DOCS_PORT || 3510);
const GATEWAY = new URL(process.env.GATEWAY_URL || 'http://localhost:3500');
const SPECS = { gateway: 3500, identity: 3501, edrms: 3502, bpm: 3503, intake: 3504 };

/** The spec with its server pointed at this origin, so requests come back here to be forwarded. */
function spec(name) {
    const text = readFileSync(join(ROOT, 'services', name, 'docs', 'openapi.yaml'), 'utf8');
    const url = name === 'gateway' ? '/' : `/direct/${name}`;
    return text.replace(/^servers:\n(?:\s+.*\n)+?(?=\S)/m, `servers:\n  - url: ${url}\n    description: through the docs server (npm run docs:serve)\n`);
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>cportal-lrfe API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>body{margin:0} .topbar{display:none}</style></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    dom_id: '#ui',
    urls: ${JSON.stringify(Object.keys(SPECS).map(n => ({ name: n === 'gateway' ? 'all endpoints (gateway /api)' : `${n} (direct)`, url: `/specs/${n}.yaml` })))},
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
    persistAuthorization: true,
    withCredentials: true,
    tryItOutEnabled: false,
    displayRequestDuration: true,
    filter: true
  });
</script></body></html>`;

function forward(req, res, target, path) {
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, method: req.method, path, headers: { ...req.headers, host: target.host } }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
    });
    upstream.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'Bad Gateway', message: `${target.origin} is not reachable (${err.code}). Is it running?` }));
    });
    req.pipe(upstream);
}

createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const specMatch = url.pathname.match(/^\/specs\/([a-z]+)\.yaml$/);
    const direct = url.pathname.match(/^\/direct\/([a-z]+)(\/.*)$/);
    try {
        if (url.pathname === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page); }
        if (specMatch && SPECS[specMatch[1]]) { res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'cache-control': 'no-store' }); return res.end(spec(specMatch[1])); }
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return forward(req, res, GATEWAY, req.url);
        if (direct && SPECS[direct[1]] && direct[1] !== 'gateway') return forward(req, res, new URL(`http://localhost:${SPECS[direct[1]]}`), direct[2] + url.search);
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
    } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`${err.message}\nRun \`npm run docs\` in backend/ first?`);
    }
}).listen(PORT, '127.0.0.1', () => {
    console.log(`API docs: http://localhost:${PORT}   ("Try it out" goes to ${GATEWAY.origin} for /api; Ctrl+C stops)`);
});
