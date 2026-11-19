import {createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {exampleWithReference, makeHttp, stores} from './helpers.js';

const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';

const DRAFT_API_ACTOR = {
  id: 'api-key:k-draft',
  name: 'TMS Draft Key (API)',
  org: CARRIER,
  perms: ['bl.read', 'bl.draft'],
};
const ISSUE_API_ACTOR = {
  id: 'api-key:k-issue',
  name: 'TMS Issue Key (API)',
  org: CARRIER,
  perms: ['bl.read', 'bl.draft', 'bl.issue'],
};
const CARRIER_USER = {
  id: 'u-carrier',
  name: 'Ravi Menon',
  org: CARRIER,
  perms: ['bl.read', 'bl.draft', 'bl.issue'],
};
const SHIPPER_USER = {
  id: 'u-shipper',
  name: 'Ana Ribeiro',
  org: SHIPPER,
  perms: ['bl.read', 'bl.endorse'],
};

for (const store of stores()) {
  describe(`carrier issuance API (CB-56), ${store.name}`, () => {
    it('submits a ready-to-issue B/L when issue is false, and issues atomically when issue is true', async () => {
      const ctx = await makeHttp(store, {signer: await createLocalSigner()});
      try {
        // issue: false creates committed v1 ready for a human approver to issue
        const readyRes = await ctx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: ctx.as(DRAFT_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: exampleWithReference('CB56-READY-1'),
            partyOrganisations: {shipper: SHIPPER},
          },
        });
        expect(readyRes.statusCode, readyRes.body).to.equal(201);
        const ready = readyRes.json();
        expect(ready.record).to.include({
          recordNo: 'CB56-READY-1',
          status: 'committed',
          currentVersion: 1,
        });
        expect(ready.title).to.equal(null);

        const readyTitle = await ctx.app.inject({
          method: 'GET',
          url: `/records/${ready.record.id}/title`,
          headers: ctx.as(CARRIER_USER),
        });
        expect(readyTitle.statusCode).to.equal(200);
        expect(readyTitle.json().allowedCommands).to.deep.equal(['issue']);

        // Draft-only key cannot issue straight through (403)
        const deniedIssue = await ctx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: ctx.as(DRAFT_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: exampleWithReference('CB56-DENIED'),
            partyOrganisations: {shipper: SHIPPER},
            issue: true,
          },
        });
        expect(deniedIssue.statusCode).to.equal(403);

        // Straight-through issue with bl.issue creates, commits, issues, and anchors
        const doc = exampleWithReference('CB56-DIRECT-1');
        // Distinct container/seal from other issued records
        doc.utilizedTransportEquipments = [
          {
            ...doc.utilizedTransportEquipments[0],
            equipment: {
              ...doc.utilizedTransportEquipments[0].equipment,
              equipmentReference: 'CB56CONT001',
            },
            seals: [{number: 'CB56SEAL001', sourceCode: 'CAR'}],
          },
        ];
        doc.consignmentItems[0].cargoItems[0].equipmentReference =
          'CB56CONT001';

        const issuedRes = await ctx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: ctx.as(ISSUE_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: doc,
            partyOrganisations: {shipper: SHIPPER},
            issue: true,
          },
        });
        expect(issuedRes.statusCode, issuedRes.body).to.equal(201);
        const issued = issuedRes.json();
        expect(issued.title).to.include({
          kind: 'negotiable',
          state: 'issued',
          carrier: CARRIER,
          holder: SHIPPER,
        });
        expect(issued.cargoKey).to.be.a('string').and.not.be.empty;

        // Visible to the shipper and carrier in the list and title view just like screen-issued B/Ls
        const listRes = await ctx.app.inject({
          method: 'GET',
          url: '/records/title',
          headers: ctx.as(SHIPPER_USER),
        });
        expect(listRes.statusCode).to.equal(200);
        expect(listRes.json().items.map(i => i.recordNo)).to.include(
          'CB56-DIRECT-1',
        );
      } finally {
        await ctx.close?.();
      }
    });

    it('blocks duplicate cargo (same carrier, container, and seal) on issuance, and frees it once voided', async () => {
      const ctx = await makeHttp(store, {signer: await createLocalSigner()});
      try {
        const makeDoc = ref => {
          const doc = exampleWithReference(ref);
          doc.utilizedTransportEquipments = [
            {
              ...doc.utilizedTransportEquipments[0],
              equipment: {
                ...doc.utilizedTransportEquipments[0].equipment,
                equipmentReference: 'DUPECONT01',
              },
              seals: [{number: 'DUPESEAL01', sourceCode: 'CAR'}],
            },
          ];
          doc.consignmentItems[0].cargoItems[0].equipmentReference =
            'DUPECONT01';
          return doc;
        };

        const first = await ctx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: ctx.as(ISSUE_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: makeDoc('CB56-ORIG-1'),
            partyOrganisations: {shipper: SHIPPER},
            issue: true,
          },
        });
        expect(first.statusCode).to.equal(201);
        const firstId = first.json().record.id;

        const dupe = await ctx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: ctx.as(ISSUE_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: makeDoc('CB56-DUPE-2'),
            partyOrganisations: {shipper: SHIPPER},
            issue: true,
          },
        });
        expect(dupe.statusCode).to.equal(409);
        expect(dupe.json().details.code).to.equal('duplicate-cargo');

        // Nothing recorded for the refused duplicate
        const list = await ctx.app.inject({
          method: 'GET',
          url: '/records',
          headers: ctx.as(CARRIER_USER),
        });
        expect(list.json().items.map(r => r.recordNo)).to.not.include(
          'CB56-DUPE-2',
        );

        // Voiding the original B/L frees the container and seal
        const voided = await ctx.app.inject({
          method: 'POST',
          url: `/records/${firstId}/title/void`,
          headers: ctx.as(CARRIER_USER),
          payload: {},
        });
        expect(voided.statusCode).to.equal(200);

        const retry = await ctx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: ctx.as(ISSUE_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: makeDoc('CB56-RETRY-3'),
            partyOrganisations: {shipper: SHIPPER},
            issue: true,
          },
        });
        expect(retry.statusCode).to.equal(201);
      } finally {
        await ctx.close?.();
      }
    });

    it('leaves nothing recorded when the shipper organisation is unregistered or signing fails', async () => {
      const ctx = await makeHttp(store, {
        signer: await createLocalSigner(),
        organisations: {
          async standingOf(id) {
            return id === SHIPPER ? 'unknown' : 'active';
          },
        },
      });
      try {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: ctx.as(ISSUE_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: exampleWithReference('CB56-UNREG'),
            partyOrganisations: {shipper: SHIPPER},
            issue: true,
          },
        });
        expect(res.statusCode).to.equal(422);
        expect(res.json().details.code).to.equal('unregistered-organisation');

        const list = await ctx.app.inject({
          method: 'GET',
          url: '/records',
          headers: ctx.as(CARRIER_USER),
        });
        expect(list.json().items).to.have.length(0);
      } finally {
        await ctx.close?.();
      }

      const brokenSignerCtx = await makeHttp(store, {
        signer: {
          async currentKid() {
            return 'broken-kid';
          },
          async sign() {
            throw new Error('signer down');
          },
          async publicKeys() {
            return [];
          },
        },
      });
      try {
        const res = await brokenSignerCtx.app.inject({
          method: 'POST',
          url: '/records/issuance',
          headers: brokenSignerCtx.as(ISSUE_API_ACTOR),
          payload: {
            format: 'dcsa-3.0',
            document: exampleWithReference('CB56-SIGNFAIL'),
            partyOrganisations: {shipper: SHIPPER},
            issue: true,
          },
        });
        expect(res.statusCode).to.equal(500);
        const list = await brokenSignerCtx.app.inject({
          method: 'GET',
          url: '/records',
          headers: brokenSignerCtx.as(CARRIER_USER),
        });
        expect(list.json().items).to.have.length(0);
      } finally {
        await brokenSignerCtx.close?.();
      }
    });
  });
}
