import {
  createECDH,
  createHash,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** The order of the P-256 curve: ECDSA's arithmetic is modulo this number. */
const P256_ORDER = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);

/**
 * `base` to the power `exponent`, modulo `modulus`.
 * @param {bigint} base
 * @param {bigint} exponent
 * @param {bigint} modulus
 * @return {bigint}
 */
function powMod(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * A big integer as 32 bytes, big-endian.
 * @param {bigint} value
 * @return {!Buffer}
 */
function bytes32(value) {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

/**
 * An ECDSA P-256 signature of a SHA-256 digest (the digest itself, not hashed again), as OpenBao's
 * transit engine makes it: r and s, 32 bytes each.
 * @param {!Buffer} digest
 * @param {bigint} d the private key
 * @return {{r: !Buffer, s: !Buffer}}
 */
function signDigest(digest, d) {
  const e = BigInt(`0x${digest.toString('hex')}`);
  for (;;) {
    const k =
      (BigInt(`0x${randomBytes(32).toString('hex')}`) % (P256_ORDER - 1n)) + 1n;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(bytes32(k));
    const point = ecdh.getPublicKey();
    const r = BigInt(`0x${point.subarray(1, 33).toString('hex')}`) % P256_ORDER;
    if (r === 0n) {
      continue;
    }
    const kInverse = powMod(k, P256_ORDER - 2n, P256_ORDER);
    const s = (kInverse * ((e + r * d) % P256_ORDER)) % P256_ORDER;
    if (s === 0n) {
      continue;
    }
    return {r: bytes32(r), s: bytes32(s)};
  }
}

/**
 * One DER INTEGER of a 32-byte unsigned number.
 * @param {!Buffer} value
 * @return {!Buffer}
 */
function derInteger(value) {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) {
    start += 1;
  }
  let body = value.subarray(start);
  if (body[0] & 0x80) {
    body = Buffer.concat([Buffer.from([0]), body]);
  }
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

/**
 * A stand-in for OpenBao's transit engine with one ecdsa-p256 key, answering as OpenBao does:
 * AppRole login, `GET transit/keys/<key>` (the public key of every version) and
 * `POST transit/sign/<key>` (`vault:v<version>:<signature>`, ASN.1 by default or JWS-style with
 * `marshaling_algorithm: 'jws'`; the input prehashed or not). `rotate()` adds a new version, as
 * `transit/keys/<key>/rotate` does. Every request is in `calls`, every sign body in `signed`.
 * @param {{keyName?: string}} [options]
 * @return {{
 *   fetch: function(string, object): !Promise<object>,
 *   rotate: function(): number,
 *   latest: function(): number,
 *   publicKeyPem: function(number): string,
 *   calls: !Array<string>,
 *   signed: !Array<object>,
 *   settings: {addr: string, roleId: string, secretIdFile: string, keyName: string},
 *   unreachable: boolean,
 * }}
 */
export function createFakeOpenBao({keyName = 'title-signing'} = {}) {
  /** @type {!Map<number, {d: bigint, publicKeyPem: string}>} */
  const versions = new Map();
  const token = 'fake-token';
  const secretIdFile = join(
    tmpdir(),
    `fake-openbao-secret-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  writeFileSync(secretIdFile, 'fake-secret-id\n');

  const bao = {
    calls: [],
    signed: [],
    unreachable: false,
    settings: {
      addr: 'http://openbao.test:8200',
      roleId: 'fake-role',
      secretIdFile,
      keyName,
    },
    latest: () => versions.size,
    publicKeyPem: version => versions.get(version).publicKeyPem,
    rotate() {
      const {publicKey, privateKey} = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
      });
      const d = BigInt(
        `0x${Buffer.from(privateKey.export({format: 'jwk'}).d, 'base64url').toString('hex')}`,
      );
      versions.set(versions.size + 1, {
        d,
        publicKeyPem: publicKey.export({type: 'spki', format: 'pem'}),
      });
      return versions.size;
    },
    fetch: async (url, init = {}) => {
      if (bao.unreachable) {
        throw new Error('connect ECONNREFUSED');
      }
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';
      bao.calls.push(`${method} ${path}`);
      const body = init.body ? JSON.parse(init.body) : {};
      const headers = new Headers(init.headers ?? {});
      const answer = (status, json) => ({
        ok: status < 300,
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
      });
      if (method === 'POST' && path === '/v1/auth/approle/login') {
        if (
          body.role_id !== 'fake-role' ||
          body.secret_id !== 'fake-secret-id'
        ) {
          return answer(400, {errors: ['invalid role or secret ID']});
        }
        return answer(200, {
          auth: {client_token: token, lease_duration: 3600, renewable: true},
        });
      }
      if (headers.get('x-vault-token') !== token) {
        return answer(403, {errors: ['permission denied']});
      }
      if (method === 'GET' && path === `/v1/transit/keys/${keyName}`) {
        const keys = {};
        for (const [version, key] of versions) {
          keys[String(version)] = {
            public_key: key.publicKeyPem,
            name: 'P-256',
            creation_time: '2026-11-14T08:00:00Z',
          };
        }
        return answer(200, {
          data: {
            name: keyName,
            type: 'ecdsa-p256',
            latest_version: versions.size,
            min_decryption_version: 1,
            exportable: false,
            keys,
          },
        });
      }
      if (method === 'POST' && path === `/v1/transit/sign/${keyName}`) {
        bao.signed.push(body);
        const version = body.key_version || versions.size;
        if (!versions.has(version)) {
          return answer(400, {errors: ['invalid key version']});
        }
        const algorithm = body.hash_algorithm ?? 'sha2-256';
        if (algorithm !== 'sha2-256') {
          return answer(400, {errors: [`unsupported hash ${algorithm}`]});
        }
        const input = Buffer.from(body.input ?? '', 'base64');
        const digest = body.prehashed
          ? input
          : createHash('sha256').update(input).digest();
        const {r, s} = signDigest(digest, versions.get(version).d);
        let encoded;
        if (body.marshaling_algorithm === 'jws') {
          encoded = Buffer.concat([r, s]).toString('base64url');
        } else {
          const sequence = Buffer.concat([derInteger(r), derInteger(s)]);
          encoded = Buffer.concat([
            Buffer.from([0x30, sequence.length]),
            sequence,
          ]).toString('base64');
        }
        return answer(200, {
          data: {
            signature: `vault:v${version}:${encoded}`,
            key_version: version,
          },
        });
      }
      return answer(404, {errors: []});
    },
  };
  bao.rotate();
  return bao;
}
