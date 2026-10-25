/**
 * A search engine for tests (API-801, API-808): the engine at SEARCH_TEST_OPENSEARCH_URL (no
 * login, and no `lrfe-documents` index: the tests fill and empty it), or a throwaway container of
 * the install's image when it is on this machine (never pulled; about 35 seconds to start).
 * `engineAvailable` is false when neither is there: the tests that need it are skipped.
 */
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {DEAD_LETTER_INDEX, INDEX_ALIAS} from './mapping.js';

/** The image the install runs (deploy/docker-compose.yml). */
const IMAGE = 'opensearchproject/opensearch:3.9.0';
const givenUrl = process.env.SEARCH_TEST_OPENSEARCH_URL;
const docker = (...args) => spawnSync('docker', args, {encoding: 'utf8'});

export const engineAvailable =
  !!givenUrl || docker('image', 'inspect', IMAGE).status === 0;

const freePort = () =>
  new Promise(resolve => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** `request(method, path, body)` → `{ status, body }` on an engine without login. */
export function plainRequest(base) {
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': path.includes('_bulk')
          ? 'application/x-ndjson'
          : 'application/json',
      },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    const text = await res.text();
    return {status: res.status, body: text ? JSON.parse(text) : null};
  };
}

/**
 * Starts the engine (or takes the given one) and waits until it answers:
 * `{ url, request, empty(), stop() }`. `empty()` removes the indexes the tests made.
 */
export async function startTestEngine() {
  let url = givenUrl?.replace(/\/$/, '');
  let container = null;
  if (!url) {
    const port = await freePort();
    container = `lrfe-test-opensearch-${process.pid}-${port}`;
    const run = docker(
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-p',
      `127.0.0.1:${port}:9200`,
      '-e',
      'discovery.type=single-node',
      '-e',
      'DISABLE_SECURITY_PLUGIN=true',
      '-e',
      'DISABLE_INSTALL_DEMO_CONFIG=true',
      '-e',
      'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
      IMAGE,
    );
    if (run.status !== 0) throw new Error(`docker run: ${run.stderr}`);
    url = `http://127.0.0.1:${port}`;
  }
  const stop = () => {
    if (container) docker('rm', '-f', container);
  };
  for (let i = 0; ; i++) {
    const up = await fetch(`${url}/_cluster/health`).catch(() => null);
    if (up?.ok) break;
    if (i >= 150) {
      stop();
      throw new Error(`The test search engine at ${url} did not start`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  const request = plainRequest(url);
  // an engine given by URL must not hold a real index: the tests would erase it
  if (!container) {
    const there = await request('GET', `/_alias/${INDEX_ALIAS}`);
    if (there.status !== 404) {
      throw new Error(
        `${url} already has ${INDEX_ALIAS}: give an empty engine`,
      );
    }
  }
  const empty = async () => {
    await request('DELETE', `/${INDEX_ALIAS}-v*`);
    await request('DELETE', `/${DEAD_LETTER_INDEX}`);
  };
  return {url, request, empty, stop};
}
