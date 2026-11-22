import {createLocalSigner} from '@lrfe/common';
import {
  DEFAULT_CARRIER_LIST_FILE,
  loadCarrierList,
} from '@lrfe/domain-shipping/carriers';
import {
  DEFAULT_PORT_LIST_FILE,
  loadPortList,
} from '@lrfe/domain-shipping/ports';
import {expect} from 'chai';
import {PDFDocument} from 'pdf-lib';

import {renderPaperBlPdf} from '../src/paper-pdf.js';
import {exampleWithReference, makeHttp, stores} from './helpers.js';

/**
 * CB-86: Generating a printable paper B/L PDF when an electronic B/L is switched to paper.
 *
 * - `renderPaperBlPdf` renders an A4 multi-section PDF with header, switch-to-paper banner
 *   (including bearer warning when blank-endorsed), B/L particulars, parties, voyage/ports,
 *   cargo/containers, charges, terms and conditions, chain of title, and integrity hashes.
 * - `GET /records/:id/paper` returns `application/pdf` (with `attachment; filename=...`) only when
 *   the B/L is in `switched-to-paper`, only to the carrier or the holder that switched it to
 *   paper (403 to earlier past holders; 404 to non-parties; 409 before switch or for void).
 */

const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';
const STRANGER = 'org-stranger';

const ALL_PERMS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

let refCounter = 0;

/**
 * Generates a unique transport document reference per test.
 * @param {string} label
 * @return {string}
 */
function nextRef(label) {
  refCounter += 1;
  return `CB86-${label}-${refCounter}`.slice(0, 20);
}

/**
 * Builds a test user in an organisation.
 * @param {string} org
 * @param {!Array<string>} [perms]
 * @return {{id: string, name: string, org: string, perms: !Array<string>}}
 */
function staffOf(org, perms = ALL_PERMS) {
  return {id: `u-${org}`, name: `Clerk ${org}`, org, perms};
}

/**
 * Stand-in identity client with active standings and human names.
 * @return {{standingOf: function(string): !Promise<string>, nameOf: function(string): !Promise<?string>}}
 */
function standInIdentity() {
  const names = new Map([
    [CARRIER, 'Nordhafen Lines'],
    [SHIPPER, 'Kalahari Coffee Exporters'],
    [BANK, 'Accra Trade Bank'],
    [BUYER, 'Rhein Handel GmbH'],
    [STRANGER, 'Other Logistics Ltd'],
  ]);
  return {
    async standingOf(id) {
      return names.has(id) ? 'active' : 'unknown';
    },
    async nameOf(id) {
      return names.get(id) ?? null;
    },
  };
}

/**
 * Creates, commits, and issues a negotiable B/L to the shipper.
 * @param {object} ctx
 * @param {string} reference
 * @param {string} [exampleFile]
 * @return {!Promise<string>}
 */
async function issuedBl(ctx, reference, exampleFile = 'td-regular.json') {
  const record = await ctx.service.createRecord(
    {
      format: 'dcsa-3.0',
      document: exampleWithReference(reference, exampleFile),
      partyOrganisations: {shipper: SHIPPER},
    },
    drafter,
    CARRIER,
  );
  await ctx.service.submit(record.id, 1, drafter, CARRIER);
  await ctx.service.commit(record.id, 1, {by: approver}, 'bpm');
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/records/${record.id}/title/issue`,
    headers: ctx.as(staffOf(CARRIER)),
    payload: {},
  });
  expect(res.statusCode, res.body).to.equal(200);
  return record.id;
}

describe('CB-86 printable paper B/L PDF', () => {
  describe('renderPaperBlPdf', () => {
    const ports = loadPortList(DEFAULT_PORT_LIST_FILE);
    const carriers = loadCarrierList(DEFAULT_CARRIER_LIST_FILE);

    it('renders a valid PDF with metadata and handles blank-endorsed bearer B/Ls and multi-page terms', async () => {
      const doc = exampleWithReference('CB86-PDF-1');
      doc.termsAndConditions = Array.from(
        {length: 40},
        (_, i) =>
          `Clause ${i + 1}: Carrier liability and paper bill of lading terms for Johannes ǃGawaseb in Łódź.`,
      ).join('\n');
      const {bytes, filename} = await renderPaperBlPdf({
        record: {
          id: '11111111-1111-4111-8111-111111111111',
          recordNo: 'CB86-PDF-1',
          carrierCode: 'MSC',
          label: 'B/L CB86-PDF-1 (MSC)',
        },
        version: {
          versionNumber: 2,
          documentHash: 'a'.repeat(64),
          committedAt: '2026-11-20T10:00:00.000Z',
          approvedByName: 'Petrus Amutenya',
          data: {
            schemaVersion: 'dcsa-3.0',
            document: doc,
            partyOrganisations: {shipper: SHIPPER},
          },
        },
        title: {
          kind: 'negotiable',
          state: 'switched-to-paper',
          carrier: CARRIER,
          holder: null,
          endorsement: 'blank',
          consignee: null,
          issuedVersion: 2,
          documentHash: 'a'.repeat(64),
        },
        chain: [
          {
            seq: 1,
            command: 'issue',
            from: null,
            to: SHIPPER,
            endorsement: 'none',
            actor: {id: 'u1', name: 'Anna', org: CARRIER},
            at: '2026-11-20T10:05:00.000Z',
            entryHash: '1'.repeat(64),
          },
          {
            seq: 2,
            command: 'endorse',
            from: SHIPPER,
            to: BUYER,
            endorsement: 'blank',
            actor: {id: 'u2', name: 'Maria', org: SHIPPER},
            at: '2026-11-20T11:00:00.000Z',
            entryHash: '2'.repeat(64),
          },
          {
            seq: 3,
            command: 'switch-to-paper',
            from: BUYER,
            to: null,
            endorsement: 'blank',
            actor: {id: 'u3', name: 'Lukas', org: BUYER},
            at: '2026-11-20T12:00:00.000Z',
            entryHash: '3'.repeat(64),
          },
        ],
        organisationNames: {
          [CARRIER]: 'Nordhafen Lines',
          [SHIPPER]: 'Kalahari Coffee Exporters',
          [BUYER]: 'Rhein Handel GmbH',
        },
        ports,
        carriers,
      });

      expect(filename).to.equal('bl-CB86-PDF-1-v2-paper.pdf');
      expect(bytes).to.be.instanceOf(Uint8Array);
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getPageCount()).to.be.at.least(2);
      expect(pdf.getTitle()).to.equal('Paper Bill of Lading CB86-PDF-1');
      expect(pdf.getSubject()).to.include('CB86-PDF-1');
      expect(pdf.getSubject()).to.include('v2');
      // Never leak backend vendor names in generated customer documents.
      const ascii = Buffer.from(bytes).toString('latin1');
      expect(ascii).to.not.match(/Cardano|OpenBao|Gemini|TypeSafe/i);
    });

    it('sanitizes unusual reference characters in the download filename', async () => {
      const doc = exampleWithReference('BL/2026 01');
      const {filename, bytes} = await renderPaperBlPdf({
        record: {
          id: '22222222-2222-4222-8222-222222222222',
          recordNo: 'BL/2026 01',
          carrierCode: 'MSC',
          label: 'B/L BL/2026 01 (MSC)',
        },
        version: {
          versionNumber: 1,
          documentHash: 'b'.repeat(64),
          committedAt: '2026-11-20T10:00:00.000Z',
          data: {document: doc},
        },
        title: {
          kind: 'negotiable',
          state: 'switched-to-paper',
          carrier: CARRIER,
          holder: null,
          endorsement: 'named',
          consignee: null,
          issuedVersion: 1,
          documentHash: 'b'.repeat(64),
        },
        chain: [
          {
            seq: 1,
            command: 'switch-to-paper',
            from: SHIPPER,
            to: null,
            endorsement: 'named',
            actor: {id: 'u2', name: 'Maria', org: SHIPPER},
            at: '2026-11-20T12:00:00.000Z',
            entryHash: '4'.repeat(64),
          },
        ],
        organisationNames: {
          [CARRIER]: 'Nordhafen Lines',
          [SHIPPER]: 'Shipper Co',
        },
        ports,
        carriers,
      });

      expect(filename).to.equal('bl-BL_2026_01-v1-paper.pdf');
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getPageCount()).to.be.at.least(1);
    });
  });

  for (const store of stores()) {
    describe(`GET /records/:id/paper (${store.name})`, () => {
      let ctx;
      const ports = loadPortList(DEFAULT_PORT_LIST_FILE);
      const carriers = loadCarrierList(DEFAULT_CARRIER_LIST_FILE);

      beforeEach(async () => {
        ctx = await makeHttp(store, {
          signer: await createLocalSigner(),
          organisations: standInIdentity(),
          ports,
          carriers,
        });
      });

      afterEach(async () => {
        await ctx.close();
      });

      it('refuses 401 without a token and 403 without bl.read or an organisation', async () => {
        const id = await issuedBl(ctx, nextRef('AUTH'));
        const noAuth = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
        });
        expect(noAuth.statusCode).to.equal(401);

        const noPerm = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
          headers: ctx.as(staffOf(CARRIER, ['bl.draft'])),
        });
        expect(noPerm.statusCode).to.equal(403);

        const noOrg = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
          headers: ctx.as({id: 'u-x', name: 'No Org', perms: ['bl.read']}),
        });
        expect(noOrg.statusCode).to.equal(403);
      });

      it('returns 404 for an unknown B/L or an organisation that is not party to it', async () => {
        const id = await issuedBl(ctx, nextRef('404'));
        await ctx.app.inject({
          method: 'POST',
          url: `/records/${id}/title/switch-to-paper`,
          headers: ctx.as(staffOf(SHIPPER)),
          payload: {},
        });

        const stranger = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
          headers: ctx.as(staffOf(STRANGER, ['bl.read'])),
        });
        expect(stranger.statusCode).to.equal(404);

        const missing = await ctx.app.inject({
          method: 'GET',
          url: '/records/00000000-0000-4000-8000-000000000000/paper',
          headers: ctx.as(staffOf(CARRIER, ['bl.read'])),
        });
        expect(missing.statusCode).to.equal(404);
      });

      it('refuses 409 not-switched-to-paper before switching or when voided', async () => {
        const id = await issuedBl(ctx, nextRef('409'));
        const whileHeld = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
          headers: ctx.as(staffOf(SHIPPER, ['bl.read'])),
        });
        expect(whileHeld.statusCode).to.equal(409);
        expect(whileHeld.json().details.code).to.equal('not-switched-to-paper');

        await ctx.app.inject({
          method: 'POST',
          url: `/records/${id}/title/void`,
          headers: ctx.as(staffOf(CARRIER)),
          payload: {},
        });
        const whileVoid = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
          headers: ctx.as(staffOf(CARRIER, ['bl.read'])),
        });
        expect(whileVoid.statusCode).to.equal(409);
        expect(whileVoid.json().details.code).to.equal('not-switched-to-paper');
      });

      it('serves the printable PDF to both the holder that switched it and the carrier, and refuses 403 to earlier past holders', async () => {
        const ref = nextRef('OK');
        const id = await issuedBl(ctx, ref);

        // Shipper endorses to Bank, Bank endorses in blank to Buyer, Buyer switches to paper.
        const e1 = await ctx.app.inject({
          method: 'POST',
          url: `/records/${id}/title/endorse`,
          headers: ctx.as(staffOf(SHIPPER)),
          payload: {to: BANK, inBlank: false},
        });
        expect(e1.statusCode, e1.body).to.equal(200);

        const e2 = await ctx.app.inject({
          method: 'POST',
          url: `/records/${id}/title/endorse`,
          headers: ctx.as(staffOf(BANK)),
          payload: {to: BUYER, inBlank: true},
        });
        expect(e2.statusCode, e2.body).to.equal(200);

        const sw = await ctx.app.inject({
          method: 'POST',
          url: `/records/${id}/title/switch-to-paper`,
          headers: ctx.as(staffOf(BUYER)),
          payload: {confirmBearer: true},
        });
        expect(sw.statusCode, sw.body).to.equal(200);

        // Buyer (last holder who switched) can download the PDF.
        const buyerRes = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
          headers: ctx.as(staffOf(BUYER, ['bl.read'])),
        });
        expect(buyerRes.statusCode, buyerRes.body).to.equal(200);
        expect(buyerRes.headers['content-type']).to.include('application/pdf');
        expect(buyerRes.headers['content-disposition']).to.equal(
          `attachment; filename="bl-${ref}-v1-paper.pdf"`,
        );
        expect(buyerRes.headers['cache-control']).to.equal('no-store');
        const buyerPdf = await PDFDocument.load(buyerRes.rawPayload);
        expect(buyerPdf.getPageCount()).to.be.at.least(1);

        // Carrier can also download the PDF.
        const carrierRes = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/paper`,
          headers: ctx.as(staffOf(CARRIER, ['bl.read'])),
        });
        expect(carrierRes.statusCode, carrierRes.body).to.equal(200);
        expect(carrierRes.headers['content-type']).to.include(
          'application/pdf',
        );
        const carrierPdf = await PDFDocument.load(carrierRes.rawPayload);
        expect(carrierPdf.getPageCount()).to.equal(buyerPdf.getPageCount());

        // Earlier past holders (Shipper and Bank) cannot print a paper copy after transferring it away.
        for (const earlier of [SHIPPER, BANK]) {
          const pastRes = await ctx.app.inject({
            method: 'GET',
            url: `/records/${id}/paper`,
            headers: ctx.as(staffOf(earlier, ['bl.read'])),
          });
          expect(pastRes.statusCode).to.equal(403);
          expect(pastRes.json().details.code).to.equal('paper-not-permitted');
        }
      });
    });
  }
});
