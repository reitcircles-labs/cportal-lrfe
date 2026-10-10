import { strict as assert } from 'node:assert';
import { AnchorService } from '../src/anchor.service.js';
import { ProofService } from '../src/proof.service.js';
import { createCardanoAdapter } from '../src/cardano/adapter.js';
import { createLocalSigner } from '../src/cardano/signer.js';
import { fakeDriver } from './helpers.js';
import { MINUTE, quiet, rec, people, audited, secondVersion } from './register.js';

describe('sign-off and findings (API-659)', () => {
    it('an auditor signs off a land record version and a document version in it: kept, in the trail, and anchored', async () => {
        const a = await audited();
        const res = await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, comment: 'Deeds, SG diagram and owners reconcile with the register' });
        assert.equal(res.statusCode, 201, res.body);
        const s = res.json();
        assert.deepEqual([s.recordNo, s.recordVersion, s.seal, s.signedByName, s.documentId], [a.record.recordNo, 1, a.record.current.seal, 'Martha Nakale', null]);
        const doc = a.docs.sg;
        const d = (await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, documentId: doc.id, comment: 'Diagram matches the extent' })).json();
        const sealed = (await a.edrmsService.getDocument(doc.id)).versions[0];
        assert.deepEqual([d.documentId, d.edrmsNo, d.documentVersion, d.seal], [doc.id, sealed && (await a.edrmsService.getDocument(doc.id)).edrmsNo, 1, sealed.seal]);
        const list = (await a.api(people.aud, 'GET', `/audit/signoffs?recordId=${a.record.id}`)).json().items;
        assert.equal(list.length, 2);

        // both are trail entries of the record (the document one also of the document)
        const entries = (await a.trail.list({ subject: `record:${a.record.id}`, type: 'audit.signoff.recorded' })).entries;
        assert.equal(entries.length, 2);
        assert.equal(entries[0].actor.name, 'Martha Nakale');
        assert.ok(entries[1].subjects.includes(`document:${doc.id}`));
        assert.equal(entries[1].data.comment, 'Diagram matches the extent');

        // the next anchoring covers them: a trail-entry proof checks out against the root on chain
        const driver = fakeDriver();
        const cardano = createCardanoAdapter({ driver, signer: createLocalSigner(), network: 'preview', logger: quiet });
        const job = new AnchorService({ repo: a.repo, tree: a.tree, cardano, logger: quiet, clock: a.clock, config: { confirmations: 10 } });
        for (let i = 0; i < 40 && (await job.tick()).action !== 'confirmed'; i++) { a.clock.advance(MINUTE); driver.chain.height++; driver.chain.slot += 60; }
        const proofs = new ProofService({ repo: a.repo, tree: a.tree, cardano, logger: quiet });
        const v = await proofs.verify('trail-entry', String(entries[0].seq));
        assert.equal(v.valid, true, JSON.stringify(v.checks));
        assert.equal(v.proof.trail.entry.type, 'audit.signoff.recorded');
    });

    it('whoever approved the version, or can finalize land records, cannot sign it off (sod2); the screen gets the reason', async () => {
        const a = await audited();
        const res = await a.api(people.formerRegistrar, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, comment: 'Looks right' });
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().message, 'You approved this version: another auditor must sign it off');
        assert.deepEqual(res.json().details, { rule: 'sod2' });
        // also for a document version within that record version
        assert.equal((await a.api(people.formerRegistrar, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, documentId: a.docs.sg.id, comment: 'Looks right' })).statusCode, 403);
        // holding record.finalize is enough to be refused: the approver, and someone who did not approve it
        for (const u of [people.supAuditing, people.recAuditing]) {
            const r = await a.api(u, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, comment: 'Looks right' });
            assert.deepEqual([r.statusCode, r.json().message, r.json().details], [403, 'You can finalize land records: an auditor without that permission must sign it off', { rule: 'sod2' }], u.name);
        }
        assert.equal(a.repo.signoffs.length, 0);
        assert.equal((await a.trail.list({ type: 'audit.signoff.recorded' })).total, 0);
        // a document version's own approver (an amendment) is refused for it
        const getDocument = a.signoffs.sources.document;
        a.signoffs.sources.document = async (id) => { const doc = await getDocument(id); return { ...doc, versions: doc.versions.map(v => ({ ...v, approvedById: people.aud.id })) }; };
        const docRes = await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, documentId: a.docs.sg.id, comment: 'Diagram matches' });
        assert.deepEqual([docRes.statusCode, docRes.json().message], [403, 'You approved this document version: another auditor must sign it off']);
        a.signoffs.sources.document = getDocument;
        // another auditor may
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id, version: 1, comment: 'Reconciled' })).statusCode, 201);
    });

    it('a sign-off needs a committed version, a comment, a document that is in the version, the permission, and only once per auditor', async () => {
        const a = await audited();
        const base = { recordId: a.record.id, version: 1, comment: 'Reconciled' };
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', base)).statusCode, 201);
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', base)).statusCode, 409);                // already signed off
        assert.equal((await a.api(people.aud2, 'POST', '/audit/signoffs', base)).statusCode, 201);               // a second auditor may
        // the same auditor twice at the same moment: one sign-off
        const twice = await Promise.all([1, 2].map(() => a.api(people.aud, 'POST', '/audit/signoffs', { ...base, documentId: a.docs.sg.id })));
        assert.deepEqual(twice.map(r => r.statusCode).sort(), [201, 409]);
        assert.equal(a.repo.signoffs.filter(x => x.documentId === a.docs.sg.id).length, 1);
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { ...base, comment: '  ' })).statusCode, 400);
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { ...base, version: 9 })).statusCode, 404);
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { ...base, documentId: a.docs.olympia.id })).statusCode, 400);   // not in version 1
        assert.equal((await a.api(people.sup, 'POST', '/audit/signoffs', base)).statusCode, 403);               // no audit.signoff
        // an open draft (version 2) is not committed
        const r = await a.service.openDraft(a.record.id, rec);
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { ...base, version: r.draft.versionNumber })).statusCode, 409);
    });

    it('a finding reaches the records officers and the registrars, who acknowledge it; a newer reviewed version resolves it', async () => {
        const a = await audited();
        const res = await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'The extent on the record differs from the SG diagram' });
        assert.equal(res.statusCode, 201, res.body);
        const f = res.json();
        assert.deepEqual([f.status, f.recordVersion, f.raisedByName], ['open', 1, 'Martha Nakale']);
        // in the inbox of the records officer and of the registrar, not of the auditor
        const [officerTask] = await a.inbox(people.rec);
        const [registrarTask] = (await a.inbox(people.sup)).filter(t => t.definitionKey === 'audit-finding');
        assert.equal(officerTask.definitionKey, 'audit-finding');
        assert.equal(officerTask.title, `Audit finding on ${a.record.recordNo} (${a.record.label}) version 1`);
        assert.ok(registrarTask);
        assert.equal((await a.inbox(people.aud)).length, 0);
        const detail = (await a.bpm.inject({ url: `/tasks/${officerTask.id}`, headers: a.as(people.rec) })).json();
        assert.equal(detail.input.finding.description, 'The extent on the record differs from the SG diagram');
        assert.equal(detail.input.raisedBy.name, 'Martha Nakale');
        // the records desk sees the finding through the audit service too
        for (const u of [people.rec, people.sup, people.aud]) {
            const items = (await a.api(u, 'GET', `/audit/findings?recordId=${a.record.id}&status=open`)).json().items;
            assert.deepEqual(items.map(x => x.id), [f.id], u.name);
        }
        // acknowledged by both: the process ends, the finding stays open
        for (const [u, t] of [[people.rec, officerTask], [people.sup, registrarTask]]) {
            assert.equal((await a.bpm.inject({ method: 'POST', url: `/tasks/${t.id}/complete`, headers: a.as(u), payload: { output: { outcome: 'acknowledged' } } })).statusCode, 200);
        }
        assert.equal((await a.bpm.inject({ url: `/instances/${f.instanceId}`, headers: a.as(people.sup) })).json().status, 'completed');
        assert.equal((await a.api(people.aud, 'GET', `/audit/findings/${f.id}`)).json().status, 'open');

        // the officer corrects the record: version 2, reviewed and committed, resolves it
        await secondVersion(a);
        const resolved = (await a.api(people.aud, 'GET', `/audit/findings/${f.id}`)).json();
        assert.deepEqual([resolved.status, resolved.resolvedByVersion], ['resolved', 2]);
        const trail = (await a.trail.list({ subject: `record:${a.record.id}`, type: 'audit.finding.' })).entries;
        assert.deepEqual(trail.map(e => [e.type, e.data.outcome]), [['audit.finding.raised', undefined], ['audit.finding.closed', 'resolved']]);
        assert.ok(trail[0].subjects.includes(`process:${f.instanceId}`));
        // a redelivered commit event changes nothing
        assert.equal(await a.signoffs.onEvent({ type: 'records.record.committed', data: { recordId: a.record.id, versionNumber: 2 } }), 0);
        // version 1 is replaced now: a finding goes on the current version
        const old = await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'Another look at version one' });
        assert.deepEqual([old.statusCode, old.json().message], [409, 'Version 1 has been replaced by version 2: raise the finding on the current version']);
        // a finding raised while a newer version is committed (its event read before the finding was stored) is resolved at once
        const current = a.signoffs.sources.record;
        a.signoffs.sources.record = async (id, n) => { const r = await current(id, n); return { ...r, record: { ...r.record, currentVersion: n } }; };
        const getRecordOnce = a.signoffs.newerVersion.bind(a.signoffs);
        a.signoffs.newerVersion = async (f) => { a.signoffs.sources.record = current; return getRecordOnce(f); };
        const raced = await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'Raised while version 2 was committed' });
        assert.deepEqual([raced.statusCode, raced.json().status, raced.json().resolvedByVersion], [201, 'resolved', 2]);
    });

    it('an auditor closes a finding with a reason: its tasks leave the inbox; a document finding is resolved by an approved correction', async () => {
        const a = await audited();
        const f = (await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'Owner ID number unreadable on the 1996 deed' })).json();
        assert.equal((await a.inbox(people.rec)).length, 1);
        assert.equal((await a.api(people.aud, 'POST', `/audit/findings/${f.id}/close`, { reason: '' })).statusCode, 400);
        assert.equal((await a.api(people.rec, 'POST', `/audit/findings/${f.id}/close`, { reason: 'fixed' })).statusCode, 403);   // records desk cannot close it
        const closed = await a.api(people.aud2, 'POST', `/audit/findings/${f.id}/close`, { reason: 'Checked the original in the vault: readable' });
        assert.equal(closed.statusCode, 200);
        assert.deepEqual([closed.json().status, closed.json().closedByName], ['closed', 'Second Auditor']);
        assert.equal((await a.inbox(people.rec)).length, 0);                                   // withdrawn
        assert.equal((await a.bpm.inject({ url: `/instances/${f.instanceId}`, headers: a.as(people.sup) })).json().status, 'cancelled');
        assert.equal((await a.api(people.aud, 'POST', `/audit/findings/${f.id}/close`, { reason: 'again' })).statusCode, 409);
        const entry = (await a.trail.list({ type: 'audit.finding.closed' })).entries[0];
        assert.deepEqual([entry.data.outcome, entry.data.reason, entry.actor.name], ['closed', 'Checked the original in the vault: readable', 'Second Auditor']);

        // a finding on a document version alone; edrms files an approved correction (version 2)
        const doc = a.docs.t2019;
        const df = (await a.api(people.aud, 'POST', '/audit/findings', { documentId: doc.id, version: 1, description: 'Transfer duty receipt missing' })).json();
        assert.deepEqual([df.documentId, df.recordId, df.documentVersion], [doc.id, null, 1]);
        const [task] = await a.inbox(people.rec);
        assert.match(task.title, /^Audit finding on EDR-NA-\d{4}-\d+ version 1 \(/);
        a.events.publish('edrms.document.amended', { documentId: doc.id, version: 2, seal: 'ab'.repeat(32) });
        await a.settle();
        assert.equal((await a.signoffs.getFinding(df.id)).status, 'resolved');
        assert.equal((await a.inbox(people.rec)).length, 0);
        // a document corrected since: a finding on its old version (also as pinned in a record) is refused
        const getDocument = a.signoffs.sources.document;
        a.signoffs.sources.document = async (id) => ({ ...(await getDocument(id)), currentVersion: 2 });
        const stale = await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, documentId: doc.id, description: 'Something in the old deed' });
        assert.equal(stale.statusCode, 409);
        assert.match(stale.json().message, /version 1 has been corrected \(version 2\): raise the finding on the current version$/);
    });

    it('when the task inbox cannot be reached, the finding is not raised (nobody would be told)', async () => {
        const a = await audited();
        a.setBpmDown(true);
        const res = await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'Something to check here' });
        assert.equal(res.statusCode, 503);
        assert.equal(a.repo.findings.length, 0);
        assert.equal((await a.trail.list({ type: 'audit.finding.raised' })).total, 0);
        a.setBpmDown(false);
        assert.equal((await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'Something to check here' })).statusCode, 201);
    });
});
