import {expect} from 'chai';
import {makeWithEdrms, actor, users, SECRET} from './helpers.js';
import {buildApp} from '../src/app.js';
import {propertyMismatch, sameParcelNumber} from '../src/parcel-match.js';
import {deedMeta, pdfFile} from '../../edrms/tests/helpers.js';

const olympia = {kind: 'erf', number: '2417', township: 'Olympia'};

describe('before creating a land record (API-765)', () => {
  it('says which words of the parcel a property does not name', () => {
    expect(propertyMismatch(olympia, 'ERF NO. 2417 OLYMPIA')).to.equal(null);
    expect(
      propertyMismatch(
        {
          ...olympia,
          township: 'Olympia, situate in the Municipality of Windhoek',
        },
        'ERF NO. 2417 OLYMPIA',
      ),
    ).to.deep.equal({
      missing: ['situate', 'in', 'the', 'municipality', 'of', 'windhoek'],
      otherPortion: false,
    });
    expect(
      propertyMismatch(olympia, 'Portion 3 of Erf 2417, Olympia'),
    ).to.deep.equal({missing: [], otherPortion: true});
    expect(propertyMismatch(olympia, '')).to.deep.equal({
      missing: ['erf', '2417', 'olympia'],
      otherPortion: false,
    });
    // the same number, whatever the township; not another number or a portion
    expect(sameParcelNumber(olympia, 'Erf 2417, Eros')).to.equal(true);
    expect(sameParcelNumber(olympia, 'ERF NO. 24170 OLYMPIA')).to.equal(false);
    expect(
      sameParcelNumber(olympia, 'Portion 1 of Erf 2417, Olympia'),
    ).to.equal(false);
  });

  describe('with documents for Erf 2417, Olympia in edrms', () => {
    let ctx;
    const docs = {};
    const fieldsOf = list => list.map(([k, v]) => ({k, label: k, v}));
    const file = async (sourceId, docType, title, fields) =>
      (
        await ctx.edrmsService.fileDocument({
          meta: deedMeta({sourceId, docType, title, fields: fieldsOf(fields)}),
          file: pdfFile(Buffer.from(`%PDF-1.7 ${sourceId}`)),
        })
      ).document;

    before(async () => {
      ctx = await makeWithEdrms();
      docs.sale = await file('o1', 'deed_of_sale', 'Deed of Sale', [
        [
          'property',
          'Erf 2417, Olympia, situate in the Municipality of Windhoek',
        ],
        ['regDiv', 'K'],
      ]);
      docs.t1998 = await file('o2', 'deed_of_transfer', 'Deed of Transfer', [
        ['deedNo', 'T 3120/1998'],
        ['property', 'ERF NO. 2417 OLYMPIA'],
        ['regDiv', 'K'],
      ]);
      docs.t2014 = await file('o3', 'deed_of_transfer', 'Deed of Transfer', [
        ['deedNo', 'T 2876/2014'],
        ['property', 'ERF NO. 2417 OLYMPIA'],
        ['regDiv', 'K'],
      ]);
      docs.bond = await file('o4', 'mortgage_bond', 'Mortgage Bond', [
        ['bondNo', 'B 1944/2014'],
        ['property', 'ERF NO. 2417 OLYMPIA'],
      ]);
      docs.other = await file('o5', 'deed_of_transfer', 'Deed of Transfer', [
        ['deedNo', 'T 9/2001'],
        ['property', 'ERF NO. 24170 OLYMPIA'],
        ['regDiv', 'K'],
      ]);
    });

    const byId = (p, doc) =>
      p.documents.find(d => d.edrmsDocumentId === doc.id);

    it('shows the parcel as read from the deed of sale, and the documents it does not match', async () => {
      const p = await ctx.service.createPreview({
        edrmsDocumentId: docs.sale.id,
      });
      expect(p.read).to.deep.equal({
        kind: 'erf',
        number: '2417',
        township: 'Olympia, situate in the Municipality of Windhoek',
        regDiv: 'K',
      });
      expect(p.parcel).to.deep.equal(p.read);
      expect(p.missing).to.deep.equal([]);
      expect(p.existing).to.equal(null);
      expect(p.document).to.include({edrmsDocumentId: docs.sale.id});
      expect(p.document.fields).to.deep.include({
        k: 'property',
        label: 'property',
        v: 'Erf 2417, Olympia, situate in the Municipality of Windhoek',
      });
      // the documents with the same erf number, not Erf 24170
      expect(p.documents.map(d => d.edrmsDocumentId).sort()).to.deep.equal(
        [docs.sale, docs.t1998, docs.t2014, docs.bond].map(d => d.id).sort(),
      );
      expect(byId(p, docs.sale)).to.include({chosen: true, matches: true});
      expect(byId(p, docs.t1998)).to.include({chosen: false, matches: false});
      expect(byId(p, docs.t1998).mismatch.missing).to.deep.equal([
        'situate',
        'in',
        'the',
        'municipality',
        'of',
        'windhoek',
      ]);
    });

    it('with the township corrected, all the documents match', async () => {
      const p = await ctx.service.createPreview({
        edrmsDocumentId: docs.sale.id,
        parcel: {...olympia, regDiv: 'K'},
      });
      expect(p.parcel.township).to.equal('Olympia');
      expect(p.read.township).to.equal(
        'Olympia, situate in the Municipality of Windhoek',
      );
      expect(p.documents.every(d => d.matches)).to.equal(true);
      expect(p.documents.some(d => d.mismatch)).to.equal(false);
    });

    it('a bond without a registration division: needed, with the value the other documents agree on', async () => {
      const p = await ctx.service.createPreview({
        edrmsDocumentId: docs.bond.id,
      });
      expect(p.parcel).to.deep.equal(olympia);
      expect(p.missing).to.deep.equal(['regDiv']);
      // the deed of sale names more than the erf: it describes it too, and also says K
      expect(p.suggested).to.deep.equal({regDiv: {value: 'K', from: 3}});
      expect(p.existing).to.equal(null);
    });

    it('a parcel without a document: the documents about it, and no document chosen', async () => {
      const p = await ctx.service.createPreview({
        parcel: {...olympia, regDiv: 'K'},
      });
      expect(p.document).to.equal(null);
      expect(p.read).to.equal(null);
      expect(p.documents).to.have.length(4);
      expect(p.documents.some(d => d.chosen)).to.equal(false);
    });

    it('a parcel that already has a record: the record, and whether the document is in it', async () => {
      const parcel = {...olympia, regDiv: 'K'};
      const r = await ctx.service.createRecord(
        {parcel, edrmsDocumentId: docs.t1998.id},
        actor(users.rec),
      );
      expect(r.draft.data.parcel).to.deep.equal(parcel);
      const withSale = await ctx.service.createPreview({
        edrmsDocumentId: docs.sale.id,
        parcel,
      });
      expect(withSale.existing).to.include({
        id: r.id,
        recordNo: r.recordNo,
        draftVersion: 1,
        draftState: 'draft',
        hasDocument: false,
      });
      const withDeed = await ctx.service.createPreview({
        edrmsDocumentId: docs.t1998.id,
      });
      expect(withDeed.existing).to.include({id: r.id, hasDocument: true});
      // each document says which records already hold it
      expect(byId(withDeed, docs.t1998).linkedTo).to.deep.equal([
        {recordId: r.id, recordNo: r.recordNo, label: 'Erf 2417, Olympia'},
      ]);
      expect(byId(withDeed, docs.sale).linkedTo).to.deep.equal([]);
      // the wrongly read township is another parcel: no existing record
      const asRead = await ctx.service.createPreview({
        edrmsDocumentId: docs.sale.id,
      });
      expect(asRead.existing).to.equal(null);
    });

    it('the check "documents describe this parcel" says, per document, what its property does not name', async () => {
      const r = await ctx.service.createRecord(
        {edrmsDocumentId: docs.sale.id},
        actor(users.rec),
      );
      const linked = await ctx.service.addDocument(
        r.id,
        {revision: r.draft.revision, edrmsDocumentId: docs.bond.id},
        actor(users.rec),
      );
      const c = linked.draft.checks.find(x => x.id === 'parcel_match');
      expect(c.ok).to.equal(false);
      expect(c.details).to.deep.equal(['B 1944/2014']);
      expect(c.mismatches).to.deep.equal([
        {
          edrmsDocumentId: docs.bond.id,
          missing: ['situate', 'in', 'the', 'municipality', 'of', 'windhoek'],
          otherPortion: false,
        },
      ]);
    });

    it('over HTTP: the preview needs record.create, the document details record.view', async () => {
      const app = await buildApp({service: ctx.service, jwtSecret: SECRET});
      await app.ready();
      const as = u => ({
        authorization: `Bearer ${app.jwt.sign({typ: 'access', sub: u.id, name: u.name, perms: u.perms})}`,
      });
      const preview = (u, payload) =>
        app.inject({
          method: 'POST',
          url: '/records/preview',
          headers: as(u),
          payload,
        });
      const ok = await preview(users.rec, {edrmsDocumentId: docs.bond.id});
      expect(ok.statusCode).to.equal(200);
      expect(ok.json().missing).to.deep.equal(['regDiv']);
      expect(
        (await preview(users.sup, {edrmsDocumentId: docs.bond.id})).statusCode,
      ).to.equal(403);
      expect((await preview(users.rec, {})).statusCode).to.equal(400);
      expect(
        (await preview(users.rec, {edrmsDocumentId: 'not-a-uuid'})).statusCode,
      ).to.equal(400);

      const details = await app.inject({
        url: `/records/document-details/${docs.t1998.id}`,
        headers: as(users.sup),
      });
      expect(details.statusCode).to.equal(200);
      expect(details.json()).to.include({ref: 'T 3120/1998'});
      expect(details.json().fields.map(f => f.k)).to.deep.equal([
        'deedNo',
        'property',
        'regDiv',
      ]);
      expect(
        (
          await app.inject({
            url: `/records/document-details/${docs.t1998.id}`,
            headers: as(users.scan),
          })
        ).statusCode,
      ).to.equal(403);
      expect(
        (
          await app.inject({
            url: '/records/document-details/00000000-0000-4000-8000-000000000000',
            headers: as(users.rec),
          })
        ).statusCode,
      ).to.equal(404);
    });
  });
});
