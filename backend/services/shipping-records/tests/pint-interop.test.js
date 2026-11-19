import {createEventBus, createLocalSigner, signJws} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';

import {buildApp} from '../src/app.js';
import {ShippingRecordsService} from '../src/records.service.js';
import {TitleService} from '../src/title.service.js';
import {
  NOTHING_ANCHORED,
  SECRET,
  exampleWithReference,
  makeClock,
  staffOf,
  stores,
  titleCommand,
  titleOk,
} from './helpers.js';

/**
 * CB-55: Cross-platform eBL transfers (DCSA PINT).
 *
 * Interfaces expected by these tests (from B_L Cross-Platform Transfer.html and the CB-55 brief):
 * - TitleService options: `{platformCode, fetchImpl}` for outgoing PINT calls (`fetchImpl` defaults
 *   to `globalThis.fetch`).
 * - Platform directory:
 *   - `GET /records/platforms` (authenticated; excludes suspended platforms for trade users)
 *   - `POST /records/platforms` (requires `admin.organisations`, `{code, name, baseUrl, jwks}`, 201)
 *   - `POST /records/platforms/:code/suspend` and `POST /records/platforms/:code/reactivate`
 *     (requires `admin.organisations`, 404 for unknown / prototype-key codes)
 * - PINT endpoints:
 *   - `GET /records/pint/parties?partyCode=...` (incoming lookup: 200 `{partyName}` for active
 *     admitted orgs only; 404 for unknown, suspended, operator, or prototype-key names)
 *   - `GET /records/pint/lookup-party?platform=...&partyCode=...` (authenticated outgoing lookup)
 *   - `POST /records/:id/title/transfer-out` (`{platform, partyCode, inBlank?}`)
 *   - `POST /records/:id/title/retry-transfer` (resends the exact same envelope while
 *     `transfer-pending`)
 *   - `POST /records/:id/title/accept-incoming` (`arrived` -> `with-holder`)
 *   - `POST /records/pint/transfers` (incoming PINT envelope -> `RECE`/`DUPE`/`BSIG`/`BENV`,
 *     403/BENV for suspended peer, 409 for already-active duplicate B/L)
 */

const ADMIN_PERMS = ['admin.organisations', 'bl.read'];
const OPERATOR = 'org-operator';
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';
const STRANGER = 'org-stranger';
const SUSPENDED = 'org-suspended';
const UNKNOWN = 'org-unknown';

const PEER_CARRIER = 'org-peer-carrier';
const PEER_BANK = 'org-peer-bank';
const PEER_BUYER = 'org-peer-buyer';

let refCounter = 0;

/**
 * Unique DCSA transport document reference (max 20 chars).
 *
 * @param {string} tag
 * @return {string}
 */
function nextRef(tag) {
  refCounter += 1;
  const suffix = `-${refCounter}`;
  return `CB55-${tag}`.slice(0, 20 - suffix.length) + suffix;
}

/**
 * Unique platform code per test so PostgreSQL runs never collide across tests.
 *
 * @param {string} prefix
 * @return {string}
 */
function nextPlatformCode(prefix) {
  refCounter += 1;
  return `${prefix}-${refCounter}`;
}

/**
 * Stand-in identity client supporting `standingOf`, `nameOf` and `activeOrganisations`.
 *
 * @param {!Array<{id: string, name: string, code?: string}>} activeOrgs
 * @param {{suspended?: !Array<string>, operator?: ?string}} [extra]
 * @return {object}
 */
function makeIdentity(activeOrgs, {suspended = [], operator = OPERATOR} = {}) {
  const byId = new Map(
    activeOrgs.map(org => [org.id, {code: org.code ?? org.id, ...org}]),
  );
  const suspendedSet = new Set(suspended);
  return {
    async standingOf(id) {
      if (id === operator) {
        return 'operator';
      }
      if (suspendedSet.has(id)) {
        return 'inactive';
      }
      return byId.has(id) ? 'active' : 'unknown';
    },
    async nameOf(id) {
      return byId.get(id)?.name ?? null;
    },
    async activeOrganisations() {
      return [...byId.values()].map(({id, code, name}) => ({id, code, name}));
    },
  };
}

/**
 * Routes `fetchImpl` calls to in-process `shipping-records` peers by URL origin, with an optional
 * hook to capture envelopes or inject refusals and network errors.
 *
 * @param {!Map<string, object>} peersByOrigin
 * @param {?function(object): !Promise<(?Response|undefined)>} [intercept]
 * @return {function(string, object=): !Promise<!Response>}
 */
function createPeerFetch(peersByOrigin, intercept = null) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const peer = peersByOrigin.get(parsed.origin);
    if (!peer) {
      throw new Error(`No peer registered for origin ${parsed.origin}`);
    }
    const path = `${parsed.pathname}${parsed.search}`;
    const method = init.method ?? 'GET';
    const bodyText = typeof init.body === 'string' ? init.body : undefined;
    const payload = bodyText ? JSON.parse(bodyText) : undefined;
    if (intercept) {
      const custom = await intercept({
        origin: parsed.origin,
        method,
        path,
        headers: init.headers ?? {},
        payload,
      });
      if (custom) {
        return custom;
      }
    }
    const res = await peer.app.inject({
      method,
      url: path,
      headers: init.headers ?? {},
      payload,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: {
        'content-type': res.headers['content-type'] ?? 'application/json',
      },
    });
  };
}

/**
 * Builds an in-process `shipping-records` platform instance.
 *
 * @param {object} store
 * @param {{
 *   platformCode: string,
 *   signer: object,
 *   organisations: object,
 *   fetchImpl?: function(string, object=): !Promise<!Response>,
 * }} options
 * @return {!Promise<object>}
 */
async function makePlatform(
  store,
  {platformCode, signer, organisations, fetchImpl},
) {
  const {repo, atomic, close, sequelize} = await store.open();
  const bus = createEventBus({driver: 'memory', source: 'shipping-records'});
  const events = atomic ? {...bus, atomic} : bus;
  const published = [];
  bus.subscribe('*', e => published.push(e));
  const service = new ShippingRecordsService({
    repo,
    events,
    formats: formatsFromSettings({}),
    clock: makeClock(),
  });
  const titles = new TitleService({
    repo,
    events,
    modules: modulesFromSettings({}),
    clock: makeClock(),
    signer,
    audit: NOTHING_ANCHORED,
    organisations,
    platformCode,
    fetchImpl,
  });
  const app = await buildApp({service, titles, jwtSecret: SECRET});
  await app.ready();
  const as = user => ({
    authorization: `Bearer ${app.jwt.sign({
      typ: 'access',
      sub: user.id,
      name: user.name,
      org: user.org,
      perms: user.perms,
    })}`,
  });
  return {
    app,
    service,
    titles,
    repo,
    sequelize,
    published,
    as,
    close: async () => {
      await app.close();
      await close?.();
    },
  };
}

/**
 * Registers `peer` in `host`'s connected platform directory as admin.
 *
 * @param {object} host
 * @param {{code: string, name: string, baseUrl: string, jwks: object}} peer
 * @param {object} adminUser
 * @return {!Promise<object>}
 */
async function registerPlatform(host, peer, adminUser) {
  const res = await host.app.inject({
    method: 'POST',
    url: '/records/platforms',
    headers: host.as(adminUser),
    payload: {
      code: peer.code,
      name: peer.name,
      baseUrl: peer.baseUrl,
      jwks: peer.jwks,
    },
  });
  expect(res.statusCode, `POST /records/platforms: ${res.body}`).to.equal(201);
  return res.json();
}

/**
 * Creates, commits and issues a negotiable B/L on `platform` held by `shipper`.
 *
 * @param {object} platform
 * @param {string} reference
 * @param {{carrier?: string, shipper?: string}} [parties]
 * @return {!Promise<string>}
 */
async function issuedBl(
  platform,
  reference,
  {carrier = CARRIER, shipper = SHIPPER} = {},
) {
  const drafter = {id: `u-${carrier}-1`, name: 'Lena Okafor', org: carrier};
  const approver = {id: `u-${carrier}-2`, name: 'Ravi Menon', org: carrier};
  const record = await platform.service.createRecord(
    {
      format: 'dcsa-3.0',
      document: exampleWithReference(reference),
      partyOrganisations: {shipper},
    },
    drafter,
    carrier,
  );
  await platform.service.submit(record.id, 1, drafter, carrier);
  await platform.service.commit(record.id, 1, {by: approver}, 'bpm');
  await titleOk(platform, record.id, 'issue', staffOf(carrier));
  return record.id;
}

/**
 * Flips the last character of a compact JWS signature segment so verification fails.
 *
 * @param {string} jws
 * @return {string}
 */
function corruptJwsSignature(jws) {
  const parts = jws.split('.');
  expect(parts).to.have.length(3);
  const sig = parts[2];
  const first = sig[0] === 'A' ? 'B' : 'A';
  parts[2] = first + sig.slice(1);
  return parts.join('.');
}

/**
 * Locates the transfer chain array inside an outgoing PINT envelope.
 *
 * @param {object} envelope
 * @return {!Array<*>}
 */
function chainArrayOf(envelope) {
  const chain =
    envelope.envelopeTransferChain ?? envelope.transferChain ?? envelope.chain;
  expect(chain, 'PINT envelope must include a transfer chain array').to.be.an(
    'array',
  );
  expect(chain.length).to.be.greaterThan(0);
  return chain;
}

/**
 * Corrupts the signature of the last entry in an outgoing PINT envelope copy.
 *
 * @param {object} envelope
 * @return {object}
 */
function tamperLastEntrySignature(envelope) {
  const copy = structuredClone(envelope);
  const chain = chainArrayOf(copy);
  const lastIndex = chain.length - 1;
  const entry = chain[lastIndex];
  if (typeof entry === 'string') {
    chain[lastIndex] = corruptJwsSignature(entry);
    return copy;
  }
  if (typeof entry?.signature === 'string') {
    entry.signature = corruptJwsSignature(entry.signature);
    return copy;
  }
  if (typeof entry?.signedContent === 'string') {
    entry.signedContent = corruptJwsSignature(entry.signedContent);
    return copy;
  }
  throw new Error('Could not find JWS signature on transfer chain entry');
}

/**
 * Modifies the first entry (originating from the receiving platform) in a round-trip envelope and
 * re-signs it with `peerSigner` so only the prior-entry byte-for-byte check catches the rewrite.
 *
 * @param {object} envelope
 * @param {object} peerSigner
 * @return {!Promise<object>}
 */
async function tamperPriorEntry(envelope, peerSigner) {
  const copy = structuredClone(envelope);
  const chain = chainArrayOf(copy);
  const first = chain[0];
  if (typeof first === 'string') {
    const [headerB64, payloadB64] = first.split('.');
    const header = JSON.parse(
      Buffer.from(headerB64, 'base64url').toString('utf8'),
    );
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    );
    payload.tampered = true;
    chain[0] = await signJws(payload, peerSigner, {
      typ: header.typ ?? 'lrfe-title-entry',
    });
    return copy;
  }
  if (first && typeof first === 'object') {
    first.tampered = true;
    if (typeof first.signedContent === 'string') {
      const [headerB64] = first.signedContent.split('.');
      const header = JSON.parse(
        Buffer.from(headerB64, 'base64url').toString('utf8'),
      );
      first.signedContent = await signJws(first, peerSigner, {
        typ: header.typ ?? 'lrfe-title-entry',
      });
    } else if (typeof first.signature === 'string') {
      const [headerB64] = first.signature.split('.');
      const header = JSON.parse(
        Buffer.from(headerB64, 'base64url').toString('utf8'),
      );
      const body = {...first};
      delete body.signature;
      delete body.entryHash;
      first.signature = await signJws(body, peerSigner, {
        typ: header.typ ?? 'lrfe-title-entry',
      });
    }
    return copy;
  }
  throw new Error('Could not modify prior chain entry in envelope');
}

/**
 * Extracts the PINT response code (`RECE`, `DUPE`, `BSIG`, `BENV`) from an HTTP response body.
 *
 * @param {object} res
 * @return {?string}
 */
function pintCodeOf(res) {
  try {
    const body = res.json();
    return body.responseCode ?? body.details?.code ?? body.code ?? null;
  } catch {
    return null;
  }
}

for (const store of stores()) {
  describe(`DCSA PINT cross-platform interop (CB-55), ${store.name}`, () => {
    const admin = staffOf(OPERATOR, ADMIN_PERMS);
    const tradeUser = staffOf(BANK, ['bl.read', 'bl.endorse']);

    it('manages the connected platform directory with admin.organisations, suspend/reactivate and prototype-key safety', async () => {
      const signerA = await createLocalSigner();
      const signerB = await createLocalSigner();
      const platform = await makePlatform(store, {
        platformCode: nextPlatformCode('PLAT-A'),
        signer: signerA,
        organisations: makeIdentity([
          {id: CARRIER, name: 'Bluewater Meridian Lines'},
          {id: BANK, name: 'Harbour Trust Bank'},
        ]),
      });
      try {
        const unauthList = await platform.app.inject({
          method: 'GET',
          url: '/records/platforms',
        });
        expect(unauthList.statusCode).to.equal(401);

        const code = nextPlatformCode('MERIDIAN');
        const payload = {
          code,
          name: 'Meridian eBL',
          baseUrl: 'https://meridian.example',
          jwks: await signerB.jwks(),
        };

        const nonAdminCreate = await platform.app.inject({
          method: 'POST',
          url: '/records/platforms',
          headers: platform.as(tradeUser),
          payload,
        });
        expect(nonAdminCreate.statusCode).to.equal(403);

        const created = await registerPlatform(platform, payload, admin);
        expect(created).to.include({code, name: 'Meridian eBL'});

        const duplicate = await platform.app.inject({
          method: 'POST',
          url: '/records/platforms',
          headers: platform.as(admin),
          payload,
        });
        expect(duplicate.statusCode).to.equal(409);

        const activeList = await platform.app.inject({
          method: 'GET',
          url: '/records/platforms',
          headers: platform.as(tradeUser),
        });
        expect(activeList.statusCode).to.equal(200);
        expect(activeList.json().items.map(p => p.code)).to.include(code);

        const nonAdminSuspend = await platform.app.inject({
          method: 'POST',
          url: `/records/platforms/${code}/suspend`,
          headers: platform.as(tradeUser),
        });
        expect(nonAdminSuspend.statusCode).to.equal(403);

        const suspended = await platform.app.inject({
          method: 'POST',
          url: `/records/platforms/${code}/suspend`,
          headers: platform.as(admin),
        });
        expect(suspended.statusCode).to.equal(200);

        const listAfterSuspend = await platform.app.inject({
          method: 'GET',
          url: '/records/platforms',
          headers: platform.as(tradeUser),
        });
        expect(listAfterSuspend.statusCode).to.equal(200);
        expect(listAfterSuspend.json().items.map(p => p.code)).not.to.include(
          code,
        );

        const reactivated = await platform.app.inject({
          method: 'POST',
          url: `/records/platforms/${code}/reactivate`,
          headers: platform.as(admin),
        });
        expect(reactivated.statusCode).to.equal(200);

        const listAfterReactivate = await platform.app.inject({
          method: 'GET',
          url: '/records/platforms',
          headers: platform.as(tradeUser),
        });
        expect(listAfterReactivate.json().items.map(p => p.code)).to.include(
          code,
        );

        for (const key of ['toString', '__proto__', 'constructor']) {
          const suspendBad = await platform.app.inject({
            method: 'POST',
            url: `/records/platforms/${key}/suspend`,
            headers: platform.as(admin),
          });
          expect(suspendBad.statusCode, `suspend ${key}`).to.equal(404);

          const reactivateBad = await platform.app.inject({
            method: 'POST',
            url: `/records/platforms/${key}/reactivate`,
            headers: platform.as(admin),
          });
          expect(reactivateBad.statusCode, `reactivate ${key}`).to.equal(404);

          const createBad = await platform.app.inject({
            method: 'POST',
            url: '/records/platforms',
            headers: platform.as(admin),
            payload: {...payload, code: key},
          });
          expect(createBad.statusCode, `create ${key}`).to.be.oneOf([400, 201]);
          expect({}.toString).to.equal(Object.prototype.toString);
        }
      } finally {
        await platform.close();
      }
    });

    it('GET /records/pint/parties returns only active admitted organisations and 404 for unknown, suspended or operator', async () => {
      const platform = await makePlatform(store, {
        platformCode: nextPlatformCode('PLAT-A'),
        signer: await createLocalSigner(),
        organisations: makeIdentity(
          [{id: BUYER, name: 'Roastery Collective Imports'}],
          {suspended: [SUSPENDED], operator: OPERATOR},
        ),
      });
      try {
        const active = await platform.app.inject({
          method: 'GET',
          url: `/records/pint/parties?partyCode=${BUYER}`,
        });
        expect(active.statusCode, active.body).to.equal(200);
        expect(active.json()).to.include({
          partyName: 'Roastery Collective Imports',
        });

        for (const id of [
          UNKNOWN,
          SUSPENDED,
          OPERATOR,
          'toString',
          '__proto__',
          'constructor',
        ]) {
          const res = await platform.app.inject({
            method: 'GET',
            url: `/records/pint/parties?partyCode=${id}`,
          });
          expect(res.statusCode, id).to.equal(404);
        }
      } finally {
        await platform.close();
      }
    });

    it('looks up a party on a connected peer via GET /records/pint/lookup-party and refuses unknown, suspended or unreachable peers', async () => {
      const signerA = await createLocalSigner();
      const signerB = await createLocalSigner();
      const codeA = nextPlatformCode('PLAT-A');
      const codeB = nextPlatformCode('PLAT-B');
      const peers = new Map();
      let peerDown = false;

      const platformA = await makePlatform(store, {
        platformCode: codeA,
        signer: signerA,
        organisations: makeIdentity([
          {id: CARRIER, name: 'Bluewater Meridian Lines'},
          {id: BANK, name: 'Harbour Trust Bank'},
        ]),
        fetchImpl: createPeerFetch(peers, async () => {
          if (peerDown) {
            throw new Error('ECONNREFUSED');
          }
          return undefined;
        }),
      });
      const platformB = await makePlatform(store, {
        platformCode: codeB,
        signer: signerB,
        organisations: makeIdentity(
          [{id: PEER_BANK, name: 'Banco Atlântico Ghana Ltd'}],
          {suspended: [SUSPENDED]},
        ),
      });
      peers.set('https://plat-b.example', platformB);

      try {
        await registerPlatform(
          platformA,
          {
            code: codeB,
            name: 'Meridian eBL',
            baseUrl: 'https://plat-b.example',
            jwks: await signerB.jwks(),
          },
          admin,
        );

        const unauth = await platformA.app.inject({
          method: 'GET',
          url: `/records/pint/lookup-party?platform=${codeB}&partyCode=${PEER_BANK}`,
        });
        expect(unauth.statusCode).to.equal(401);

        const found = await platformA.app.inject({
          method: 'GET',
          url: `/records/pint/lookup-party?platform=${codeB}&partyCode=${PEER_BANK}`,
          headers: platformA.as(tradeUser),
        });
        expect(found.statusCode, found.body).to.equal(200);
        expect(found.json()).to.include({
          partyName: 'Banco Atlântico Ghana Ltd',
        });

        for (const missingParty of [UNKNOWN, SUSPENDED]) {
          const notFound = await platformA.app.inject({
            method: 'GET',
            url: `/records/pint/lookup-party?platform=${codeB}&partyCode=${missingParty}`,
            headers: platformA.as(tradeUser),
          });
          expect(notFound.statusCode, missingParty).to.equal(404);
        }

        for (const badPlatform of ['NOPE', 'toString', '__proto__']) {
          const res = await platformA.app.inject({
            method: 'GET',
            url: `/records/pint/lookup-party?platform=${badPlatform}&partyCode=${PEER_BANK}`,
            headers: platformA.as(tradeUser),
          });
          expect(res.statusCode, badPlatform).to.be.oneOf([404, 409]);
        }

        peerDown = true;
        const unreachable = await platformA.app.inject({
          method: 'GET',
          url: `/records/pint/lookup-party?platform=${codeB}&partyCode=${PEER_BANK}`,
          headers: platformA.as(tradeUser),
        });
        expect(unreachable.statusCode).to.be.oneOf([502, 503]);
        peerDown = false;

        await platformA.app.inject({
          method: 'POST',
          url: `/records/platforms/${codeB}/suspend`,
          headers: platformA.as(admin),
        });
        const suspendedPeer = await platformA.app.inject({
          method: 'GET',
          url: `/records/pint/lookup-party?platform=${codeB}&partyCode=${PEER_BANK}`,
          headers: platformA.as(tradeUser),
        });
        expect(suspendedPeer.statusCode).to.be.oneOf([404, 409]);
      } finally {
        await platformA.close();
        await platformB.close();
      }
    });

    it('happy outgoing transfer moves to transferred-out on RECE, preserves read-only chain and shows held on peer to carrier', async () => {
      const signerA = await createLocalSigner();
      const signerB = await createLocalSigner();
      const codeA = nextPlatformCode('PLAT-A');
      const codeB = nextPlatformCode('PLAT-B');
      const peers = new Map();

      const platformA = await makePlatform(store, {
        platformCode: codeA,
        signer: signerA,
        organisations: makeIdentity([
          {id: CARRIER, name: 'Bluewater Meridian Lines'},
          {id: SHIPPER, name: 'Highland Coffee Exporters'},
          {id: BANK, name: 'Harbour Trust Bank'},
        ]),
        fetchImpl: createPeerFetch(peers),
      });
      const platformB = await makePlatform(store, {
        platformCode: codeB,
        signer: signerB,
        organisations: makeIdentity([
          {id: PEER_BANK, name: 'Banco Atlântico Ghana Ltd'},
        ]),
        fetchImpl: createPeerFetch(peers),
      });
      peers.set('https://plat-a.example', platformA);
      peers.set('https://plat-b.example', platformB);

      try {
        await registerPlatform(
          platformA,
          {
            code: codeB,
            name: 'Meridian eBL',
            baseUrl: 'https://plat-b.example',
            jwks: await signerB.jwks(),
          },
          admin,
        );
        await registerPlatform(
          platformB,
          {
            code: codeA,
            name: 'Bluewater Portal',
            baseUrl: 'https://plat-a.example',
            jwks: await signerA.jwks(),
          },
          admin,
        );

        const id = await issuedBl(platformA, nextRef('OUT-OK'));
        await titleOk(platformA, id, 'endorse', staffOf(SHIPPER), {
          to: BANK,
          inBlank: false,
        });

        const strangerTransfer = await titleCommand(
          platformA,
          id,
          'transfer-out',
          staffOf(STRANGER),
          {platform: codeB, partyCode: PEER_BANK, inBlank: false},
        );
        expect(strangerTransfer.statusCode).to.equal(404);

        const carrierTransfer = await titleCommand(
          platformA,
          id,
          'transfer-out',
          staffOf(CARRIER),
          {platform: codeB, partyCode: PEER_BANK, inBlank: false},
        );
        expect(carrierTransfer.statusCode).to.equal(403);

        const out = await titleOk(
          platformA,
          id,
          'transfer-out',
          staffOf(BANK),
          {
            platform: codeB,
            partyCode: PEER_BANK,
            inBlank: false,
          },
        );
        expect(out.title.state).to.equal('transferred-out');
        expect(out.allowedCommands).to.deep.equal([]);
        expect(out.chain.length).to.be.at.least(3);

        for (const [actor, cmd, body] of [
          [staffOf(BANK), 'endorse', {to: SHIPPER, inBlank: false}],
          [staffOf(BANK), 'surrender', {}],
          [staffOf(CARRIER), 'void', {}],
        ]) {
          const refused = await titleCommand(platformA, id, cmd, actor, body);
          expect(refused.statusCode, cmd).to.equal(409);
          expect(refused.json().details.code).to.equal('wrong-state');
        }

        const carrierRead = await platformA.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: platformA.as(staffOf(CARRIER)),
        });
        expect(carrierRead.statusCode).to.equal(200);
        const carrierView = carrierRead.json();
        expect(carrierView.title.state).to.equal('transferred-out');
        expect(carrierView.allowedCommands).to.deep.equal([]);
        expect(JSON.stringify(carrierView)).to.include(codeB);

        const pastHolderRead = await platformA.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: platformA.as(staffOf(SHIPPER)),
        });
        expect(pastHolderRead.statusCode).to.equal(200);
        expect(pastHolderRead.json().allowedCommands).to.deep.equal([]);
        expect(pastHolderRead.json().chain).to.have.length(out.chain.length);
      } finally {
        await platformA.close();
        await platformB.close();
      }
    });

    it('unlocks back to with-holder when the peer refuses with BSIG or BENV', async () => {
      const signerA = await createLocalSigner();
      const signerB = await createLocalSigner();
      const codeA = nextPlatformCode('PLAT-A');
      const codeB = nextPlatformCode('PLAT-B');
      const peers = new Map();
      let refusalCode = 'BSIG';

      const platformA = await makePlatform(store, {
        platformCode: codeA,
        signer: signerA,
        organisations: makeIdentity([
          {id: CARRIER, name: 'Bluewater Meridian Lines'},
          {id: SHIPPER, name: 'Highland Coffee Exporters'},
          {id: BANK, name: 'Harbour Trust Bank'},
        ]),
        fetchImpl: createPeerFetch(peers, async ({path}) => {
          if (path.endsWith('/transfers')) {
            return new Response(
              JSON.stringify({
                responseCode: refusalCode,
                message: `Peer rejected envelope: ${refusalCode}`,
              }),
              {
                status: 422,
                headers: {'content-type': 'application/json'},
              },
            );
          }
          return undefined;
        }),
      });
      peers.set('https://plat-b.example', {app: {inject: async () => ({})}});

      try {
        await registerPlatform(
          platformA,
          {
            code: codeB,
            name: 'Meridian eBL',
            baseUrl: 'https://plat-b.example',
            jwks: await signerB.jwks(),
          },
          admin,
        );

        for (const code of ['BSIG', 'BENV']) {
          refusalCode = code;
          const id = await issuedBl(platformA, nextRef(`REF-${code}`));
          await titleOk(platformA, id, 'endorse', staffOf(SHIPPER), {
            to: BANK,
            inBlank: false,
          });

          const res = await titleCommand(
            platformA,
            id,
            'transfer-out',
            staffOf(BANK),
            {platform: codeB, partyCode: PEER_BANK, inBlank: false},
          );
          expect(res.statusCode, code).to.be.oneOf([409, 422, 502]);
          expect(res.body).to.include(code);

          const read = await platformA.app.inject({
            method: 'GET',
            url: `/records/${id}/title`,
            headers: platformA.as(staffOf(BANK)),
          });
          expect(read.statusCode).to.equal(200);
          expect(read.json().title).to.include({
            state: 'with-holder',
            holder: BANK,
          });
          expect(read.json().allowedCommands).to.include.members([
            'endorse',
            'surrender',
            'transfer-out',
          ]);
        }
      } finally {
        await platformA.close();
      }
    });

    it('keeps transfer-pending locked on network failure and retry-transfer resends the exact same envelope to complete on DUPE or late RECE', async () => {
      const signerA = await createLocalSigner();
      const signerB = await createLocalSigner();
      const codeA = nextPlatformCode('PLAT-A');
      const codeB = nextPlatformCode('PLAT-B');
      const peers = new Map();
      const sentEnvelopes = [];
      let mode = 'drop-after-deliver';

      const platformA = await makePlatform(store, {
        platformCode: codeA,
        signer: signerA,
        organisations: makeIdentity([
          {id: CARRIER, name: 'Bluewater Meridian Lines'},
          {id: SHIPPER, name: 'Highland Coffee Exporters'},
          {id: BANK, name: 'Harbour Trust Bank'},
        ]),
        fetchImpl: createPeerFetch(peers, async ({method, path, payload}) => {
          if (method === 'POST' && path.endsWith('/transfers')) {
            sentEnvelopes.push(structuredClone(payload));
            if (mode === 'network-error') {
              throw new Error('ETIMEDOUT');
            }
            if (mode === 'drop-after-deliver') {
              // Peer actually processed the envelope, then the response timed out on the wire.
              const realRes = await peers
                .get('https://plat-b.example')
                .app.inject({
                  method,
                  url: path,
                  payload,
                });
              expect(realRes.statusCode).to.be.oneOf([200, 201]);
              throw new Error('ETIMEDOUT after peer accepted');
            }
          }
          return undefined;
        }),
      });
      const platformB = await makePlatform(store, {
        platformCode: codeB,
        signer: signerB,
        organisations: makeIdentity([
          {id: PEER_BANK, name: 'Banco Atlântico Ghana Ltd'},
        ]),
      });
      peers.set('https://plat-b.example', platformB);

      try {
        await registerPlatform(
          platformA,
          {
            code: codeB,
            name: 'Meridian eBL',
            baseUrl: 'https://plat-b.example',
            jwks: await signerB.jwks(),
          },
          admin,
        );
        await registerPlatform(
          platformB,
          {
            code: codeA,
            name: 'Bluewater Portal',
            baseUrl: 'https://plat-a.example',
            jwks: await signerA.jwks(),
          },
          admin,
        );

        // Case 1: peer received the first attempt, response lost -> retry gets DUPE -> completes
        const idDupe = await issuedBl(platformA, nextRef('RETRY-DUPE'));
        await titleOk(platformA, idDupe, 'endorse', staffOf(SHIPPER), {
          to: BANK,
          inBlank: false,
        });

        const firstTry = await titleCommand(
          platformA,
          idDupe,
          'transfer-out',
          staffOf(BANK),
          {platform: codeB, partyCode: PEER_BANK, inBlank: false},
        );
        expect(firstTry.statusCode).to.be.oneOf([502, 503, 504]);

        const lockedRead = await platformA.app.inject({
          method: 'GET',
          url: `/records/${idDupe}/title`,
          headers: platformA.as(staffOf(BANK)),
        });
        expect(lockedRead.json().title).to.include({
          state: 'transfer-pending',
          holder: BANK,
        });

        const blockedEndorse = await titleCommand(
          platformA,
          idDupe,
          'endorse',
          staffOf(BANK),
          {to: SHIPPER, inBlank: false},
        );
        expect(blockedEndorse.statusCode).to.equal(409);
        expect(blockedEndorse.json().details.code).to.equal('wrong-state');

        mode = 'normal';
        const retriedDupe = await titleOk(
          platformA,
          idDupe,
          'retry-transfer',
          staffOf(BANK),
        );
        expect(retriedDupe.title.state).to.equal('transferred-out');
        expect(sentEnvelopes).to.have.length(2);
        expect(sentEnvelopes[1]).to.deep.equal(sentEnvelopes[0]);

        // Case 2: peer never received first attempt -> retry gets late RECE -> completes
        sentEnvelopes.length = 0;
        mode = 'network-error';
        const idRece = await issuedBl(platformA, nextRef('RETRY-RECE'));
        await titleOk(platformA, idRece, 'endorse', staffOf(SHIPPER), {
          to: BANK,
          inBlank: false,
        });
        await titleCommand(platformA, idRece, 'transfer-out', staffOf(BANK), {
          platform: codeB,
          partyCode: PEER_BANK,
          inBlank: false,
        });
        mode = 'normal';
        const retriedRece = await titleOk(
          platformA,
          idRece,
          'retry-transfer',
          staffOf(BANK),
        );
        expect(retriedRece.title.state).to.equal('transferred-out');
        expect(sentEnvelopes).to.have.length(2);
        expect(sentEnvelopes[1]).to.deep.equal(sentEnvelopes[0]);

        // retry-transfer refused when not in transfer-pending
        const notPending = await titleCommand(
          platformA,
          idRece,
          'retry-transfer',
          staffOf(BANK),
        );
        expect(notPending.statusCode).to.equal(409);
        expect(notPending.json().details.code).to.equal('wrong-state');
      } finally {
        await platformA.close();
        await platformB.close();
      }
    });

    it('completes a full two-platform round-trip transfer and lets the returning holder accept-incoming and surrender', async () => {
      const signerA = await createLocalSigner();
      const signerB = await createLocalSigner();
      const codeA = nextPlatformCode('PLAT-A');
      const codeB = nextPlatformCode('PLAT-B');
      const peers = new Map();

      const platformA = await makePlatform(store, {
        platformCode: codeA,
        signer: signerA,
        organisations: makeIdentity([
          {id: CARRIER, name: 'Bluewater Meridian Lines'},
          {id: SHIPPER, name: 'Highland Coffee Exporters'},
          {id: BUYER, name: 'Roastery Collective Imports'},
        ]),
        fetchImpl: createPeerFetch(peers),
      });
      const platformB = await makePlatform(store, {
        platformCode: codeB,
        signer: signerB,
        organisations: makeIdentity([
          {id: PEER_BANK, name: 'Banco Atlântico Ghana Ltd'},
        ]),
        fetchImpl: createPeerFetch(peers),
      });
      peers.set('https://plat-a.example', platformA);
      peers.set('https://plat-b.example', platformB);

      try {
        await registerPlatform(
          platformA,
          {
            code: codeB,
            name: 'Meridian eBL',
            baseUrl: 'https://plat-b.example',
            jwks: await signerB.jwks(),
          },
          admin,
        );
        await registerPlatform(
          platformB,
          {
            code: codeA,
            name: 'Bluewater Portal',
            baseUrl: 'https://plat-a.example',
            jwks: await signerA.jwks(),
          },
          admin,
        );

        const ref = nextRef('ROUNDTRIP');
        const idA = await issuedBl(platformA, ref);
        const sentOut = await titleOk(
          platformA,
          idA,
          'transfer-out',
          staffOf(SHIPPER),
          {platform: codeB, partyCode: PEER_BANK, inBlank: false},
        );
        expect(sentOut.title.state).to.equal('transferred-out');

        // On Platform B, the arrived B/L is visible to the receiving bank and waits for accept-incoming
        const listB = await platformB.app.inject({
          method: 'GET',
          url: `/records/title?number=${ref}`,
          headers: platformB.as(staffOf(PEER_BANK)),
        });
        expect(listB.statusCode).to.equal(200);
        expect(listB.json().items).to.have.length(1);
        const idB = listB.json().items[0].id;
        expect(listB.json().items[0].title).to.include({
          state: 'arrived',
          holder: PEER_BANK,
        });

        const acceptedB = await titleOk(
          platformB,
          idB,
          'accept-incoming',
          staffOf(PEER_BANK),
        );
        expect(acceptedB.title).to.include({
          state: 'with-holder',
          holder: PEER_BANK,
        });

        // Bank on Platform B transfers back to Buyer on Platform A
        const returnedOut = await titleOk(
          platformB,
          idB,
          'transfer-out',
          staffOf(PEER_BANK),
          {platform: codeA, partyCode: BUYER, inBlank: false},
        );
        expect(returnedOut.title.state).to.equal('transferred-out');

        // On Platform A, the B/L reactivates in `arrived` for Buyer with the combined chain
        const arrivedA = await platformA.app.inject({
          method: 'GET',
          url: `/records/${idA}/title`,
          headers: platformA.as(staffOf(BUYER)),
        });
        expect(arrivedA.statusCode).to.equal(200);
        expect(arrivedA.json().title).to.include({
          state: 'arrived',
          holder: BUYER,
        });
        expect(arrivedA.json().allowedCommands).to.include('accept-incoming');
        expect(arrivedA.json().chain.length).to.be.greaterThan(
          sentOut.chain.length,
        );

        const surrenderBeforeAccept = await titleCommand(
          platformA,
          idA,
          'surrender',
          staffOf(BUYER),
        );
        expect(surrenderBeforeAccept.statusCode).to.equal(409);
        expect(surrenderBeforeAccept.json().details.code).to.equal(
          'wrong-state',
        );

        const acceptedA = await titleOk(
          platformA,
          idA,
          'accept-incoming',
          staffOf(BUYER),
        );
        expect(acceptedA.title).to.include({
          state: 'with-holder',
          holder: BUYER,
        });

        const surrendered = await titleOk(
          platformA,
          idA,
          'surrender',
          staffOf(BUYER),
        );
        expect(surrendered.title.state).to.equal('surrendered');

        const released = await titleOk(
          platformA,
          idA,
          'release',
          staffOf(CARRIER),
        );
        expect(released.title.state).to.equal('accomplished');
      } finally {
        await platformA.close();
        await platformB.close();
      }
    });

    it('rejects tampered signatures (BSIG), modified prior entries, suspended peers (403/BENV), duplicates (DUPE) and active B/L conflicts (409)', async () => {
      const signerA = await createLocalSigner();
      const signerB = await createLocalSigner();
      const codeA = nextPlatformCode('PLAT-A');
      const codeB = nextPlatformCode('PLAT-B');
      const peers = new Map();
      const captured = [];

      const platformA = await makePlatform(store, {
        platformCode: codeA,
        signer: signerA,
        organisations: makeIdentity([
          {id: CARRIER, name: 'Bluewater Meridian Lines'},
          {id: SHIPPER, name: 'Highland Coffee Exporters'},
          {id: BUYER, name: 'Roastery Collective Imports'},
        ]),
        fetchImpl: createPeerFetch(peers),
      });
      const platformB = await makePlatform(store, {
        platformCode: codeB,
        signer: signerB,
        organisations: makeIdentity([
          {id: PEER_CARRIER, name: 'Peer Line'},
          {id: PEER_BANK, name: 'Banco Atlântico Ghana Ltd'},
          {id: PEER_BUYER, name: 'Peer Buyer'},
        ]),
        fetchImpl: createPeerFetch(peers, async ({method, path, payload}) => {
          if (method === 'POST' && path.endsWith('/transfers')) {
            captured.push(structuredClone(payload));
          }
          return undefined;
        }),
      });
      peers.set('https://plat-a.example', platformA);
      peers.set('https://plat-b.example', platformB);

      try {
        await registerPlatform(
          platformA,
          {
            code: codeB,
            name: 'Meridian eBL',
            baseUrl: 'https://plat-b.example',
            jwks: await signerB.jwks(),
          },
          admin,
        );
        await registerPlatform(
          platformB,
          {
            code: codeA,
            name: 'Bluewater Portal',
            baseUrl: 'https://plat-a.example',
            jwks: await signerA.jwks(),
          },
          admin,
        );

        // Prepare a round-trip B/L up to Platform B -> Platform A, capturing the valid return envelope
        const ref = nextRef('SECURITY');
        const idA = await issuedBl(platformA, ref);
        await titleOk(platformA, idA, 'transfer-out', staffOf(SHIPPER), {
          platform: codeB,
          partyCode: PEER_BANK,
          inBlank: false,
        });
        const listB = await platformB.app.inject({
          method: 'GET',
          url: `/records/title?number=${ref}`,
          headers: platformB.as(staffOf(PEER_BANK)),
        });
        const idB = listB.json().items[0].id;
        await titleOk(platformB, idB, 'accept-incoming', staffOf(PEER_BANK));

        // Suspend Platform B on Platform A: incoming envelope from suspended peer refused 403/BENV
        await platformA.app.inject({
          method: 'POST',
          url: `/records/platforms/${codeB}/suspend`,
          headers: platformA.as(admin),
        });
        const suspendedAttempt = await titleCommand(
          platformB,
          idB,
          'transfer-out',
          staffOf(PEER_BANK),
          {platform: codeA, partyCode: BUYER, inBlank: false},
        );
        expect(suspendedAttempt.statusCode).to.be.oneOf([403, 409, 422, 502]);
        expect(captured).to.have.length(1);
        const returnEnvelope = captured[0];

        const directSuspended = await platformA.app.inject({
          method: 'POST',
          url: '/records/pint/transfers',
          payload: returnEnvelope,
        });
        expect(
          directSuspended.statusCode === 403 ||
            pintCodeOf(directSuspended) === 'BENV',
        ).to.equal(true);

        // Reactivate Platform B for the remaining security checks
        await platformA.app.inject({
          method: 'POST',
          url: `/records/platforms/${codeB}/reactivate`,
          headers: platformA.as(admin),
        });

        // 1. Tampered entry signature -> BSIG, B/L remains transferred-out on Platform A
        const badSigRes = await platformA.app.inject({
          method: 'POST',
          url: '/records/pint/transfers',
          payload: tamperLastEntrySignature(returnEnvelope),
        });
        expect(badSigRes.statusCode).to.be.within(400, 422);
        expect(pintCodeOf(badSigRes)).to.equal('BSIG');

        // 2. Modified prior entry from Platform A itself -> refused, B/L remains transferred-out
        const rewrittenPrior = await tamperPriorEntry(returnEnvelope, signerB);
        const badPriorRes = await platformA.app.inject({
          method: 'POST',
          url: '/records/pint/transfers',
          payload: rewrittenPrior,
        });
        expect(badPriorRes.statusCode).to.be.within(400, 422);

        const stillAway = await platformA.app.inject({
          method: 'GET',
          url: `/records/${idA}/title`,
          headers: platformA.as(staffOf(CARRIER)),
        });
        expect(stillAway.json().title.state).to.equal('transferred-out');

        // 3. Valid delivery -> RECE, then exact replay -> DUPE
        const validRes = await platformA.app.inject({
          method: 'POST',
          url: '/records/pint/transfers',
          payload: returnEnvelope,
        });
        expect(validRes.statusCode).to.be.oneOf([200, 201]);
        expect(pintCodeOf(validRes)).to.equal('RECE');

        const dupeRes = await platformA.app.inject({
          method: 'POST',
          url: '/records/pint/transfers',
          payload: returnEnvelope,
        });
        expect(dupeRes.statusCode).to.equal(200);
        expect(pintCodeOf(dupeRes)).to.equal('DUPE');

        // 4. Already-active duplicate B/L conflict -> 409
        const conflictRef = nextRef('CONFLICT');
        const activeOnA = await issuedBl(platformA, conflictRef);
        const activeOnB = await issuedBl(platformB, conflictRef, {
          carrier: PEER_CARRIER,
          shipper: PEER_BUYER,
        });
        const conflictSend = await titleCommand(
          platformB,
          activeOnB,
          'transfer-out',
          staffOf(PEER_BUYER),
          {platform: codeA, partyCode: BUYER, inBlank: false},
        );
        expect(conflictSend.statusCode).to.be.oneOf([409, 422, 502]);
        expect(captured.length).to.be.greaterThan(1);
        const conflictEnvelope = captured.at(-1);

        const conflictDirect = await platformA.app.inject({
          method: 'POST',
          url: '/records/pint/transfers',
          payload: conflictEnvelope,
        });
        expect(conflictDirect.statusCode).to.equal(409);

        const activeRead = await platformA.app.inject({
          method: 'GET',
          url: `/records/${activeOnA}/title`,
          headers: platformA.as(staffOf(CARRIER)),
        });
        expect(activeRead.json().title).to.include({
          state: 'issued',
          holder: SHIPPER,
        });

        // 5. Reject malformed envelopeId (non-UUID), missing/mismatched documentHash, and non-transfer-out last entry
        for (const badEnvelope of [
          {...returnEnvelope, envelopeId: 'not-a-uuid'},
          {...returnEnvelope, documentHash: undefined},
          {
            ...returnEnvelope,
            documentHash: '0'.repeat(64),
          },
          {
            ...returnEnvelope,
            document: {
              ...returnEnvelope.document,
              transportDocumentTypeCode: 'SWB',
              isToOrder: false,
            },
          },
        ]) {
          const badRes = await platformA.app.inject({
            method: 'POST',
            url: '/records/pint/transfers',
            payload: badEnvelope,
          });
          expect(badRes.statusCode).to.equal(400);
          expect(pintCodeOf(badRes)).to.equal('BENV');
        }
      } finally {
        await platformA.close();
        await platformB.close();
      }
    });
  });
}
