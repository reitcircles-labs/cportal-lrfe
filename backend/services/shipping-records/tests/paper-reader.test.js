import {createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {createPaperBlReader} from '../src/paper-reader.js';
import {makeHttp, stores, users} from './helpers.js';

describe('reading paper B/Ls automatically (CB-57), memory', () => {
  it('requires bl.draft and rejects unsupported types, empty files, oversized files, and unconfigured gemini', async () => {
    const ctx = await makeHttp(stores()[0]);
    try {
      const denied = await ctx.app.inject({
        method: 'POST',
        url: '/records/read-paper',
        headers: ctx.as(users.aReader),
        payload: {
          fileName: 'bl.pdf',
          mimeType: 'application/pdf',
          contentBase64: Buffer.from('%PDF-1.4\n').toString('base64'),
        },
      });
      expect(denied.statusCode).to.equal(403);

      const badType = await ctx.app.inject({
        method: 'POST',
        url: '/records/read-paper',
        headers: ctx.as(users.a1),
        payload: {
          fileName: 'bl.exe',
          mimeType: 'application/x-msdownload',
          contentBase64: Buffer.from('MZ').toString('base64'),
        },
      });
      expect(badType.statusCode).to.equal(400);

      const empty = await ctx.app.inject({
        method: 'POST',
        url: '/records/read-paper',
        headers: ctx.as(users.a1),
        payload: {
          fileName: 'blank.pdf',
          mimeType: 'application/pdf',
          contentBase64: '',
        },
      });
      expect(empty.statusCode).to.equal(400);

      const tooBig = await ctx.app.inject({
        method: 'POST',
        url: '/records/read-paper',
        headers: ctx.as(users.a1),
        payload: {
          fileName: 'huge.pdf',
          mimeType: 'application/pdf',
          contentBase64: Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64'),
        },
      });
      expect(tooBig.statusCode).to.equal(400);

      // Over 1 MiB JSON body (within 15 MB scan limit) succeeds via route bodyLimit
      const overOneMib = await ctx.app.inject({
        method: 'POST',
        url: '/records/read-paper',
        headers: ctx.as(users.a1),
        payload: {
          fileName: 'medium-scan.pdf',
          mimeType: 'application/pdf',
          contentBase64: Buffer.alloc(1_200_000, 0x25).toString('base64'),
        },
      });
      expect(overOneMib.statusCode).to.equal(200);
    } finally {
      await ctx.close?.();
    }

    expect(() => createPaperBlReader({provider: 'unknown'})).to.throw(
      /EXTRACTION_PROVIDER/,
    );
    const geminiNoKey = createPaperBlReader({provider: 'gemini', apiKey: ''});
    let err;
    try {
      await geminiNoKey.read({
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4\n').toString('base64'),
      });
    } catch (caught) {
      err = caught;
    }
    expect(err?.statusCode).to.equal(503);
    expect(err?.details?.code).to.equal('reading-unavailable');
  });

  it('extracts B/L fields, resolves ports/parties (including straight consignee and unmatched warnings), and flags uncertain fields', async () => {
    const fakePorts = {
      get: code => (code === 'DKAAR' ? {code: 'DKAAR', name: 'Aarhus'} : null),
      search: query =>
        query.toLowerCase().includes('rotterdam')
          ? [{code: 'NLRTM', name: 'Rotterdam'}]
          : [],
    };
    const ctx = await makeHttp(stores()[0], {
      signer: await createLocalSigner(),
      ports: fakePorts,
      organisations: {
        async standingOf() {
          return 'active';
        },
        async activeOrganisations() {
          return [
            {
              id: 'org-shipper',
              code: 'HCEX',
              name: 'Highland Coffee Exporters',
            },
            {
              id: 'org-buyer',
              code: 'RCI',
              name: 'Roastery Collective Imports',
            },
          ];
        },
      },
    });
    try {
      const samplePaper = JSON.stringify({
        reference: 'PAPER-2026-001',
        carrierCode: 'BWML',
        bookingReference: 'BKG-884120',
        toOrder: 'false',
        shipperName: 'Highland Coffee Exporters',
        consigneeName: 'Unknown Buyer Co',
        vesselName: 'MV Atlantic Crest',
        voyageNumber: '2611N',
        portOfLoading: 'dkaar',
        portOfDischarge: 'Rotterdam',
        containerNumber: 'MSKU7045123',
        isoEquipmentCode: '22G1',
        sealNumber: 'SL220871',
        goods: '640 bags green coffee',
        hsCode: '090111',
        packages: 640,
        packageDescription: 'Bags',
        grossWeightKg: 38040,
        uncertain: ['grossWeightKg'],
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/records/read-paper',
        headers: ctx.as(users.a1),
        payload: {
          fileName: 'scanned-bl.pdf',
          mimeType: 'application/pdf',
          contentBase64: Buffer.from(samplePaper).toString('base64'),
        },
      });
      expect(res.statusCode, res.body).to.equal(200);
      const body = res.json();
      expect(body.fileName).to.equal('scanned-bl.pdf');
      expect(body.fields).to.include({
        reference: 'PAPER-2026-001',
        carrierCode: 'BWML',
        toOrder: false,
        shipperId: 'org-shipper',
        portOfLoading: 'DKAAR',
        portOfDischarge: 'NLRTM',
        packages: 640,
        grossWeightKg: 38040,
      });
      expect(body.uncertain).to.include.members([
        'grossWeightKg',
        'consigneeId',
      ]);
      expect(body.warnings[0]).to.include('Unknown Buyer Co');
      expect(body.summary).to.be.a('string').and.not.be.empty;

      // Also works on raw binary PDF/PNG scans without embedded JSON (mock fallback)
      const binaryRes = await ctx.app.inject({
        method: 'POST',
        url: '/records/read-paper',
        headers: ctx.as(users.a1),
        payload: {
          fileName: 'scan-photo.png',
          mimeType: 'image/png',
          contentBase64: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 1, 2, 3,
          ]).toString('base64'),
        },
      });
      expect(binaryRes.statusCode).to.equal(200);
      expect(binaryRes.json().fields.reference).to.be.a('string').and.not.be
        .empty;
      expect(binaryRes.json().uncertain.length).to.be.greaterThan(0);
    } finally {
      await ctx.close?.();
    }
  });
});
