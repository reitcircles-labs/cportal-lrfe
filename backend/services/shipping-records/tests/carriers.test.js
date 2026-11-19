import {createLocalSigner} from '@lrfe/common';
import {loadCarrierList} from '@lrfe/domain-shipping/carriers';
import {expect} from 'chai';

import {exampleWithReference, makeHttp, stores, users} from './helpers.js';

/**
 * The SMDG carrier code list on the record service (CB-68):
 * - GET /records/carriers searches and lists SMDG codes for B/L drafters, issuers, and org admins.
 * - POST /records and POST /records/:id/title/amend refuse codes not on the list.
 * - Existing pre-list B/Ls and drafts keep their codes and still open.
 */

const CARRIERS = loadCarrierList();
const ISSUER = {
  id: 'u-a-iss',
  name: 'Carrier Issuer',
  org: 'org-a',
  perms: ['bl.read', 'bl.draft', 'bl.issue'],
};
const ORG_ADMIN = {
  id: 'u-adm',
  name: 'Platform Admin',
  org: 'org-adm',
  perms: ['admin.organisations'],
};

for (const store of stores()) {
  describe(`SMDG carrier code list, ${store.name} (CB-68)`, () => {
    let ctx;
    before(async () => {
      const signer = await createLocalSigner();
      ctx = await makeHttp(store, {carriers: CARRIERS, signer});
    });
    after(async () => {
      await ctx?.close();
    });

    it('creates a B/L with a listed SMDG code and refuses an unlisted code (400 unknown-carrier-code)', async () => {
      const ok = await ctx.app.inject({
        method: 'POST',
        url: '/records',
        headers: ctx.as(users.a1),
        payload: {
          format: 'dcsa-3.0',
          document: {...exampleWithReference('CARR0001'), carrierCode: 'MSK'},
        },
      });
      expect(ok.statusCode, ok.body).to.equal(201);

      const bad = await ctx.app.inject({
        method: 'POST',
        url: '/records',
        headers: ctx.as(users.a1),
        payload: {
          format: 'dcsa-3.0',
          document: {...exampleWithReference('CARR0002'), carrierCode: 'BWML'},
        },
      });
      expect(bad.statusCode).to.equal(400);
      const body = bad.json();
      expect(body.details?.code).to.equal('unknown-carrier-code');
      expect(body.message).to.contain('BWML');
      expect(body.details?.problems?.[0]?.path).to.equal('carrierCode');
    });

    it('lists and searches SMDG codes for drafters, issuers, and platform admins, not plain readers', async () => {
      const byName = await ctx.app.inject({
        method: 'GET',
        url: '/records/carriers?q=maersk',
        headers: ctx.as(users.a1),
      });
      expect(byName.statusCode, byName.body).to.equal(200);
      expect(byName.json().items.map(c => c.code)).to.include('MSK');

      const adminList = await ctx.app.inject({
        method: 'GET',
        url: '/records/carriers',
        headers: ctx.as(ORG_ADMIN),
      });
      expect(adminList.statusCode, adminList.body).to.equal(200);
      expect(adminList.json().items.length).to.be.greaterThan(350);

      const readerRes = await ctx.app.inject({
        method: 'GET',
        url: '/records/carriers?q=maersk',
        headers: ctx.as(users.aReader),
      });
      expect(readerRes.statusCode).to.equal(403);
    });

    it('allows existing pre-list records with non-SMDG codes to open, while refusing amend with an unlisted code', async () => {
      const now = new Date();
      const legacyDoc = {
        ...exampleWithReference('LEGACY0001'),
        carrierCode: 'BWML',
      };
      const record = {
        id: '00000000-0000-4000-8000-000000006801',
        recordNo: 'LEGACY0001',
        carrierCode: 'BWML',
        label: 'B/L LEGACY0001 (BWML)',
        organisationId: 'org-a',
        status: 'committed',
        currentVersion: 1,
        draftVersion: null,
        draftState: null,
        createdAt: now,
        createdById: users.a1.id,
        createdByName: users.a1.name,
        updatedAt: now,
      };
      const version = {
        id: '00000000-0000-4000-8000-000000006802',
        recordId: record.id,
        versionNumber: 1,
        state: 'committed',
        revision: 2,
        data: {
          schemaVersion: 1,
          document: legacyDoc,
          partyOrganisations: {shipper: 'org-b'},
        },
        documentHash: '0'.repeat(64),
        seal: '0'.repeat(64),
        previousSeal: null,
        changes: [],
        createdAt: now,
        createdById: users.a1.id,
        createdByName: users.a1.name,
        committedAt: now,
        approvedById: ISSUER.id,
        approvedByName: ISSUER.name,
        updatedAt: now,
      };
      await ctx.repo.createRecord({record, version});
      await ctx.repo.createTitle({
        recordId: record.id,
        kind: 'negotiable',
        state: 'amendment-requested',
        carrier: 'org-a',
        holder: 'org-a',
        endorsement: 'none',
        consignee: null,
        returnTo: 'org-b',
        issuedVersion: 1,
        documentHash: '0'.repeat(64),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });

      const opened = await ctx.app.inject({
        method: 'GET',
        url: `/records/${record.id}`,
        headers: ctx.as(users.a1),
      });
      expect(opened.statusCode, opened.body).to.equal(200);
      expect(opened.json().carrierCode).to.equal('BWML');

      const titleOpened = await ctx.app.inject({
        method: 'GET',
        url: `/records/${record.id}/title`,
        headers: ctx.as(users.a1),
      });
      expect(titleOpened.statusCode, titleOpened.body).to.equal(200);
      expect(titleOpened.json().record.carrierCode).to.equal('BWML');

      const amendBad = await ctx.app.inject({
        method: 'POST',
        url: `/records/${record.id}/title/amend`,
        headers: ctx.as(ISSUER),
        payload: {format: 'dcsa-3.0', document: legacyDoc},
      });
      expect(amendBad.statusCode).to.equal(400);
      expect(amendBad.json().details?.code).to.equal('unknown-carrier-code');

      // Pre-list open draft keeps its carrier code and can still be opened and edited
      const draftDoc = {
        ...exampleWithReference('LEGACYDR01'),
        carrierCode: 'BWML',
      };
      const draftRecord = {
        id: '00000000-0000-4000-8000-000000006803',
        recordNo: 'LEGACYDR01',
        carrierCode: 'BWML',
        label: 'B/L LEGACYDR01 (BWML)',
        organisationId: 'org-a',
        status: 'draft',
        currentVersion: null,
        draftVersion: 1,
        draftState: 'draft',
        createdAt: now,
        createdById: users.a1.id,
        createdByName: users.a1.name,
        updatedAt: now,
      };
      const draftVersion = {
        id: '00000000-0000-4000-8000-000000006804',
        recordId: draftRecord.id,
        versionNumber: 1,
        state: 'draft',
        revision: 1,
        data: {
          schemaVersion: 1,
          document: draftDoc,
          partyOrganisations: {shipper: 'org-b'},
        },
        documentHash: '1'.repeat(64),
        changes: [],
        reviewComment: null,
        createdAt: now,
        createdById: users.a1.id,
        createdByName: users.a1.name,
        updatedAt: now,
      };
      await ctx.repo.createRecord({record: draftRecord, version: draftVersion});
      const editedDraft = await ctx.app.inject({
        method: 'PUT',
        url: `/records/${draftRecord.id}/draft`,
        headers: ctx.as(users.a1),
        payload: {
          format: 'dcsa-3.0',
          document: {
            ...draftDoc,
            shippingInstructionsReference: 'SI-LEGACY-OK',
          },
          partyOrganisations: {shipper: 'org-b'},
          revision: 1,
        },
      });
      expect(editedDraft.statusCode, editedDraft.body).to.equal(200);
      expect(editedDraft.json().carrierCode).to.equal('BWML');
    });
  });
}
