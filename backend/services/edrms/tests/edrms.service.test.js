import { expect } from 'chai';
import { Readable } from 'node:stream';
import { makeService, deedMeta, sgMeta, pdfFile, PDF, REVIEWER } from './helpers.js';
import { normalizeRef, formatEdrmsNo } from '../src/catalogue.js';
import { canonicalJson } from '../src/seal.js';
import { validateRecordMetadata, describeRecordMetadataFields } from '../src/record-metadata.js';

async function rejects(promise, statusCode, messagePart) {
    try {
        await promise;
    } catch (err) {
        expect(err.statusCode, err.message).to.equal(statusCode);
        if (messagePart) expect(err.message).to.include(messagePart);
        return err;
    }
    throw new Error(`expected a ${statusCode} error`);
}

describe('catalogue & seal helpers', () => {
    it('normalizes instrument references', () => {
        expect(normalizeRef('t2210 / 2008')).to.equal('T 2210/2008');
        expect(normalizeRef(' a  412/2007 ')).to.equal('A 412/2007');
        expect(normalizeRef('Estate file 7')).to.equal('ESTATE FILE 7');
        expect(normalizeRef('')).to.equal(null);
    });

    it('formats EDRMS numbers', () => {
        expect(formatEdrmsNo('NA', 2026, 18204)).to.equal('EDR-NA-2026-018204');
    });

    it('canonical JSON is key-order independent', () => {
        expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).to.equal(canonicalJson({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
    });

    it('record metadata: whitelist, validation, deep-cloned description', () => {
        expect(() => validateRecordMetadata({ erf: '1873' })).to.throw(/Unknown record metadata field/);
        expect(() => validateRecordMetadata({ dispositionAction: 'shred' })).to.throw(/Invalid value/);
        const d = describeRecordMetadataFields();
        d.dispositionAction.values.push('shred');
        expect(() => validateRecordMetadata({ dispositionAction: 'shred' })).to.throw();
    });
});

describe('EdrmsService', () => {
    describe('filing', () => {
        it('files a document: EDRMS number, normalized reference, sealed v1.0, record metadata, event', async () => {
            const { service, published, store } = makeService();
            const { document, created } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            expect(created).to.equal(true);
            expect(document).to.include({ edrmsNo: 'EDR-NA-2026-000001', instrumentRef: 'T 2210/2008', currentVersion: 1, registry: 'WDH', batchId: 'WDH-B017' });
            expect(document.props.property).to.equal('Erf 1873, Klein Windhoek');
            expect(document.recordMetadata).to.include({ businessFunction: 'Deeds registration', dispositionAction: 'retain', businessActivity: 'Registration: deed of transfer' });
            expect(document.recordMetadata.agents.map(a => a.role)).to.deep.equal(['capturer', 'reviewer']);

            const v1 = await service.getVersion(document.id, 1);
            expect(v1).to.include({ label: '1.0', kind: 'filed', size: PDF.length, createdById: REVIEWER.id });
            expect(v1.sha256).to.match(/^[0-9a-f]{64}$/);
            expect(v1.seal).to.match(/^[0-9a-f]{64}$/);
            expect(store.blobs.get(v1.storageKey).data.equals(PDF)).to.equal(true);
            expect(published.map(e => e.type)).to.deep.equal(['edrms.document.filed']);
            expect(published[0].data).to.include({ edrmsNo: 'EDR-NA-2026-000001', seal: v1.seal });
        });

        it('stores the filing provenance on v1.0 and seals it', async () => {
            const { service, repo } = makeService();
            const provenance = { provider: 'gemini', model: 'gemini-3.1-flash-lite', promptVersion: 'p1', extracted: { tee2Id: '0111250379' }, corrected: ['tee2Id'] };
            const { document } = await service.fileDocument({ meta: deedMeta({ provenance }), file: pdfFile() });
            const v1 = await service.getVersion(document.id, 1);
            expect(v1.provenance).to.deep.equal(provenance);
            expect((await service.verifyVersion(document.id, 1)).intact).to.equal(true);
            // tampering with the provenance breaks the seal
            const original = repo.getVersion;
            repo.getVersion = async (id, n) => ({ ...(await original(id, n)), provenance: { ...provenance, model: 'something-else' } });
            expect((await service.verifyVersion(document.id, 1)).sealIntact).to.equal(false);
        });

        it('a version without provenance keeps the seal it had before provenance existed', async () => {
            const { sealOf } = await import('../src/seal.js');
            const v = { versionNumber: 1, sha256: 'a'.repeat(64), fields: [{ k: 'deedNo', v: 'T 1/2000' }], recordMetadata: {}, createdAt: '2026-09-28T19:21:00.000Z', createdById: 'u3', approvedById: null };
            expect(sealOf('d1', 'EDR-NA-2026-000001', v)).to.equal(sealOf('d1', 'EDR-NA-2026-000001', { ...v, provenance: null }));
        });

        it('rejects provenance that is not a small object', async () => {
            const { service } = makeService();
            await rejects(service.fileDocument({ meta: deedMeta({ provenance: 'x' }), file: pdfFile() }), 400);
            await rejects(service.fileDocument({ meta: deedMeta({ sourceId: 'p2', provenance: { big: 'x'.repeat(21_000) } }), file: pdfFile() }), 400);
        });

        it('numbers documents sequentially per year', async () => {
            const { service, clock } = makeService();
            await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            const b = await service.fileDocument({ meta: sgMeta(), file: pdfFile() });
            expect(b.document.edrmsNo).to.equal('EDR-NA-2026-000002');
            clock.advance(100 * 86_400_000);
            const c = await service.fileDocument({ meta: deedMeta({ sourceId: 'x', fields: [{ k: 'deedNo', v: 'T 4521/2019' }] }), file: pdfFile() });
            expect(c.document.edrmsNo).to.equal('EDR-NA-2027-000001');
        });

        it('is idempotent on sourceId and stores nothing the second time', async () => {
            const { service, store } = makeService();
            const first = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            const again = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            expect(again).to.deep.include({ created: false });
            expect(again.document.id).to.equal(first.document.id);
            expect(store.blobs.size).to.equal(1);
        });

        it('refuses a second document with the same instrument reference', async () => {
            const { service, store } = makeService();
            await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            const err = await rejects(service.fileDocument({ meta: deedMeta({ sourceId: 'other', fields: [{ k: 'deedNo', v: 'T 2210/2008' }] }), file: pdfFile() }), 409, 'already filed as EDR-NA-2026-000001');
            expect(err.details.field).to.equal('instrumentRef');
            expect(store.blobs.size).to.equal(1);
        });

        it('validates the request before storing content', async () => {
            const { service, store } = makeService();
            await rejects(service.fileDocument({ meta: deedMeta({ docType: 'lease' }), file: pdfFile() }), 400, 'docType');
            await rejects(service.fileDocument({ meta: deedMeta({ fields: [{ k: 'property', v: 'Erf 1' }] }), file: pdfFile() }), 400, '"deedNo"');
            await rejects(service.fileDocument({ meta: deedMeta({ fields: [{ k: 'deedNo', v: 1 }] }), file: pdfFile() }), 400);
            await rejects(service.fileDocument({ meta: deedMeta({ recordMetadata: { erf: 1 } }), file: pdfFile() }), 400);
            await rejects(service.fileDocument({ meta: deedMeta(), file: { ...pdfFile(), mimeType: 'text/html' } }), 400);
            await rejects(service.fileDocument({ meta: deedMeta({ reviewedBy: undefined }), file: pdfFile() }), 400);
            expect(store.blobs.size).to.equal(0);
        });

        it('deletes stored content when the record cannot be committed', async () => {
            const { service, store, repo } = makeService();
            repo.createDocument = async () => { throw new Error('db down'); };
            await rejects(service.fileDocument({ meta: deedMeta(), file: pdfFile() }).catch(e => { e.statusCode = 500; throw e; }), 500);
            expect(store.blobs.size).to.equal(0);
        });

        it('rejects an empty file and cleans up', async () => {
            const { service, store } = makeService();
            await rejects(service.fileDocument({ meta: deedMeta(), file: { ...pdfFile(), stream: Readable.from([]) } }), 400, 'empty');
            expect(store.blobs.size).to.equal(0);
        });
    });

    describe('amendments', () => {
        it('corrects fields as a new sealed major version; v1 is untouched', async () => {
            const { service, published } = makeService();
            const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            const v1 = await service.getVersion(document.id, 1);
            const actor = { id: 'u3', name: 'Aina Mwandingi' };

            const { document: updated, version } = await service.amendDocument({
                id: document.id, expectedVersion: 1, reason: 'ID hand-corrected on the original', changes: [{ k: 'tee2Id', v: '75060200419' }], actor,
                approvedBy: { id: 'u8', name: 'Tangeni Iita' }
            });
            expect(updated.currentVersion).to.equal(2);
            expect(version).to.include({ approvedById: 'u8' });
            expect((await service.verifyVersion(document.id, 2)).intact).to.equal(true);
            expect(updated.props.tee2Id).to.equal('75060200419');
            expect(version).to.include({ label: '2.0', kind: 'amendment', reason: 'ID hand-corrected on the original', sha256: v1.sha256 });
            expect(version.changes).to.deep.equal([{ k: 'tee2Id', from: '75060200418', to: '75060200419' }]);
            expect(version.seal).to.not.equal(v1.seal);
            expect(version).to.not.have.property('storageKey');

            const again = await service.getVersion(document.id, 1);
            expect(again.fields.find(f => f.k === 'tee2Id').v).to.equal('75060200418');
            expect(published.map(e => e.type)).to.deep.equal(['edrms.document.filed', 'edrms.document.amended']);
        });

        it('replaces the file (e.g. after a rescan) under a new key', async () => {
            const { service, store } = makeService();
            const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            const better = Buffer.from('%PDF-1.7\n% rescanned at 600 dpi\n%%EOF\n');
            const { version } = await service.amendDocument({ id: document.id, reason: 'Page 3 rescanned', file: pdfFile(better), actor: { id: 'u3', name: 'A' } });
            expect(version.changes[0].k).to.equal('(file)');
            expect(store.blobs.size).to.equal(2);
            const v2 = await service.getVersion(document.id, 2);
            expect(store.blobs.get(v2.storageKey).data.equals(better)).to.equal(true);
        });

        it('requires a reason, a real change, known fields and the current version', async () => {
            const { service } = makeService();
            const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            await rejects(service.amendDocument({ id: document.id, reason: 'x', changes: [{ k: 'regDiv', v: 'L' }] }), 400, 'reason');
            await rejects(service.amendDocument({ id: document.id, reason: 'No change at all', changes: [{ k: 'regDiv', v: 'K' }] }), 400, 'Nothing to amend');
            await rejects(service.amendDocument({ id: document.id, reason: 'Unknown field', changes: [{ k: 'owner', v: 'X' }] }), 400);
            await service.amendDocument({ id: document.id, reason: 'Division misread', changes: [{ k: 'regDiv', v: 'L' }], expectedVersion: 1 });
            await rejects(service.amendDocument({ id: document.id, reason: 'Stale edit here', changes: [{ k: 'regDiv', v: 'M' }], expectedVersion: 1 }), 409);
            await rejects(service.amendDocument({ id: 'missing', reason: 'Nope nope', changes: [] }), 404);
        });

        it('changing the deed number keeps references unique', async () => {
            const { service } = makeService();
            const a = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            await service.fileDocument({ meta: deedMeta({ sourceId: 'c', fields: [{ k: 'deedNo', v: 'T 4521/2019' }] }), file: pdfFile() });
            await rejects(service.amendDocument({ id: a.document.id, reason: 'Wrong number', changes: [{ k: 'deedNo', v: 'T 4521/2019' }] }), 409);
            const ok = await service.amendDocument({ id: a.document.id, reason: 'Misread digit', changes: [{ k: 'deedNo', v: 'T 2211/2008' }] });
            expect(ok.document.instrumentRef).to.equal('T 2211/2008');
        });
    });

    describe('reading & integrity', () => {
        it('lists and filters by type, batch, field values and text', async () => {
            const { service } = makeService();
            await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            await service.fileDocument({ meta: sgMeta(), file: pdfFile() });
            await service.fileDocument({ meta: deedMeta({ sourceId: 'z', batchId: 'WDH-B015', fields: [{ k: 'deedNo', v: 'T 1/2011' }, { k: 'property', v: 'Erf 2001, Eros' }] }), file: pdfFile() });

            expect((await service.searchDocuments({})).total).to.equal(3);
            expect((await service.searchDocuments({ docType: 'sg_diagram' })).items.map(d => d.instrumentRef)).to.deep.equal(['A 412/2007']);
            expect((await service.searchDocuments({ batchId: 'WDH-B015' })).total).to.equal(1);
            expect((await service.searchDocuments({ props: { property: 'Erf 1873, Klein Windhoek' } })).total).to.equal(2);
            expect((await service.searchDocuments({ q: 'eros' })).total).to.equal(1);
            expect((await service.searchDocuments({ q: 'EDR-NA-2026-000002' })).items[0].docType).to.equal('sg_diagram');
            await rejects(service.searchDocuments({ docType: 'lease' }), 400);
        });

        it('looks documents up by EDRMS number, reference or intake id', async () => {
            const { service } = makeService();
            const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            expect((await service.findByReference({ instrumentRef: 't 2210/2008' })).id).to.equal(document.id);
            expect((await service.findByReference({ edrmsNo: 'EDR-NA-2026-000001' })).id).to.equal(document.id);
            expect((await service.findByReference({ sourceId: 'intake-doc-a' })).id).to.equal(document.id);
            await rejects(service.findByReference({ instrumentRef: 'T 9/1999' }), 404);
        });

        it('verifies content and seal, and detects tampering with either', async () => {
            const { service, store, repo } = makeService();
            const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            expect((await service.verifyVersion(document.id, 1)).intact).to.equal(true);

            const v1 = await repo.getVersion(document.id, 1);
            store.blobs.get(v1.storageKey).data = Buffer.from('%PDF forged');
            const res = await service.verifyVersion(document.id, 1);
            expect(res).to.include({ intact: false, contentIntact: false });
        });

        it('detects metadata changed behind the service', async () => {
            const { service, store } = makeService();
            // Reach into the memory repo's stored version to simulate a direct DB edit.
            const repo = service.repo;
            const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
            const original = repo.getVersion;
            repo.getVersion = async (id, n) => {
                const v = await original(id, n);
                v.fields[1].v = 'Erf 9999, Klein Windhoek';
                return v;
            };
            const res = await service.verifyVersion(document.id, 1);
            expect(res).to.include({ contentIntact: true, sealIntact: false, intact: false });
            expect(store.blobs.size).to.equal(1);
        });
    });
});
