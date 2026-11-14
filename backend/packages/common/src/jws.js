import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {readFile} from 'node:fs/promises';

import {canonicalJson} from './canonical.js';
import {AppError} from './errors.js';

/**
 * Signed JSON for the platform (CB-32): compact JWS, ES256 only, the payload the canonical JSON
 * of the data. Made with node:crypto alone; the signature is IEEE P1363 (r and s, 32 bytes each),
 * as RFC 7515 wants for ES256.
 *
 * A Signer holds the platform's signing key:
 *   kind               'local' (an in-process key, never in production) | 'bao' (the key store)
 *   currentKid()       → the key id the next signature is made with
 *   sign(bytes, {kid}) → {kid, signature}: the ES256 signature of `bytes` (P1363) with that key
 *   jwks()             → {keys: [public JWK with kid and alg ES256]}: every key version, so that
 *                        signatures of older versions keep verifying after a rotation
 */

/** The one algorithm signed and accepted. */
const ALGORITHM = 'ES256';

/** The length of an ES256 signature: r and s, 32 bytes each. */
const SIGNATURE_LENGTH = 64;

/** How long the key-store signer keeps the key set it read: 5 minutes. */
const KEY_SET_TTL_MS = 5 * 60 * 1000;

/** One part of a compact JWS: base64url without padding, never empty. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Why a signature cannot be made now: answered to users, so no tool named; the cause is kept. */
const SIGNING_FAILED_MESSAGE =
  'The platform signature cannot be made now: try again later. If it keeps failing, tell the administrator.';

/**
 * A signing failure: 503 with a neutral message, the cause kept for the log.
 * @param {!Error} cause
 * @return {!AppError}
 */
function signingFailed(cause) {
  const error = new AppError(503, SIGNING_FAILED_MESSAGE);
  error.cause = cause;
  return error;
}

/**
 * A value as one base64url part of a JWS.
 * @param {(string|!Buffer)} value
 * @return {string}
 */
function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Signs data as a compact JWS: header `{alg: 'ES256', kid, typ}`, payload the canonical JSON of
 * `payload`, signature by `signer` with its current key.
 * @param {*} payload JSON data
 * @param {{currentKid: function(): !Promise<string>, sign: function(!Buffer, {kid: string}):
 *     !Promise<{kid: string, signature: !Buffer}>}} signer
 * @param {{typ: string, kid?: string}} options `typ`: the kind of document signed, e.g.
 *     'lrfe-title-entry'; `kid`: the key to sign with when the payload names it already (by
 *     default the signer's current key)
 * @return {!Promise<string>}
 */
export async function signJws(payload, signer, {typ, kid: chosenKid}) {
  const kid = chosenKid ?? (await signer.currentKid());
  const header = base64url(JSON.stringify({alg: ALGORITHM, kid, typ}));
  const signingInput = `${header}.${base64url(canonicalJson(payload))}`;
  const signed = await signer.sign(Buffer.from(signingInput), {kid});
  if (signed.kid !== kid || signed.signature.length !== SIGNATURE_LENGTH) {
    throw signingFailed(
      new Error(`The signature was made with ${signed.kid}, not ${kid}`),
    );
  }
  return `${signingInput}.${base64url(signed.signature)}`;
}

/**
 * The parts of a compact JWS, its header parsed; throws when it is not one.
 * @param {*} jws
 * @return {{header: !Object, payload: string, signature: string, signingInput: string}}
 */
function parseJws(jws) {
  if (typeof jws !== 'string') {
    throw new Error('Not a compact JWS');
  }
  const parts = jws.split('.');
  if (parts.length !== 3 || !parts.every(part => BASE64URL.test(part))) {
    throw new Error('Not a compact JWS');
  }
  const [header, payload, signature] = parts;
  const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('The JWS header is not an object');
  }
  return {
    header: parsed,
    payload,
    signature,
    signingInput: `${header}.${payload}`,
  };
}

/**
 * Verifies a compact JWS with a key set: ES256 only, the key the one of the header's kid.
 * @param {*} jws
 * @param {{keys: !Array<!Object>}} jwks the public keys (a JWK set)
 * @return {!Promise<*>} the payload; rejects when the JWS does not verify
 */
export async function verifyJws(jws, jwks) {
  const {header, payload, signature, signingInput} = parseJws(jws);
  if (header.alg !== ALGORITHM) {
    throw new Error(`The JWS algorithm must be ${ALGORITHM}`);
  }
  if (typeof header.kid !== 'string') {
    throw new Error('The JWS names no key');
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const jwk = keys.find(key => key?.kid === header.kid);
  if (!jwk) {
    throw new Error(`No key ${header.kid} in the key set`);
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new Error(`Key ${header.kid} is not a P-256 key`);
  }
  const key = createPublicKey({
    key: {kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y},
    format: 'jwk',
  });
  const bytes = Buffer.from(signature, 'base64url');
  const valid =
    bytes.length === SIGNATURE_LENGTH &&
    cryptoVerify(
      'sha256',
      Buffer.from(signingInput),
      {key, dsaEncoding: 'ieee-p1363'},
      bytes,
    );
  if (!valid) {
    throw new Error('The JWS signature does not verify');
  }
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * A P-256 public key as a JWK of the key set, with its kid.
 * @param {!Object} publicJwk the key's {kty, crv, x, y}
 * @param {string} kid
 * @return {!Object}
 */
function publicJwkOf(publicJwk, kid) {
  return {
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
    kid,
    alg: ALGORITHM,
    use: 'sig',
  };
}

/**
 * An in-process signer for the unit tests, development and the e2e stack without a key store: a
 * P-256 key made at start, its kid `local:` and its RFC 7638 thumbprint. Never used with
 * NODE_ENV=production (signerFromEnv).
 * @return {!Promise<!Object>} a Signer
 */
export async function createLocalSigner() {
  const {publicKey, privateKey} = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const publicJwk = publicKey.export({format: 'jwk'});
  const thumbprint = createHash('sha256')
    .update(
      canonicalJson({
        crv: publicJwk.crv,
        kty: publicJwk.kty,
        x: publicJwk.x,
        y: publicJwk.y,
      }),
    )
    .digest('base64url');
  const kid = `local:${thumbprint}`;
  const keySet = {keys: [publicJwkOf(publicJwk, kid)]};
  return {
    kind: 'local',
    currentKid: async () => kid,
    sign: async bytes => ({
      kid,
      signature: cryptoSign('sha256', bytes, {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      }),
    }),
    jwks: async () => structuredClone(keySet),
  };
}

/**
 * The platform's signing key in OpenBao's transit engine (type ecdsa-p256, never exportable), as
 * the extracts seal (extracts/src/seal/sealers.js): the service logs in with its AppRole and has
 * transit sign; the key never leaves the key store. The kid is `<key>:v<version>`; a signature is
 * made with the newest version, and the key set lists the public key of every version. The key
 * set is kept for KEY_SET_TTL_MS (the public keys route must not reach the key store on every
 * request), and read again at once when a signature is made with a version it does not have.
 * @param {{
 *   addr: string,
 *   roleId: string,
 *   secretIdFile: string,
 *   keyName: string,
 *   fetch?: function(string, !Object): !Promise<!Object>,
 *   timeoutMs?: number,
 *   now?: function(): number,
 * }} settings `now`: the time in ms (tests)
 * @return {!Object} a Signer
 */
export function createTransitSigner({
  addr,
  roleId,
  secretIdFile,
  keyName,
  fetch: fetchFn = globalThis.fetch,
  timeoutMs = 5000,
  now = Date.now,
}) {
  const required = [
    [addr, 'BAO_ADDR'],
    [roleId, 'BAO_ROLE_ID'],
    [secretIdFile, 'BAO_SECRET_ID_FILE'],
    [keyName, 'TITLE_SIGNING_KEY'],
  ];
  for (const [value, setting] of required) {
    if (!value) {
      throw new Error(
        `The platform signing key is in OpenBao: ${setting} is required`,
      );
    }
  }
  const base = addr.replace(/\/+$/, '');
  const kidPrefix = `${keyName}:v`;
  let token = null;
  let renewAt = 0;
  /** @type {?{keys: !Array<!Object>, latest: number, at: number}} the key set last read */
  let keySet = null;

  /**
   * One request to OpenBao; any failure becomes a 503 naming no tool.
   * @param {string} method
   * @param {string} path below /v1/
   * @param {?Object} body
   * @param {?string} withToken
   * @return {!Promise<!Object>} the answer's JSON
   */
  async function call(method, path, body, withToken) {
    const headers = {'Content-Type': 'application/json'};
    if (withToken) {
      headers['X-Vault-Token'] = withToken;
    }
    const init = {method, headers, signal: AbortSignal.timeout(timeoutMs)};
    if (body) {
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchFn(`${base}/v1/${path}`, init);
    } catch (error) {
      throw signingFailed(
        new Error(`OpenBao is unreachable (${error.message})`),
      );
    }
    let json;
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    if (!res.ok) {
      const detail = (json.errors ?? []).join('; ') || 'no detail';
      const error = signingFailed(
        new Error(`OpenBao answered ${res.status} for ${path}: ${detail}`),
      );
      error.vaultStatus = res.status;
      throw error;
    }
    return json;
  }

  /**
   * Logs in with the AppRole, keeping the token for 3/4 of its lifetime.
   * @return {!Promise<void>}
   */
  async function login() {
    let secretId;
    try {
      secretId = (await readFile(secretIdFile, 'utf8')).trim();
    } catch (error) {
      throw signingFailed(
        new Error(
          `The OpenBao secret ID cannot be read (${error.code}): ${secretIdFile}`,
        ),
      );
    }
    const {auth} = await call(
      'POST',
      'auth/approle/login',
      {role_id: roleId, secret_id: secretId},
      null,
    );
    if (typeof auth?.client_token !== 'string') {
      throw signingFailed(new Error('The OpenBao login answered no token'));
    }
    token = auth.client_token;
    // log in again after 3/4 of the token's lifetime
    renewAt = now() + (auth.lease_duration ?? 0) * 750;
  }

  /**
   * A call with a valid token; one fresh login when OpenBao refuses the token.
   * @param {string} method
   * @param {string} path
   * @param {?Object} [body]
   * @return {!Promise<!Object>}
   */
  async function authed(method, path, body = null) {
    if (!token || now() > renewAt) {
      await login();
    }
    try {
      return await call(method, path, body, token);
    } catch (error) {
      if (error.vaultStatus !== 403) {
        throw error;
      }
      await login();
      return call(method, path, body, token);
    }
  }

  /**
   * The public key of every version of the key, as JWKs, oldest first.
   * @param {!Object} data the key's description from transit/keys
   * @return {!Array<!Object>}
   */
  function jwksOf(data) {
    const keys = [];
    const versions = Object.keys(data.keys ?? {})
      .map(Number)
      .filter(version => Number.isInteger(version) && version > 0)
      .sort((a, b) => a - b);
    for (const version of versions) {
      const pem = data.keys[String(version)]?.public_key;
      if (pem) {
        const publicJwk = createPublicKey(pem).export({format: 'jwk'});
        keys.push(publicJwkOf(publicJwk, `${kidPrefix}${version}`));
      }
    }
    return keys;
  }

  /**
   * The key's description (its type, latest version and the public key of every version), read
   * now; the key set kept is renewed with it.
   * @return {!Promise<!Object>}
   */
  async function keyData() {
    const {data} = await authed('GET', `transit/keys/${keyName}`);
    if (data?.type !== 'ecdsa-p256') {
      throw signingFailed(
        new Error(`OpenBao key ${keyName} is ${data?.type}, not ecdsa-p256`),
      );
    }
    keySet = {keys: jwksOf(data), latest: data.latest_version, at: now()};
    return data;
  }

  /**
   * The key version of a kid of this key, or 0 when it is not one.
   * @param {string} kid
   * @return {number}
   */
  function versionOf(kid) {
    if (typeof kid !== 'string' || !kid.startsWith(kidPrefix)) {
      return 0;
    }
    const version = Number(kid.slice(kidPrefix.length));
    return Number.isInteger(version) && version > 0 ? version : 0;
  }

  return {
    kind: 'bao',
    async currentKid() {
      const data = await keyData();
      return `${kidPrefix}${data.latest_version}`;
    },
    async sign(bytes, {kid} = {}) {
      let version = versionOf(kid);
      if (version === 0) {
        version = (await keyData()).latest_version;
      }
      const {data} = await authed('POST', `transit/sign/${keyName}`, {
        input: Buffer.from(bytes).toString('base64'),
        hash_algorithm: 'sha2-256',
        marshaling_algorithm: 'jws',
        key_version: version,
      });
      const match = /^vault:v(\d+):([A-Za-z0-9_-]+)$/.exec(
        data?.signature ?? '',
      );
      if (!match || Number(match[1]) !== version) {
        throw signingFailed(
          new Error(`OpenBao answered an unexpected signature for ${keyName}`),
        );
      }
      if (keySet === null || keySet.latest < version) {
        // a version the key set kept does not list: read it again, so it can be verified at once
        await keyData();
      }
      return {
        kid: `${kidPrefix}${version}`,
        signature: Buffer.from(match[2], 'base64url'),
      };
    },
    async jwks() {
      if (keySet === null || now() - keySet.at >= KEY_SET_TTL_MS) {
        await keyData();
      }
      return {keys: structuredClone(keySet.keys)};
    },
  };
}

/**
 * The platform signer of the settings (README of the service that signs):
 *   TITLE_SIGNER   'bao': the key in OpenBao's transit engine (BAO_ADDR, BAO_ROLE_ID,
 *                  BAO_SECRET_ID_FILE, TITLE_SIGNING_KEY); not set: an in-process key outside
 *                  production, none in production (signing is then refused)
 * @param {!Object<string, (string|undefined)>} [env]
 * @return {!Promise<?Object>} a Signer, or null
 */
export async function signerFromEnv(env = process.env) {
  const choice = env.TITLE_SIGNER;
  if (choice === undefined || choice === '') {
    if (env.NODE_ENV === 'production') {
      return null;
    }
    return createLocalSigner();
  }
  if (choice !== 'bao') {
    throw new Error('TITLE_SIGNER must be bao or not set');
  }
  return createTransitSigner({
    addr: env.BAO_ADDR,
    roleId: env.BAO_ROLE_ID,
    secretIdFile: env.BAO_SECRET_ID_FILE,
    keyName: env.TITLE_SIGNING_KEY,
  });
}
