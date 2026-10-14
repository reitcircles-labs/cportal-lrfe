import { strict as assert } from 'node:assert';
import { SignoffService } from '../src/signoff.service.js';
import { AppError } from '@lrfe/common';
import { MINUTE, people, audited, secondVersion } from './register.js';

describe('audit sign-off as a checkpoint (API-680)', () => {
    const check = async (a, u = people.aud) => (await a.api(u, 'GET', `/audit/records/${a.record.id}/check`)).json();
    const signOff = (a, u = people.aud, comment) => a.api(u, 'POST', '/audit/signoffs', { recordId: a.record.id, ...(comment ? { comment } : {}) });

    it('one sign-off for every version since the last one, accepted only once everything is on the blockchain and matches', async () => {
        const a = await audited();
        // before the anchoring: the checkpoint is v1 and its five documents, waiting for the next batch
        let c = await check(a);
        assert.deepEqual(c.range, { from: 1, to: 1 });
        assert.deepEqual([c.versions.length, c.documents.length, c.lastSignoff], [1, 5, null]);
        assert.ok([...c.versions, ...c.documents].every(i => i.anchoring === 'waiting' && i.match === 'notOnChain'));
        assert.deepEqual([c.canSignOff, c.reason], [false, 'Some items go to the blockchain with the next batch. You can sign off once everything is there.']);
        const early = await signOff(a);
        assert.deepEqual([early.statusCode, early.json().message], [409, c.reason]);

        // on the blockchain: every item matches, and the sign-off is accepted
        await a.anchor();
        c = await check(a);
        assert.ok([...c.versions, ...c.documents].every(i => i.anchoring === 'confirmed' && i.match === 'matches'), JSON.stringify(c));
        assert.deepEqual([c.canSignOff, c.reason], [true, null]);
        const res = await signOff(a, people.aud, 'Deeds, SG diagram and owners reconcile with the register');
        assert.equal(res.statusCode, 201, res.body);
        const s = res.json();
        assert.deepEqual([s.kind, s.fromVersion, s.toVersion, s.recordVersion, s.seal, s.signedByName], ['checkpoint', 1, 1, 1, a.record.current.seal, 'Martha Nakale']);
        assert.equal(s.items.documents.length, 5);
        assert.ok(s.items.documents.every(d => d.match === 'matches' && d.seal));
        const [entry] = (await a.trail.list({ subject: `record:${a.record.id}`, type: 'audit.signoff.recorded' })).entries;
        assert.deepEqual([entry.data.kind, entry.data.fromVersion, entry.data.toVersion, entry.data.seal, entry.actor.name], ['checkpoint', 1, 1, a.record.current.seal, 'Martha Nakale']);

        // nothing new to audit until the next version
        const again = await signOff(a, people.aud2);
        assert.deepEqual([again.statusCode, again.json().message], [409, 'Nothing to audit: no version was committed since the last audit sign-off (v1).']);
        assert.equal((await check(a)).lastSignoff.id, s.id);

        // version 2: the next checkpoint starts after v1; its documents were covered already
        await secondVersion(a);
        c = await check(a);
        assert.deepEqual([c.range, c.documents.length, c.versions[0].anchoring], [{ from: 2, to: 2 }, 0, 'waiting']);
        await a.anchor();
        // two auditors at the same moment: one audit sign-off for the checkpoint
        const both = await Promise.all([people.aud, people.aud2].map(u => signOff(a, u)));
        assert.deepEqual(both.map(r => r.statusCode).sort(), [201, 409]);
        // the second either finds the checkpoint signed off or loses the race at the store
        assert.ok(['This audit has just been signed off by someone else.', 'Nothing to audit: no version was committed since the last audit sign-off (v2).'].includes(both.find(r => r.statusCode === 409).json().message));
        assert.deepEqual(a.repo.signoffs.filter(x => x.kind === 'checkpoint').map(x => [x.fromVersion, x.toVersion]), [[1, 1], [2, 2]]);
    });

    it('a checkpoint of two versions: both checked, the documents carried over once', async () => {
        const a = await audited();
        await secondVersion(a);
        await a.anchor();
        const c = await check(a);
        assert.deepEqual([c.range, c.versions.map(v => v.match), c.documents.length], [{ from: 1, to: 2 }, ['matches', 'matches'], 5]);
        assert.ok(c.documents.every(d => d.addedIn === 1 && d.match === 'matches'));
        const s = (await signOff(a)).json();
        assert.deepEqual([s.fromVersion, s.toVersion, s.items.versions.map(v => v.version), s.items.documents.length], [1, 2, [1, 2], 5]);
    });

    it('a transaction sent but not in a block yet does not count', () => {
        const items = { versions: [{ label: 'v3', anchoring: 'sent', match: 'notOnChain' }], documents: [], openFindings: [] };
        assert.deepEqual(SignoffService.refusal(items), { status: 409, reason: 'v3 is on its way to the blockchain. You can sign off once it is in a block, usually within minutes.' });
    });

    it('whoever can commit land record versions, or approved a version in the range, cannot sign it off (sod2)', async () => {
        const a = await audited();
        // refused before anything else, also before the anchoring
        const before = await signOff(a, people.formerRegistrar);
        assert.deepEqual([before.statusCode, before.json().message, before.json().details], [403, 'You approved v1, which is part of this audit, so another auditor must sign it off.', { rule: 'sod2' }]);
        await a.anchor();
        for (const u of [people.supAuditing, people.recAuditing]) {
            const r = await signOff(a, u);
            assert.deepEqual([r.statusCode, r.json().message, r.json().details], [403, 'You can commit land record versions, so you can’t sign off audits. Another auditor signs off.', { rule: 'sod2' }], u.name);
        }
        assert.equal((await check(a, people.formerRegistrar)).canSignOff, false);
        assert.equal((await signOff(a, people.sup)).statusCode, 403);                     // no audit.signoff
        assert.equal(a.repo.signoffs.length, 0);
        assert.equal((await signOff(a, people.aud2)).statusCode, 201);                    // another auditor may
    });

    it('a changed version is "changed since review": refused, the records desk gets one re-review task, and a re-reviewed version lifts it', async () => {
        const a = await audited();
        await a.anchor();
        // the stored version 1 is changed after it was sealed and anchored
        const v1 = await a.service.repo.getVersion(a.record.id, 1);
        await a.service.repo.updateVersion(a.record.id, 1, { data: { ...v1.data, attributes: { ...v1.data.attributes, zoning: 'Industrial' } } });
        let c = await check(a);
        assert.deepEqual([c.versions[0].match, c.versions[0].superseded, c.canSignOff], ['changed', false, false]);
        assert.equal(c.reason, 'The audit can’t be signed off until the land record has been re-reviewed and submitted again.');
        assert.equal((await signOff(a)).statusCode, 409);
        // one task each for the records officer and the registrar, once however often it is checked
        await check(a);
        const [task] = (await a.inbox(people.rec)).filter(t => t.definitionKey === 'audit-rereview');
        assert.equal(task.title, `Re-review: changed since review, ${a.record.recordNo} (${a.record.label}) version 1`);
        assert.equal((await a.inbox(people.rec)).filter(t => t.definitionKey === 'audit-rereview').length, 1);
        assert.equal((await a.inbox(people.sup)).filter(t => t.definitionKey === 'audit-rereview').length, 1);
        assert.equal(a.repo.alerts.size, 1);
        const [changed] = (await a.trail.list({ subject: `record:${a.record.id}`, type: 'audit.item.changed' })).entries;
        assert.match(changed.data.message, /^This land record has changed since it was last reviewed and submitted/);

        // re-reviewed: version 2 committed after the change was found, and on the blockchain
        a.clock.advance(MINUTE);
        await secondVersion(a);
        await a.anchor();
        c = await check(a);
        assert.deepEqual(c.versions.map(v => [v.versionNumber, v.match, v.superseded ?? false]), [[1, 'changed', true], [2, 'matches', false]]);
        assert.equal(c.canSignOff, true, c.reason);
        const s = (await signOff(a)).json();
        assert.deepEqual(s.items.versions.map(v => [v.version, v.match, v.superseded ?? false]), [[1, 'changed', true], [2, 'matches', false]]);
    });

    it('a changed document stays "changed since review" while a newer version still pins it', async () => {
        const a = await audited();
        await a.anchor();
        // the stored SG diagram no longer matches its seal
        const sg = a.docs.sg.id;
        const recompute = a.proofs.sources.documentVersion;
        a.proofs.sources.documentVersion = async (id, n) => ({ ...(await recompute(id, n)), ...(id === sg ? { intact: false } : {}) });
        let c = await check(a);
        assert.deepEqual(c.documents.filter(d => d.match === 'changed').map(d => d.documentId), [sg]);
        // a newer version that keeps the changed document pinned does not lift it
        a.clock.advance(MINUTE);
        await secondVersion(a);
        await a.anchor();
        c = await check(a);
        const changed = c.documents.find(d => d.documentId === sg);
        assert.deepEqual([changed.match, changed.superseded, c.canSignOff], ['changed', false, false]);
        assert.equal(c.reason, 'The audit can\u2019t be signed off until the land record has been re-reviewed and submitted again.');
    });

    it('when the blockchain cannot be reached the check cannot run: refused, and no re-review task', async () => {
        const a = await audited();
        await a.anchor();
        // the owning services cannot recompute the seals now
        const down = async () => { throw new AppError(503, 'The land records service cannot be reached: connect ECONNREFUSED'); };
        a.proofs.sources = { recordVersion: down, documentVersion: down };
        const c = await check(a);
        assert.equal(c.versions[0].match, 'unavailable');
        assert.deepEqual([c.canSignOff, c.reason], [false, 'The blockchain couldn’t be reached. Try again in a few minutes.']);
        assert.equal((await signOff(a)).statusCode, 503);
        assert.equal(a.repo.alerts.size, 0);
    });

    it('an open finding blocks the sign-off; auditors answer it, and closing it as resolved by agreement lifts it', async () => {
        const a = await audited();
        await a.anchor();
        const doc = a.docs.sg;
        const f = (await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, documentId: doc.id, description: 'The extent on the SG diagram differs from the record' })).json();
        let c = await check(a);
        assert.deepEqual(c.openFindings.map(x => x.id), [f.id]);
        assert.match(c.reason, /^The finding on EDR-NA-\d{4}-\d+ is still open\. The audit can’t be signed off until it is resolved by a corrected version, or an auditor closes it as resolved by agreement\.$/);
        assert.equal((await signOff(a)).statusCode, 409);

        // any auditor answers; nobody else
        const answered = await a.api(people.aud2, 'POST', `/audit/findings/${f.id}/answers`, { text: 'The records office is checking the diagram with the Surveyor-General' });
        assert.equal(answered.statusCode, 201, answered.body);
        assert.deepEqual(answered.json().answers.map(x => [x.byName, x.role, x.text]), [['Second Auditor', 'Auditor', 'The records office is checking the diagram with the Surveyor-General']]);
        assert.equal((await a.api(people.rec, 'POST', `/audit/findings/${f.id}/answers`, { text: 'We are on it' })).statusCode, 403);
        assert.equal((await a.api(people.sup, 'POST', `/audit/findings/${f.id}/answers`, { text: 'We are on it' })).statusCode, 403);
        assert.equal((await a.api(people.aud, 'POST', `/audit/findings/${f.id}/answers`, { text: ' ' })).statusCode, 400);

        // closing answers it: an outcome, and an answer
        assert.equal((await a.api(people.aud, 'POST', `/audit/findings/${f.id}/close`, { outcome: 'agreed' })).statusCode, 400);
        assert.equal((await a.api(people.aud, 'POST', `/audit/findings/${f.id}/close`, { outcome: 'dropped', answer: 'No reason' })).statusCode, 400);
        assert.equal((await a.api(people.aud, 'POST', `/audit/findings/${f.id}/close`, { answer: 'An answer without saying how it was closed' })).statusCode, 400);
        assert.equal((await a.api(people.rec, 'POST', `/audit/findings/${f.id}/close`, { outcome: 'agreed', answer: 'Fixed' })).statusCode, 403);
        const closed = await a.api(people.aud, 'POST', `/audit/findings/${f.id}/close`, { outcome: 'agreed', answer: 'Meeting with the Registrar and the Surveyor-General on 14 Oct 2026: the diagram is right. Minutes RM-2026-114.' });
        assert.equal(closed.statusCode, 200, closed.body);
        assert.deepEqual([closed.json().status, closed.json().outcome, closed.json().closedByName], ['closed', 'agreed', 'Martha Nakale']);

        // the thread is in the trails of the document and of the land record, under "Findings"
        const docTrail = (await a.trail.list({ subject: `document:${doc.id}`, type: 'audit.finding.' })).entries;
        assert.deepEqual(docTrail.map(e => e.type), ['audit.finding.raised', 'audit.finding.answered', 'audit.finding.closed']);
        const last = docTrail.at(-1);
        assert.ok(last.subjects.includes(`record:${a.record.id}`));
        assert.deepEqual([last.data.outcome, last.data.Findings[0].status, last.data.Findings[0].outcome], ['agreed', 'closed', 'agreed']);
        assert.deepEqual(last.data.Findings[0].answers.map(x => x.name), ['Second Auditor']);
        assert.deepEqual([last.data.Findings[0].raisedBy.name, last.data.Findings[0].issue, last.data.Findings[0].closedBy.name], ['Martha Nakale', 'The extent on the SG diagram differs from the record', 'Martha Nakale']);
        assert.match(last.data.Findings[0].answer, /^Meeting with the Registrar/);
        assert.equal((await a.api(people.aud, 'POST', `/audit/findings/${f.id}/answers`, { text: 'One more thing' })).statusCode, 409);   // closed

        // no open finding: the sign-off is accepted and names the finding in its range
        c = await check(a);
        assert.equal(c.canSignOff, true, c.reason);
        const s = (await signOff(a)).json();
        assert.deepEqual(s.items.findings, [f.id]);
    });
});

describe('findings (API-659)', () => {
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
        assert.deepEqual([entry.data.outcome, entry.data.reason, entry.actor.name], ['mistake', 'Checked the original in the vault: readable', 'Second Auditor']);

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
