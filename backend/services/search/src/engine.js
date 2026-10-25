import {readFileSync} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {join} from 'node:path';

/**
 * The search service's connection to the search engine: `request(method, path, body)` →
 * `{ status, body }`, the form @lrfe/search-index takes. Over https the engine's certificate is
 * checked against the install's own authority and the service logs in with its own user, both
 * from the login directory search-prepare made (`user`, `password`, `ca.pem`,
 * deploy/opensearch/prepare.sh). Over http (tests, development) without a login.
 */
export function createEngine({url, loginDir, timeoutMs = 15_000}) {
  const base = new URL(url);
  const secure = base.protocol === 'https:';
  const login = secure ? readLogin(loginDir) : null;
  const agent = secure
    ? new https.Agent({ca: login.ca, keepAlive: true})
    : new http.Agent({keepAlive: true});
  const transport = secure ? https : http;

  return function request(method, path, body) {
    const payload =
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = transport.request(
        new URL(path, base),
        {
          method,
          agent,
          timeout: timeoutMs,
          headers: {
            ...(payload === undefined
              ? {}
              : {
                  'content-type': path.includes('_bulk')
                    ? 'application/x-ndjson'
                    : 'application/json',
                }),
            ...(login
              ? {
                  authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`,
                }
              : {}),
          },
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({status: res.statusCode, body: parseBody(text)});
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error('the search engine did not answer in time')),
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  };
}

/** The engine's answer as JSON; an answer that is not JSON as an error reason. */
function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {error: {reason: text.slice(0, 200)}};
  }
}

/** The service's login to the engine; an error naming the missing file. */
function readLogin(dir) {
  if (!dir) throw new Error('OPENSEARCH_LOGIN_DIR is not set');
  const read = name => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch (err) {
      throw new Error(`The search engine login has no ${name}: ${err.message}`);
    }
  };
  return {
    user: read('user').trim(),
    password: read('password').trim(),
    ca: read('ca.pem'),
  };
}
