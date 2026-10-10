import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPack, verifyPack, recordSeal, documentSeal } from '../verifier/lrfe-verify.mjs';
import { zip } from '../src/zip.js';
import { sealOf as landRecordSeal } from '../../land-records/src/seal.js';
import { sealOf as edrmsSeal } from '../../edrms/src/seal.js';
import { people, audited, publicSource, secondVersion } from './register.js';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The pack as the auditor downloads it (over HTTP), unpacked by the verifier's own reader. */
async function download(a, u = people.aud) {
    const res = await a.auditApp.inject({ url: `/audit/records/${a.record.id}/evidence`, headers: a.as(u) });
    await a.settle();
    return res;
}
const filesOf = (res) => {
    const dir = mkdtempSync(join(tmpdir(), 'lrfe-pack-'));
    try {
        writeFileSync(join(dir, 'pack.zip'), res.rawPayload);
        return readPack(join(dir, 'pack.zip'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
};
/** Change a file in the pack; with `manifest`, also rewrite manifest.json to match (a careful forger). */
function tamper(files, path, change, { manifest = false } = {}) {
    const out = new Map(files);
    out.set(path, Buffer.from(change(out.get(path))));
    if (manifest) {
        const m = JSON.parse(out.get('manifest.json').toString());
        m.files = m.files.map(f => (f.path === path ? { ...f, sha256: sha256(out.get(path)), bytes: out.get(path).length } : f));
        out.set('manifest.json', Buffer.from(JSON.stringify(m, null, 2)));
    }
    return out;
}
/** The manifest rewritten to match the files as they are now (a forger who adds, removes or changes files). */
function remanifest(files) {
    const out = new Map(files);
    const m = JSON.parse(out.get('manifest.json').toString());
    m.files = [...out.keys()].filter(p => p !== 'manifest.json').map(path => ({ path, sha256: sha256(out.get(path)), bytes: out.get(path).length }));
    out.set('manifest.json', Buffer.from(JSON.stringify(m, null, 2)));
    return out;
}
const editJson = (fn) => (buf) => { const v = JSON.parse(buf.toString()); fn(v); return JSON.stringify(v, null, 2); };
const failed = (r) => r.checks.filter(c => !c.ok).map(c => c.name);

/** Erf 1873 committed, signed off, a finding raised and closed, then anchored and confirmed. */
async function auditedAndAnchored() {
    const a = await audited();
    assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, comment: 'Deeds, diagram and owners reconcile' })).statusCode, 201);
    assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, documentId: a.docs.sg.id, comment: 'Diagram matches the extent' })).statusCode, 201);
    const f = (await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'Owner ID number hard to read on T 1502/1996' })).json();
    assert.equal((await a.api(people.aud2, 'POST', `/audit/findings/${f.id}/close`, { reason: 'Readable on the original in the vault' })).statusCode, 200);
    await a.anchor();
    return a;
}

describe('evidence pack (API-660)', () => {
    it('the export of Erf 1873 holds every version, document, file, trail entry, sign-off, finding and proof; the offline verifier checks all of it', async () => {
        const a = await auditedAndAnchored();
        const res = await download(a);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'application/zip');
        assert.match(res.headers['content-disposition'], new RegExp(`^attachment; filename="evidence-${a.record.recordNo}-\\d{4}-\\d{2}-\\d{2}\\.zip"$`));
        const files = filesOf(res);
        const names = [...files.keys()];
        const manifest = JSON.parse(files.get('manifest.json'));
        assert.equal(manifest.format, 'lrfe-evidence-pack/1');
        assert.deepEqual([manifest.record.recordNo, manifest.exportedBy.name, manifest.anchoring.network], [a.record.recordNo, 'Martha Nakale', 'preview']);
        assert.equal(manifest.files.length, names.length - 1);
        // every committed version (one here), and every document it pins with its file
        assert.ok(names.includes('record/versions/v1.json') && names.includes('record/record.json'));
        const pinned = a.record.current.data.documents;
        assert.equal(pinned.length, 5);
        for (const d of pinned) {
            const meta = JSON.parse(files.get(`documents/${d.edrmsNo}/v${d.version}.json`));
            assert.equal(meta.seal, d.seal);
            const file = files.get(`documents/${d.edrmsNo}/${meta.file}`);
            const stored = await a.edrmsService.openContent(d.edrmsDocumentId, d.version);
            const chunks = []; for await (const c of stored.stream) chunks.push(c);
            assert.deepEqual(file, Buffer.concat(chunks), 'the file as stored');
            assert.ok(names.includes(`proofs/${d.edrmsNo}-v${d.version}.json`));
        }
        // the whole trail of the record, a proof for each entry, the sign-offs and the finding
        const trail = JSON.parse(files.get('trail/entries.json'));
        const expected = (await a.trail.list({ subject: `record:${a.record.id}`, limit: 500 })).entries.filter(e => e.type !== 'audit.evidence.exported');
        assert.deepEqual(trail.map(e => e.seq), expected.map(e => e.seq));
        for (const e of trail) assert.ok(names.includes(`proofs/trail-${e.seq}.json`), `proof of entry ${e.seq}`);
        assert.equal(JSON.parse(files.get('signoffs.json')).length, 2);
        assert.deepEqual(JSON.parse(files.get('findings.json')).map(f => f.status), ['closed']);
        assert.ok(names.includes('proofs/record-v1.json'));
        const readme = files.get('README.txt').toString();
        assert.match(readme, new RegExp(`Evidence pack: land record ${a.record.recordNo}`));
        assert.match(readme, /node lrfe-verify\.mjs <this-pack>\.zip --address/);

        // the export is a trail entry: who, which record, the manifest's hash
        const exported = (await a.trail.list({ type: 'audit.evidence.exported' })).entries;
        assert.equal(exported.length, 1);
        assert.deepEqual([exported[0].actor.name, exported[0].data.recordId, exported[0].data.manifestSha256], ['Martha Nakale', a.record.id, sha256(files.get('manifest.json'))]);
        assert.equal(res.headers['x-manifest-sha256'], exported[0].data.manifestSha256);

        // the offline verifier: everything checks out, every proof on chain, nothing waiting
        const r = await verifyPack(files, { address: await a.cardano.address(), fetchImpl: publicSource(a.driver) });
        assert.equal(r.valid, true, JSON.stringify(r.checks.filter(c => !c.ok)));
        assert.deepEqual(r.unproven, []);
        const n = trail.length + 1 + 5;
        assert.equal(r.checks.find(c => c.name === 'proofs on chain').detail, `${n} proofs checked against the chain; ${n} of ${n} items proven`);
    });

    it('changing any file in the pack makes its check fail, also when the forger rewrites the manifest', async () => {
        const a = await auditedAndAnchored();
        const files = filesOf(await download(a));
        const check = (f) => verifyPack(f, { fetchImpl: publicSource(a.driver) });
        assert.equal((await check(files)).valid, true);
        // any file at all, one byte: the manifest no longer matches
        for (const path of [...files.keys()].filter(p => p !== 'manifest.json')) {
            const r = await check(tamper(files, path, (b) => Buffer.concat([b, Buffer.from(' ')])));
            assert.equal(r.valid, false, path);
            assert.ok(failed(r).includes('files as exported'), path);                // a document's file also fails its own SHA-256
        }
        // a file added, or one removed
        const added = new Map(files); added.set('documents/extra.pdf', Buffer.from('%PDF'));
        assert.deepEqual(failed(await check(added)), ['files as exported']);
        const removed = new Map(files); removed.delete('signoffs.json');
        assert.ok(failed(await check(removed)).includes('files as exported'));
        // with the manifest rewritten to match, the content checks still catch it
        const v1 = 'record/versions/v1.json';
        // the version's seal no longer recomputes from its content
        assert.deepEqual(failed(await check(tamper(files, v1, editJson(v => { v.data.extent.value = 9999; }), { manifest: true }))), ['land record version 1']);
        const sg = [...files.keys()].find(p => /^documents\/[^/]+\/v1\.json$/.test(p) && JSON.parse(files.get(p)).docType === 'sg_diagram');
        const sgFile = `${sg.slice(0, sg.lastIndexOf('/'))}/${JSON.parse(files.get(sg)).file}`;
        assert.deepEqual(failed(await check(tamper(files, sgFile, (b) => Buffer.from(b.toString('latin1').replace('PDF', 'PDG'), 'latin1'), { manifest: true }))), [`${JSON.parse(files.get(sg)).edrmsNo} version 1`]);
        const sgNo = JSON.parse(files.get(sg)).edrmsNo;
        assert.deepEqual(failed(await check(tamper(files, sg, editJson(v => { v.fields[0].v = 'A 999/2007'; }), { manifest: true }))), [`${sgNo} version 1`]);
        const trail = 'trail/entries.json';
        const t = await check(tamper(files, trail, editJson(es => { es[0].actor.name = 'Someone Else'; }), { manifest: true }));
        assert.ok(failed(t).includes('trail entries'));
        assert.deepEqual(failed(await check(tamper(files, 'signoffs.json', editJson(ss => { ss[0].comment = 'Not checked'; }), { manifest: true }))), ['sign-offs']);
        assert.deepEqual(failed(await check(tamper(files, 'findings.json', editJson(fs => { fs[0].status = 'open'; }), { manifest: true }))), ['findings']);
        const r1 = await check(tamper(files, 'proofs/record-v1.json', editJson(p => { p.tree.path[0] = 'ab'.repeat(32); }), { manifest: true }));
        assert.deepEqual(failed(r1), ['proofs/record-v1.json']);
        // a proof of some other item put in its place
        const other = [...files.keys()].find(p => /^proofs\/EDR-/.test(p));
        assert.deepEqual(failed(await check(tamper(files, 'proofs/record-v1.json', () => files.get(other), { manifest: true }))), ['proofs/record-v1.json']);
    });

    it('a careful forger who drops, replaces or adds items, and rewrites the manifest, is caught', async () => {
        const a = await auditedAndAnchored();
        await secondVersion(a);
        await a.anchor();
        const files = filesOf(await download(a));
        const check = (f) => verifyPack(remanifest(f), { fetchImpl: publicSource(a.driver) });
        const ok = await check(files);
        assert.equal(ok.valid, true, JSON.stringify(ok.checks.filter(c => !c.ok)));
        assert.deepEqual(ok.unproven, []);
        const without = (...paths) => { const f = new Map(files); for (const p of paths) f.delete(p); return f; };
        const docJson = (type) => [...files.keys()].find(p => /^documents\/[^/]+\/v1\.json$/.test(p) && JSON.parse(files.get(p)).docType === type);
        const sg = docJson('sg_diagram');
        const sgMeta = JSON.parse(files.get(sg));
        const sgFile = `${sg.slice(0, sg.lastIndexOf('/'))}/${sgMeta.file}`;
        const sgProof = `proofs/${sgMeta.edrmsNo}-v1.json`;

        // a document dropped entirely
        assert.ok(failed(await check(without(sg, sgFile, sgProof))).includes(`${sgMeta.edrmsNo} version 1`));
        // a forged file: SHA-256 and seal recomputed, its proof deleted, or replaced by a "waiting" placeholder
        const forged = new Map(files);
        const bytes = Buffer.from('%PDF-1.7 a forged diagram');
        forged.set(sgFile, bytes);
        const meta = { ...sgMeta, sha256: sha256(bytes) };
        meta.seal = documentSeal(meta);
        forged.set(sg, Buffer.from(JSON.stringify(meta)));
        forged.delete(sgProof);
        let r = await check(forged);
        assert.ok(failed(r).includes(`${sgMeta.edrmsNo} version 1`), JSON.stringify(failed(r)));      // not the seal version 1 pins
        assert.ok(failed(r).includes('proof files'));
        forged.set(sgProof, Buffer.from(JSON.stringify({ format: 'lrfe-audit-proof/1', status: 'waiting', item: { kind: 'document-version', seal: meta.seal } })));
        assert.ok(failed(await check(forged)).includes(`${sgMeta.edrmsNo} version 1`));
        // a document no version pins, and a proof of nothing in the pack
        const extraDoc = new Map(files); extraDoc.set('documents/EDR-X/v1.json', Buffer.from(JSON.stringify({ ...sgMeta, documentId: '00000000-0000-4000-8000-000000000001' })));
        assert.ok(failed(await check(extraDoc)).includes('documents'));
        const extraProof = new Map(files); extraProof.set('proofs/record-v9.json', files.get('proofs/record-v1.json'));
        assert.ok(failed(await check(extraProof)).includes('proof files'));

        // versions: the last dropped (record.json still says 2), the first dropped, one unreadable
        assert.ok(failed(await check(without('record/versions/v2.json', 'proofs/record-v2.json'))).includes('record'));
        assert.ok(failed(await check(without('record/versions/v1.json', 'proofs/record-v1.json'))).includes('land record version 2'));
        assert.ok(failed(await check(tamper(files, 'record/versions/v1.json', () => 'not json'))).includes('files readable'));

        // a trail entry forged with fresh hashes, its proof replaced by a "waiting" placeholder holding it
        const entries = JSON.parse(files.get('trail/entries.json'));
        const target = entries[1];
        const fake = { ...target, data: { ...target.data, forged: true } };
        fake.contentHash = (await import('../src/chain.js')).contentHash(fake);
        fake.hash = (await import('../src/chain.js')).chainHash(fake.prevHash, fake.contentHash);
        const t = new Map(files);
        t.set('trail/entries.json', Buffer.from(JSON.stringify(entries.map(e => (e.seq === target.seq ? fake : e)))));
        t.set(`proofs/trail-${target.seq}.json`, Buffer.from(JSON.stringify({ format: 'lrfe-audit-proof/1', status: 'waiting', item: { kind: 'trail-entry', seq: target.seq }, trail: { entry: fake, later: [], checkpoint: null }, leaf: null, tree: null, anchor: null })));
        assert.ok(failed(await check(t)).includes(`trail entry ${target.seq}`), JSON.stringify(failed(await check(t))));

        // sign-offs and findings: a field changed, or a row dropped while its trail entry stays
        assert.ok(failed(await check(tamper(files, 'signoffs.json', editJson(ss => { ss[0].recordVersion = 2; })))).includes('sign-offs'));
        assert.ok(failed(await check(tamper(files, 'signoffs.json', editJson(ss => { ss[0].signedByName = 'Someone Else'; })))).includes('sign-offs'));
        assert.ok(failed(await check(tamper(files, 'findings.json', editJson(fs => { fs[0].raisedByName = 'Someone Else'; })))).includes('findings'));
        assert.ok(failed(await check(tamper(files, 'findings.json', editJson(fs => { fs[0].closeReason = 'Other reason'; })))).includes('findings'));
        assert.ok(failed(await check(tamper(files, 'findings.json', () => '[]'))).includes('findings'));

        // record.json: what can be cross-checked is; the rest is listed as not covered by a seal
        assert.ok(failed(await check(tamper(files, 'record/record.json', editJson(rec => { rec.currentVersion = 1; })))).includes('record'));
        const label = await check(tamper(files, 'record/record.json', editJson(rec => { rec.label = 'Erf 9999, Elsewhere'; })));
        assert.equal(label.valid, true);
        assert.ok(label.notes.some(n => /^Not covered by any seal, shown as exported: README\.txt/.test(n)));
        assert.ok(label.notes.some(n => /cannot show that nothing was left out/.test(n)));
    });

    it('an item forged behind a placeholder proof is caught by its anchored commit or filing entry, and by every version that pins it', async () => {
        const a = await auditedAndAnchored();
        const files = filesOf(await download(a));
        const check = (f) => verifyPack(remanifest(f), { fetchImpl: publicSource(a.driver) });
        // the anchored version 1 forged, its seal recomputed, its proof a placeholder
        const f1 = new Map(files);
        const v1 = JSON.parse(files.get('record/versions/v1.json'));
        v1.data.extent.value = 9999;
        v1.seal = recordSeal({ ...v1, recordNo: a.record.recordNo });
        f1.set('record/versions/v1.json', Buffer.from(JSON.stringify(v1)));
        f1.set('proofs/record-v1.json', Buffer.from(JSON.stringify({ format: 'lrfe-audit-proof/1', status: 'not in the audit tree', item: { kind: 'record-version', seal: v1.seal } })));
        const r1 = await check(f1);
        assert.equal(r1.valid, false);
        assert.ok(r1.checks.some(c => !c.ok && c.name === 'land record version 1' && /commit entry/.test(c.detail)), JSON.stringify(r1.checks.filter(c => !c.ok)));
        // the same with its commit entry and that entry's proof removed: unproven and bound to no commit entry
        // (and older than anchored entries) is not believable
        const commit = JSON.parse(files.get('trail/entries.json')).find(e => e.type === 'records.record.committed');
        f1.set('trail/entries.json', Buffer.from(JSON.stringify(JSON.parse(files.get('trail/entries.json')).filter(e => e.seq !== commit.seq))));
        f1.delete(`proofs/trail-${commit.seq}.json`);
        const r1b = await check(f1);
        assert.equal(r1b.valid, false);
        assert.ok(r1b.checks.some(c => !c.ok && c.name === 'land record version 1' && /commit or filing is not in the pack's trail|should be in that anchoring/.test(c.detail)), JSON.stringify(r1b.checks.filter(c => !c.ok)));

        // version 2 committed after the anchoring; a document forged through it while anchored version 1 pins the original
        await secondVersion(a);
        const files2 = filesOf(await download(a));
        const doc = JSON.parse(files2.get([...files2.keys()].find(p => /^documents\/[^/]+\/v1\.json$/.test(p))));
        const dir = `documents/${doc.edrmsNo}`;
        const f2 = new Map(files2);
        const bytes = Buffer.from('%PDF-1.7 forged');
        const forgedDoc = { ...doc, sha256: sha256(bytes) };
        forgedDoc.seal = documentSeal(forgedDoc);
        f2.set(`${dir}/${doc.file}`, bytes);
        f2.set(`${dir}/v1.json`, Buffer.from(JSON.stringify(forgedDoc)));
        f2.set(`proofs/${doc.edrmsNo}-v1.json`, Buffer.from(JSON.stringify({ format: 'lrfe-audit-proof/1', status: 'not in the audit tree', item: { kind: 'document-version', seal: forgedDoc.seal } })));
        const v2 = JSON.parse(files2.get('record/versions/v2.json'));
        v2.data.documents = v2.data.documents.map(d => (d.edrmsDocumentId === doc.documentId ? { ...d, seal: forgedDoc.seal } : d));
        v2.seal = recordSeal({ ...v2, recordNo: a.record.recordNo });
        f2.set('record/versions/v2.json', Buffer.from(JSON.stringify(v2)));
        f2.set('proofs/record-v2.json', Buffer.from(JSON.stringify({ format: 'lrfe-audit-proof/1', status: 'waiting', item: { kind: 'record-version', seal: v2.seal } })));
        const r2 = await check(f2);
        assert.equal(r2.valid, false);
        const reasons = r2.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);
        assert.ok(reasons.some(x => x.includes(`${doc.edrmsNo} version 1: its seal is not the one land record version 1 pins`)), JSON.stringify(reasons));
        assert.ok(reasons.some(x => x.includes('filing entry')));
    });

    it('the export refuses a stored file that no longer matches its seal, and names the document', async () => {
        const a = await audited();
        const open = a.edrmsService.openContent.bind(a.edrmsService);
        a.edrmsService.openContent = async (id, n) => {
            const c = await open(id, n);
            if (id !== a.docs.sg.id) return c;
            const { Readable } = await import('node:stream');
            return { ...c, stream: Readable.from([Buffer.from('changed in the store')]) };
        };
        const res = await download(a);
        assert.equal(res.statusCode, 409);
        assert.match(res.json().message, /^The stored file of EDR-NA-\d{4}-\d+ version 1 does not match the SHA-256 it was sealed with/);
        assert.equal((await a.trail.list({ type: 'audit.evidence.exported' })).total, 0);
    });

    it('a pack exported before the next anchoring is valid, and names what is still waiting', async () => {
        const a = await audited();
        await a.anchor();
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, comment: 'Reconciled after the anchoring' })).statusCode, 201);
        const files = filesOf(await download(a));
        const r = await verifyPack(files, { fetchImpl: publicSource(a.driver) });
        assert.equal(r.valid, true, JSON.stringify(r.checks.filter(c => !c.ok)));
        const signoffEntry = JSON.parse(files.get('trail/entries.json')).find(e => e.type === 'audit.signoff.recorded');
        assert.deepEqual(r.unproven, [`trail entry ${signoffEntry.seq}`]);
        assert.ok(r.notes.some(n => /Export the pack again after the next anchoring, or check them with the portal/.test(n)));
    });

    it('only auditors who may export; a record with no committed version has nothing to export', async () => {
        const a = await audited();
        const res = await a.auditApp.inject({ url: `/audit/records/${a.record.id}/evidence`, headers: a.as(people.aud2) });     // no audit.export
        assert.equal(res.statusCode, 403);
        assert.equal((await a.trail.list({ type: 'audit.evidence.exported' })).total, 0);
        const draft = await a.service.createRecord({ parcel: { kind: 'erf', number: '3329', township: 'Olympia', regDiv: 'K' } }, { id: 'u7', name: 'Josef Gawaseb' });
        const none = await a.auditApp.inject({ url: `/audit/records/${draft.id}/evidence`, headers: a.as(people.aud) });
        assert.equal(none.statusCode, 409);
        assert.equal((await a.auditApp.inject({ url: '/audit/records/00000000-0000-4000-8000-000000000000/evidence', headers: a.as(people.aud) })).statusCode, 404);
    });

    it('the verifier recomputes seals exactly as land-records and edrms do; packs are plain zip files', async () => {
        const a = await audited();
        const v = await a.service.repo.getVersion(a.record.id, 1);
        assert.equal(recordSeal({ ...JSON.parse(JSON.stringify(v)), recordNo: a.record.recordNo }), landRecordSeal(a.record, v));
        const doc = await a.edrmsService.getDocument(a.docs.t2019.id);
        const dv = a.edrmsService.publicVersion(await a.edrmsService.getVersion(doc.id, 1));
        assert.equal(documentSeal({ ...JSON.parse(JSON.stringify(dv)), documentId: doc.id, edrmsNo: doc.edrmsNo }), edrmsSeal(doc.id, doc.edrmsNo, dv));
        // a zip any unzip tool reads, and the verifier also takes the unpacked folder
        const dir = mkdtempSync(join(tmpdir(), 'lrfe-zip-'));
        try {
            const z = zip([{ path: 'a.txt', data: 'hello '.repeat(100) }, { path: 'docs/b.bin', data: Buffer.from([0, 1, 2, 255]) }]);
            writeFileSync(join(dir, 'x.zip'), z);
            let unzipped = null;
            try { unzipped = execFileSync('unzip', ['-p', join(dir, 'x.zip'), 'a.txt']).toString(); } catch { /* no unzip here */ }
            if (unzipped !== null) assert.equal(unzipped, 'hello '.repeat(100));
            const files = readPack(join(dir, 'x.zip'));
            assert.deepEqual([files.get('a.txt').toString(), [...files.get('docs/b.bin')]], ['hello '.repeat(100), [0, 1, 2, 255]]);
            execFileSync('mkdir', ['-p', join(dir, 'u', 'docs')]);
            writeFileSync(join(dir, 'u', 'a.txt'), 'x'); writeFileSync(join(dir, 'u', 'docs', 'b.bin'), 'y');
            assert.deepEqual([...readPack(join(dir, 'u')).keys()].sort(), ['a.txt', 'docs/b.bin']);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
