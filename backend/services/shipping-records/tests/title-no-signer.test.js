import {createEventBus} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';

import {buildApp} from '../src/app.js';
import {ShippingRecordsService} from '../src/records.service.js';
import {TitleService} from '../src/title.service.js';
import {
  ACTIVE_ORGANISATIONS,
  exampleWithReference,
  makeClock,
  stores,
} from './helpers.js';

/**
 * CB-36: a shipping install without the platform signer (TITLE_SIGNER not set, production: what
 * deploy/docker-compose.yml gives until OpenBao is prepared for it). The service starts as
 * index.js builds it, with a title service whose signer is null: every title command is refused
 * 503 `not-set-up` and records nothing, the key set answers 503, and everything else works:
 * drafting, reading the B/L and reading its title.
 */

/** The shared secret of the test app's tokens. */
const SECRET = 'cb36-no-signer-secret-of-at-least-32-characters';

/** The carrier's organisation. */
const CARRIER = 'org-carrier';

/** Every B/L permission, as the demo role bld has them. */
const ALL_PERMISSIONS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

/** The carrier's staff: one drafts and submits, the other approves (four-eyes). */
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

/**
 * The app as index.js builds it in production without a signer.
 *
 * @param {{open: function(): Promise<object>}} store
 * @return {!Promise<object>}
 */
async function unsignedApp(store) {
  const {repo, atomic, close} = await store.open();
  const bus = createEventBus({driver: 'memory', source: 'shipping-records'});
  const events = atomic ? {...bus, atomic} : bus;
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
    signer: null,
    organisations: ACTIVE_ORGANISATIONS,
  });
  const app = await buildApp({service, titles, jwtSecret: SECRET});
  await app.ready();
  const headers = {
    authorization: `Bearer ${app.jwt.sign({
      typ: 'access',
      sub: drafter.id,
      name: drafter.name,
      org: CARRIER,
      perms: ALL_PERMISSIONS,
    })}`,
  };
  return {
    app,
    service,
    repo,
    headers,
    close: async () => {
      await app.close();
      if (close) {
        await close();
      }
    },
  };
}

for (const store of stores()) {
  describe(`CB-36 no platform signer (${store.name})`, () => {
    let ctx;
    let id;

    beforeEach(async () => {
      ctx = await unsignedApp(store);
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/records',
        headers: ctx.headers,
        payload: {
          format: 'dcsa-3.0',
          document: exampleWithReference('CB36-NO-SIGNER'),
          partyOrganisations: {shipper: 'org-shipper'},
        },
      });
      expect(created.statusCode, created.body).to.equal(201);
      id = created.json().id;
      await ctx.service.submit(id, 1, drafter, CARRIER);
      await ctx.service.commit(id, 1, {by: approver}, 'bpm');
    });

    afterEach(async () => {
      await ctx.close();
    });

    it('refuses a title command 503 not-set-up, naming no tool, and records nothing', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/records/${id}/title/issue`,
        headers: ctx.headers,
        payload: {},
      });
      expect(res.statusCode).to.equal(503);
      expect(res.json().details.code).to.equal('not-set-up');
      expect(res.json().message).to.not.match(/bao|vault|transit|signer/i);
      expect(await ctx.repo.getTitle(id)).to.equal(null);
      expect(await ctx.repo.listTitleEntries(id)).to.deep.equal([]);
    });

    it('answers the key set 503 while there is no key', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/records/title/keys',
      });
      expect(res.statusCode).to.equal(503);
    });

    it('still reads the B/L, its versions and its title (none yet)', async () => {
      const record = await ctx.app.inject({
        method: 'GET',
        url: `/records/${id}`,
        headers: ctx.headers,
      });
      expect(record.statusCode, record.body).to.equal(200);
      const versions = await ctx.app.inject({
        method: 'GET',
        url: `/records/${id}/versions`,
        headers: ctx.headers,
      });
      expect(versions.statusCode, versions.body).to.equal(200);
      const title = await ctx.app.inject({
        method: 'GET',
        url: `/records/${id}/title`,
        headers: ctx.headers,
      });
      expect(title.statusCode, title.body).to.equal(200);
      expect(title.json().title).to.equal(null);
    });

    it('still drafts: the next version of a committed B/L', async () => {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/records/${id}/draft`,
        headers: ctx.headers,
        payload: {
          format: 'dcsa-3.0',
          document: exampleWithReference('CB36-NO-SIGNER'),
        },
      });
      expect(res.statusCode, res.body).to.equal(200);
    });
  });
}
