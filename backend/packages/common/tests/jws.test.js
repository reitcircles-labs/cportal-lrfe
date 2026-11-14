import {createPublicKey, generateKeyPairSync, verify} from 'node:crypto';

import {expect} from 'chai';

import {
  canonicalJson,
  createLocalSigner,
  createTransitSigner,
  signJws,
  signerFromEnv,
  verifyJws,
} from '../src/index.js';
import {createFakeOpenBao} from './fake-openbao.js';

/** The JWS type of a chain-of-title entry (CB-32). */
const TYP = 'lrfe-title-entry';

/** A payload as a chain-of-title entry looks, with nested data and a name from outside. */
const PAYLOAD = {
  recordId: 'rec-1',
  seq: 1,
  command: 'issue',
  actor: {id: 'u-1', name: 'Anna Shikongo', org: 'org-carrier'},
  from: null,
  to: 'org-shipper',
  endorsement: 'none',
  documentHash: 'a'.repeat(64),
  at: '2026-11-14T08:01:00.000Z',
  previousHash: null,
  kid: 'title-signing:v1',
  toString: 'a name from outside',
};

/**
 * The three parts of a compact JWS, the header and payload decoded.
 * @param {string} jws
 * @return {{header: object, payloadText: string, signature: !Buffer, signingInput: string}}
 */
function partsOf(jws) {
  const [header, payload, signature] = jws.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payloadText: Buffer.from(payload, 'base64url').toString('utf8'),
    signature: Buffer.from(signature, 'base64url'),
    signingInput: `${header}.${payload}`,
  };
}

/**
 * A compact JWS with one part replaced.
 * @param {string} jws
 * @param {number} index 0 header, 1 payload, 2 signature
 * @param {string} part the new part, base64url
 * @return {string}
 */
function withPart(jws, index, part) {
  const parts = jws.split('.');
  parts[index] = part;
  return parts.join('.');
}

/**
 * JSON as a JWS part: base64url of its text.
 * @param {*} value
 * @return {string}
 */
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * The error a call throws or a promise rejects with.
 * @param {function(): *} fn
 * @return {Promise<!Error>}
 */
async function thrown(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Nothing was thrown');
}

/**
 * The transit signer on a stand-in OpenBao.
 * @param {object} bao createFakeOpenBao's answer
 * @return {object}
 */
function transitOn(bao) {
  return createTransitSigner({...bao.settings, fetch: bao.fetch});
}

describe('signed JSON (JWS, ES256) for the chain of title (CB-32)', () => {
  let signer;
  let jwks;
  before(async () => {
    signer = await createLocalSigner();
    jwks = await signer.jwks();
  });

  describe('signJws', () => {
    it('makes a compact JWS: header {alg ES256, kid, typ}, the canonical JSON as payload', async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      expect(jws).to.be.a('string');
      expect(jws.split('.')).to.have.length(3);
      expect(jws).to.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const {header, payloadText} = partsOf(jws);
      expect(header).to.deep.equal({
        alg: 'ES256',
        kid: jwks.keys[0].kid,
        typ: TYP,
      });
      expect(payloadText).to.equal(canonicalJson(PAYLOAD));
    });

    it('signs with an IEEE P1363 signature (r and s, 64 bytes) any ES256 verifier accepts', async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      const {signature, signingInput} = partsOf(jws);
      expect(signature).to.have.length(64);
      const key = createPublicKey({key: jwks.keys[0], format: 'jwk'});
      const valid = verify(
        'sha256',
        Buffer.from(signingInput),
        {key, dsaEncoding: 'ieee-p1363'},
        signature,
      );
      expect(valid).to.equal(true);
    });

    it('gives the same payload for the same data, whatever the order of its keys', async () => {
      const reordered = Object.fromEntries(Object.entries(PAYLOAD).reverse());
      const first = partsOf(await signJws(PAYLOAD, signer, {typ: TYP}));
      const second = partsOf(await signJws(reordered, signer, {typ: TYP}));
      expect(second.payloadText).to.equal(first.payloadText);
    });
  });

  describe('verifyJws', () => {
    it('answers the payload of a valid JWS', async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      expect(await verifyJws(jws, jwks)).to.deep.equal(PAYLOAD);
    });

    it('refuses a JWS whose payload was changed', async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      const changed = withPart(jws, 1, b64({...PAYLOAD, to: 'org-stranger'}));
      expect(await thrown(() => verifyJws(changed, jwks))).to.be.instanceOf(
        Error,
      );
    });

    it('refuses a JWS whose signature was changed', async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      const signature = partsOf(jws).signature;
      signature[10] ^= 0xff;
      const changed = withPart(jws, 2, signature.toString('base64url'));
      expect(await thrown(() => verifyJws(changed, jwks))).to.be.instanceOf(
        Error,
      );
    });

    it("refuses a JWS signed with another key under the platform key's kid", async () => {
      const other = generateKeyPairSync('ec', {namedCurve: 'P-256'});
      const forgedJwks = {
        keys: [
          {
            ...other.publicKey.export({format: 'jwk'}),
            kid: jwks.keys[0].kid,
            alg: 'ES256',
          },
        ],
      };
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      expect(await thrown(() => verifyJws(jws, forgedJwks))).to.be.instanceOf(
        Error,
      );
    });

    it('refuses a JWS whose kid is in no key of the set, and an empty set', async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      const header = partsOf(jws).header;
      for (const kid of [
        'unknown:v9',
        'toString',
        '__proto__',
        'constructor',
      ]) {
        const changed = withPart(jws, 0, b64({...header, kid}));
        expect(
          await thrown(() => verifyJws(changed, jwks)),
          kid,
        ).to.be.instanceOf(Error);
      }
      expect(await thrown(() => verifyJws(jws, {keys: []}))).to.be.instanceOf(
        Error,
      );
    });

    it('refuses another algorithm than ES256, among them "none" and HS256', async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      const header = partsOf(jws).header;
      const none = `${b64({...header, alg: 'none'})}.${jws.split('.')[1]}.`;
      expect(await thrown(() => verifyJws(none, jwks))).to.be.instanceOf(Error);
      for (const alg of ['HS256', 'ES384', 'RS256']) {
        const changed = withPart(jws, 0, b64({...header, alg}));
        expect(
          await thrown(() => verifyJws(changed, jwks)),
          alg,
        ).to.be.instanceOf(Error);
      }
    });

    it('refuses what is not a compact JWS', async () => {
      for (const bad of [
        '',
        'abc',
        'a.b',
        'a.b.c.d',
        '...',
        null,
        undefined,
        42,
        {},
      ]) {
        expect(
          await thrown(() => verifyJws(bad, jwks)),
          String(bad),
        ).to.be.instanceOf(Error);
      }
    });
  });

  describe('the local signer (dev and e2e)', () => {
    it('publishes its P-256 public key with its kid, never the private part', async () => {
      expect(signer.kind).to.equal('local');
      expect(jwks.keys).to.have.length(1);
      const [key] = jwks.keys;
      expect(key).to.include({kty: 'EC', crv: 'P-256', alg: 'ES256'});
      expect(key.kid).to.be.a('string').and.not.equal('');
      expect(key.x).to.be.a('string');
      expect(key.y).to.be.a('string');
      expect(key).to.not.have.property('d');
    });

    it("signs JWSs that verify with the key set of that signer and no other signer's", async () => {
      const jws = await signJws(PAYLOAD, signer, {typ: TYP});
      expect(await verifyJws(jws, await signer.jwks())).to.deep.equal(PAYLOAD);
      const another = await createLocalSigner();
      const anotherKeys = (await another.jwks()).keys.map(k => ({
        ...k,
        kid: jwks.keys[0].kid,
      }));
      const error = await thrown(() => verifyJws(jws, {keys: anotherKeys}));
      expect(error).to.be.instanceOf(Error);
    });
  });

  describe('the transit signer (OpenBao, ecdsa-p256)', () => {
    it('needs its settings, naming the one missing', async () => {
      const bao = createFakeOpenBao();
      const cases = [
        ['addr', 'BAO_ADDR'],
        ['roleId', 'BAO_ROLE_ID'],
        ['secretIdFile', 'BAO_SECRET_ID_FILE'],
        ['keyName', 'TITLE_SIGNING_KEY'],
      ];
      for (const [option, setting] of cases) {
        const settings = {...bao.settings, fetch: bao.fetch};
        delete settings[option];
        const error = await thrown(() => createTransitSigner(settings));
        expect(error.message, option).to.include(`${setting} is required`);
      }
    });

    it('signs with the newest key version through transit, kid "<key>:v<version>"', async () => {
      const bao = createFakeOpenBao({keyName: 'title-signing'});
      const transit = transitOn(bao);
      expect(transit.kind).to.equal('bao');
      const jws = await signJws(PAYLOAD, transit, {typ: TYP});
      expect(partsOf(jws).header).to.deep.equal({
        alg: 'ES256',
        kid: 'title-signing:v1',
        typ: TYP,
      });
      expect(partsOf(jws).signature).to.have.length(64);
      expect(bao.calls).to.include('POST /v1/auth/approle/login');
      expect(bao.calls).to.include('POST /v1/transit/sign/title-signing');
      expect(await verifyJws(jws, await transit.jwks())).to.deep.equal(PAYLOAD);
    });

    it('publishes the public key of every version from transit/keys, as JWKs with their kid', async () => {
      const bao = createFakeOpenBao({keyName: 'title-signing'});
      bao.rotate();
      const transit = transitOn(bao);
      const set = await transit.jwks();
      expect(bao.calls).to.include('GET /v1/transit/keys/title-signing');
      const kids = set.keys.map(k => k.kid).sort();
      expect(kids).to.deep.equal(['title-signing:v1', 'title-signing:v2']);
      for (const key of set.keys) {
        const version = Number(key.kid.split(':v')[1]);
        const expected = createPublicKey(bao.publicKeyPem(version)).export({
          format: 'jwk',
        });
        expect(key, key.kid).to.include({
          kty: 'EC',
          crv: 'P-256',
          alg: 'ES256',
          x: expected.x,
          y: expected.y,
        });
        expect(key, key.kid).to.not.have.property('d');
      }
    });

    it('keeps old JWSs verifiable after a key rotation, and signs new ones with the new version', async () => {
      const bao = createFakeOpenBao({keyName: 'title-signing'});
      const transit = transitOn(bao);
      const before = await signJws(PAYLOAD, transit, {typ: TYP});
      bao.rotate();
      const after = await signJws({...PAYLOAD, seq: 2}, transit, {typ: TYP});
      expect(partsOf(before).header.kid).to.equal('title-signing:v1');
      expect(partsOf(after).header.kid).to.equal('title-signing:v2');
      const set = await transit.jwks();
      expect(await verifyJws(before, set)).to.deep.equal(PAYLOAD);
      expect(await verifyJws(after, set)).to.deep.equal({...PAYLOAD, seq: 2});
      // a JWS of version 2 presented as version 1 does not verify
      const relabelled = withPart(
        after,
        0,
        b64({...partsOf(after).header, kid: 'title-signing:v1'}),
      );
      expect(await thrown(() => verifyJws(relabelled, set))).to.be.instanceOf(
        Error,
      );
    });

    it('fails with a 503 naming no tool when the key store cannot be reached', async () => {
      const bao = createFakeOpenBao();
      const transit = transitOn(bao);
      bao.unreachable = true;
      const error = await thrown(() => signJws(PAYLOAD, transit, {typ: TYP}));
      expect(error.statusCode).to.equal(503);
      expect(error.message).to.not.match(/bao|vault|transit/i);
    });

    it('fails with a 503 naming no tool when the login answers without a token', async () => {
      const bao = createFakeOpenBao();
      const transit = createTransitSigner({
        ...bao.settings,
        fetch: async (url, init) => {
          if (new URL(url).pathname === '/v1/auth/approle/login') {
            return {ok: true, status: 200, json: async () => ({})};
          }
          return bao.fetch(url, init);
        },
      });
      const error = await thrown(() => signJws(PAYLOAD, transit, {typ: TYP}));
      expect(error.statusCode).to.equal(503);
      expect(error.message).to.not.match(/bao|vault|transit/i);
    });

    it('reads the key set from the key store at most once in 5 minutes', async () => {
      const bao = createFakeOpenBao({keyName: 'title-signing'});
      let now = Date.parse('2026-11-14T08:00:00Z');
      const transit = createTransitSigner({
        ...bao.settings,
        fetch: bao.fetch,
        now: () => now,
      });
      const keyReads = () =>
        bao.calls.filter(c => c === 'GET /v1/transit/keys/title-signing')
          .length;
      const first = await transit.jwks();
      now += 4 * 60 * 1000;
      const second = await transit.jwks();
      expect(keyReads()).to.equal(1);
      expect(second).to.deep.equal(first);
      now += 2 * 60 * 1000;
      await transit.jwks();
      expect(keyReads()).to.equal(2);
    });

    it('lists a new key version at once after signing with it, cache or not', async () => {
      const bao = createFakeOpenBao({keyName: 'title-signing'});
      const transit = transitOn(bao);
      expect((await transit.jwks()).keys.map(k => k.kid)).to.deep.equal([
        'title-signing:v1',
      ]);
      bao.rotate();
      const jws = await signJws(PAYLOAD, transit, {typ: TYP});
      const set = await transit.jwks();
      expect(set.keys.map(k => k.kid).sort()).to.deep.equal([
        'title-signing:v1',
        'title-signing:v2',
      ]);
      expect(await verifyJws(jws, set)).to.deep.equal(PAYLOAD);
    });
  });

  describe('signerFromEnv', () => {
    it('gives the local signer outside production when TITLE_SIGNER is not set', async () => {
      for (const env of [{}, {NODE_ENV: 'development'}, {NODE_ENV: 'test'}]) {
        const fromEnv = await signerFromEnv(env);
        expect(fromEnv.kind, JSON.stringify(env)).to.equal('local');
      }
    });

    it('gives no signer in production when TITLE_SIGNER is not set (title commands are then refused)', async () => {
      expect(await signerFromEnv({NODE_ENV: 'production'})).to.equal(null);
    });

    it('gives the transit signer with TITLE_SIGNER=bao, in production too', async () => {
      const bao = createFakeOpenBao();
      const env = {
        TITLE_SIGNER: 'bao',
        BAO_ADDR: bao.settings.addr,
        BAO_ROLE_ID: bao.settings.roleId,
        BAO_SECRET_ID_FILE: bao.settings.secretIdFile,
        TITLE_SIGNING_KEY: 'title-signing',
      };
      expect((await signerFromEnv(env)).kind).to.equal('bao');
      expect(
        (await signerFromEnv({...env, NODE_ENV: 'production'})).kind,
      ).to.equal('bao');
      const missing = {...env};
      delete missing.BAO_ADDR;
      const error = await thrown(() => signerFromEnv(missing));
      expect(error.message).to.include('BAO_ADDR is required');
    });

    it('refuses another value of TITLE_SIGNER', async () => {
      for (const value of ['yes', 'local', 'toString']) {
        const error = await thrown(() => signerFromEnv({TITLE_SIGNER: value}));
        expect(error.message, value).to.include(
          'TITLE_SIGNER must be bao or not set',
        );
      }
    });
  });
});
