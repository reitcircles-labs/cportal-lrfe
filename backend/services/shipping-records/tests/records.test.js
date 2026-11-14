import {signServiceToken} from '@lrfe/common';
import {
  SCHEMA_VERSION,
  billOfLadingHash,
} from '@lrfe/domain-shipping/bill-of-lading';
import {sealOf} from '@lrfe/record-contract/seal';
import {expect} from 'chai';

import {
  EXAMPLE_FILES,
  by,
  createAs,
  example,
  exampleWithReference,
  makeHttp,
  stores,
  submittedDraft,
  users,
} from './helpers.js';

/**
 * The auth header of a service.
 * @param {object} ctx
 * @param {string} name
 * @return {{authorization: string}}
 */
function asService(ctx, name) {
  return {authorization: `Bearer ${signServiceToken(ctx.app, name)}`};
}

/**
 * A call to the API: the raw answer.
 * @param {object} ctx
 * @param {string} method
 * @param {string} url
 * @param {object} headers
 * @param {object} [payload]
 * @return {Promise<object>}
 */
function call(ctx, method, url, headers, payload) {
  return ctx.app.inject({method, url, headers, payload});
}

/**
 * A review decision reported by bpm: the raw answer.
 * @param {object} ctx
 * @param {string} decision `commit` or `reject`
 * @param {string} id
 * @param {number} n
 * @param {object} body
 * @return {Promise<object>}
 */
function decide(ctx, decision, id, n, body) {
  return call(
    ctx,
    'POST',
    `/records/${id}/versions/${n}/${decision}`,
    asService(ctx, 'bpm'),
    body,
  );
}

/**
 * Saves a draft of a B/L as a user: the raw answer.
 * @param {object} ctx
 * @param {object} user
 * @param {string} id
 * @param {object} document
 * @return {Promise<object>}
 */
function saveDraft(ctx, user, id, document) {
  return call(ctx, 'PUT', `/records/${id}/draft`, ctx.as(user), {
    format: 'dcsa-3.0',
    document,
  });
}

/**
 * Submits a draft version as a user: the raw answer.
 * @param {object} ctx
 * @param {object} user
 * @param {string} id
 * @param {number} n
 * @return {Promise<object>}
 */
function submit(ctx, user, id, n) {
  return call(ctx, 'POST', `/records/${id}/versions/${n}/submit`, ctx.as(user));
}

/**
 * A B/L of org A with versions 1 and 2 committed (drafted by a1, approved by a2): its id.
 * @param {object} ctx
 * @param {string} reference
 * @return {Promise<string>}
 */
async function twiceCommitted(ctx, reference) {
  const id = await submittedDraft(ctx, users.a1, reference);
  expect(
    (await decide(ctx, 'commit', id, 1, {by: by(users.a2)})).statusCode,
  ).to.equal(200);
  const changed = exampleWithReference(reference);
  changed.shippingInstructionsReference = 'SI-CHANGED-2';
  expect((await saveDraft(ctx, users.a1, id, changed)).statusCode).to.equal(
    200,
  );
  expect((await submit(ctx, users.a1, id, 2)).statusCode).to.equal(200);
  expect(
    (await decide(ctx, 'commit', id, 2, {by: by(users.a2)})).statusCode,
  ).to.equal(200);
  return id;
}

/**
 * Makes `other` happen between a call's reading of a version and its write: the next read of a
 * version answers what was stored before `other` ran, after `other` has run.
 * @param {object} ctx
 * @param {function(): Promise<object>} other another call, e.g. a second change
 */
function interleave(ctx, other) {
  const read = ctx.repo.getVersion;
  ctx.repo.getVersion = async (...args) => {
    ctx.repo.getVersion = read;
    const before = await read(...args);
    const res = await other();
    expect(res.statusCode, res.body).to.equal(200);
    return before;
  };
}

for (const store of stores()) {
  describe(`shipping-records, ${store.name}`, () => {
    let ctx;

    beforeEach(async () => {
      ctx = await makeHttp(store);
    });

    afterEach(async () => {
      await ctx.close();
    });

    describe('creating a draft B/L', () => {
      for (const file of EXAMPLE_FILES) {
        it(`creates one from DCSA's example ${file}, its status left out`, async () => {
          const document = example(file);
          const res = await createAs(ctx, users.a1, document);
          expect(res.statusCode, res.body).to.equal(201);
          const record = res.json();
          const {transportDocumentReference: reference, carrierCode} = document;
          expect(record).to.include({
            recordNo: reference,
            carrierCode,
            label: `B/L ${reference} (${carrierCode})`,
            organisationId: 'org-a',
            status: 'draft',
            currentVersion: null,
            draftVersion: 1,
            draftState: 'draft',
            draftDiff: null,
          });
          expect(record.current).to.equal(null);
          const {draft} = record;
          expect(draft.state).to.equal('draft');
          expect(draft.data.schemaVersion).to.equal(SCHEMA_VERSION);
          expect(draft.data.document).to.not.have.property(
            'transportDocumentStatus',
          );
          expect(draft.documentHash).to.equal(billOfLadingHash(draft.data));
        });
      }

      it("keeps the links of the document's parties to organisations", async () => {
        const res = await createAs(ctx, users.a1, example(), {
          partyOrganisations: {shipper: 'org-a'},
        });
        expect(res.statusCode, res.body).to.equal(201);
        expect(res.json().draft.data.partyOrganisations).to.deep.equal({
          shipper: 'org-a',
        });
      });

      it('refuses a B/L that is not valid, with every problem (400)', async () => {
        const document = example();
        delete document.carrierCode;
        document.utilizedTransportEquipments = [];
        const res = await createAs(ctx, users.a1, document);
        expect(res.statusCode).to.equal(400);
        const {problems} = res.json().details;
        expect(problems.length).to.be.at.least(2);
        expect(problems.map(p => p.message).join(' ')).to.include(
          'carrierCode',
        );
      });

      it('refuses an unknown format, and a format that is not on (400)', async () => {
        const unknown = await createAs(ctx, users.a1, example(), {
          format: 'paper-1.0',
        });
        expect(unknown.statusCode).to.equal(400);
        expect(unknown.json().message).to.include('Unknown B/L format');

        const none = await makeHttp(store, {formats: Object.freeze([])});
        try {
          const off = await createAs(none, users.a1, example());
          expect(off.statusCode).to.equal(400);
          expect(off.json().message).to.include('not on in this install');
        } finally {
          await none.close();
        }
      });

      it('refuses a second B/L with a reference the organisation already holds (409)', async () => {
        expect((await createAs(ctx, users.a1, example())).statusCode).to.equal(
          201,
        );
        const again = await createAs(ctx, users.a2, example());
        expect(again.statusCode).to.equal(409);
        expect(again.json()).to.not.have.nested.property('details.recordId');
      });

      it('lets another organisation draft the same reference, neither seeing the other', async () => {
        const mine = await createAs(ctx, users.a1, example());
        expect(mine.statusCode).to.equal(201);
        const theirs = await createAs(ctx, users.b1, example());
        expect(theirs.statusCode, theirs.body).to.equal(201);
        expect(theirs.json().id).to.not.equal(mine.json().id);

        const listA = await call(ctx, 'GET', '/records', ctx.as(users.a1));
        expect(listA.json().items.map(r => r.id)).to.deep.equal([
          mine.json().id,
        ]);
        const listB = await call(ctx, 'GET', '/records', ctx.as(users.b1));
        expect(listB.json().items.map(r => r.id)).to.deep.equal([
          theirs.json().id,
        ]);
        const getA = `/records/${mine.json().id}`;
        const getB = `/records/${theirs.json().id}`;
        expect(
          (await call(ctx, 'GET', getA, ctx.as(users.b1))).statusCode,
        ).to.equal(404);
        expect(
          (await call(ctx, 'GET', getB, ctx.as(users.a1))).statusCode,
        ).to.equal(404);
      });

      it('needs the permission to draft B/Ls (403)', async () => {
        const res = await createAs(ctx, users.aReader, example());
        expect(res.statusCode).to.equal(403);
      });
    });

    describe("an organisation's B/Ls", () => {
      it("shows a user only their organisation's B/Ls", async () => {
        const mine = (
          await createAs(ctx, users.a1, exampleWithReference('ORGA0001'))
        ).json();
        const theirs = (
          await createAs(ctx, users.b1, exampleWithReference('ORGB0001'))
        ).json();

        const listA = (
          await call(ctx, 'GET', '/records', ctx.as(users.aReader))
        ).json();
        expect(listA.items.map(r => r.id)).to.deep.equal([mine.id]);
        expect(listA.total).to.equal(1);
        const listB = (
          await call(ctx, 'GET', '/records', ctx.as(users.b1))
        ).json();
        expect(listB.items.map(r => r.id)).to.deep.equal([theirs.id]);

        const asAudit = await call(
          ctx,
          'GET',
          '/records',
          asService(ctx, 'audit'),
        );
        expect(asAudit.json().total).to.equal(2);
      });

      it("answers 404 for another organisation's B/L, never revealing it", async () => {
        const record = (await createAs(ctx, users.a1, example())).json();
        const headers = ctx.as(users.b1);
        for (const url of [
          `/records/${record.id}`,
          `/records/${record.id}/versions`,
          `/records/${record.id}/versions/1`,
        ]) {
          const res = await call(ctx, 'GET', url, headers);
          expect(res.statusCode, url).to.equal(404);
        }
        expect(
          (await saveDraft(ctx, users.b1, record.id, example())).statusCode,
        ).to.equal(404);
        expect((await submit(ctx, users.b1, record.id, 1)).statusCode).to.equal(
          404,
        );
        const unknown = await call(
          ctx,
          'GET',
          '/records/00000000-0000-4000-8000-000000000000',
          headers,
        );
        expect(unknown.json().message).to.equal(
          (await call(ctx, 'GET', `/records/${record.id}`, headers)).json()
            .message,
        );
      });

      it('refuses a user of no organisation (403)', async () => {
        expect(
          (await createAs(ctx, users.noOrg, example())).statusCode,
        ).to.equal(403);
        const list = await call(ctx, 'GET', '/records', ctx.as(users.noOrg));
        expect(list.statusCode).to.equal(403);
      });

      it('lists by status: drafts, in review and committed', async () => {
        await createAs(ctx, users.a1, exampleWithReference('STATUS0001'));
        await submittedDraft(ctx, users.a1, 'STATUS0002');
        const committed = await submittedDraft(ctx, users.a1, 'STATUS0003');
        await decide(ctx, 'commit', committed, 1, {by: by(users.a2)});
        const headers = ctx.as(users.a1);
        /**
         * The references listed with a status.
         * @param {string} status
         * @return {!Promise<!Array<string>>}
         */
        const ids = async status =>
          (await call(ctx, 'GET', `/records?status=${status}`, headers))
            .json()
            .items.map(r => r.recordNo);
        expect(await ids('in_review')).to.deep.equal(['STATUS0002']);
        expect(await ids('committed')).to.deep.equal(['STATUS0003']);
        expect((await ids('draft')).sort()).to.deep.equal([
          'STATUS0001',
          'STATUS0002',
        ]);
      });
    });

    describe('changing a draft', () => {
      it('replaces the open draft, with its new hash', async () => {
        const record = (await createAs(ctx, users.a1, example())).json();
        const changed = example();
        changed.shippingInstructionsReference = 'SI-CHANGED';
        const res = await saveDraft(ctx, users.a2, record.id, changed);
        expect(res.statusCode, res.body).to.equal(200);
        const {draft} = res.json();
        expect(draft.versionNumber).to.equal(1);
        expect(draft.data.document.shippingInstructionsReference).to.equal(
          'SI-CHANGED',
        );
        expect(draft.documentHash).to.equal(billOfLadingHash(draft.data));
        expect(draft.documentHash).to.not.equal(record.draft.documentHash);
        expect(draft.changes.map(c => c.action)).to.deep.equal([
          'create',
          'edit',
        ]);
      });

      it('never changes the carrier code or the reference (400)', async () => {
        const record = (await createAs(ctx, users.a1, example())).json();
        const otherReference = exampleWithReference('OTHER00001');
        const otherCarrier = {...example(), carrierCode: 'MAEU'};
        expect(
          (await saveDraft(ctx, users.a1, record.id, otherReference))
            .statusCode,
        ).to.equal(400);
        expect(
          (await saveDraft(ctx, users.a1, record.id, otherCarrier)).statusCode,
        ).to.equal(400);
      });

      it('refuses a change while the draft is in review (409)', async () => {
        const id = await submittedDraft(ctx, users.a1, 'REVIEW0001');
        const res = await saveDraft(
          ctx,
          users.a1,
          id,
          exampleWithReference('REVIEW0001'),
        );
        expect(res.statusCode).to.equal(409);
      });

      it('opens a new draft version after a commit, the current version unchanged', async () => {
        const id = await submittedDraft(ctx, users.a1, 'NEXT000001');
        await decide(ctx, 'commit', id, 1, {by: by(users.a2)});
        const changed = exampleWithReference('NEXT000001');
        changed.shippingInstructionsReference = 'SI-V2';
        const res = await saveDraft(ctx, users.a1, id, changed);
        expect(res.statusCode, res.body).to.equal(200);
        const record = res.json();
        expect(record).to.include({
          status: 'committed',
          currentVersion: 1,
          draftVersion: 2,
          draftState: 'draft',
        });
        expect(
          record.current.data.document.shippingInstructionsReference,
        ).to.not.equal('SI-V2');
        expect(
          record.draft.data.document.shippingInstructionsReference,
        ).to.equal('SI-V2');
      });

      it('refuses a change made on a draft that changed meanwhile (409), never losing the other', async () => {
        const record = (await createAs(ctx, users.a1, example())).json();
        const first = example();
        first.shippingInstructionsReference = 'SI-FIRST';
        const second = example();
        second.shippingInstructionsReference = 'SI-SECOND';
        // the second change lands after the first one read the draft
        interleave(ctx, () => saveDraft(ctx, users.a2, record.id, second));
        const late = await saveDraft(ctx, users.a1, record.id, first);
        expect(late.statusCode, late.body).to.equal(409);

        const draft = await ctx.repo.getVersion(record.id, 1);
        expect(draft.data.document.shippingInstructionsReference).to.equal(
          'SI-SECOND',
        );
        expect(draft.changes.map(c => c.action)).to.deep.equal([
          'create',
          'edit',
        ]);
        expect(draft.changes[1].byId).to.equal(users.a2.id);
      });

      it('refuses to submit a draft that changed meanwhile (409), keeping the change', async () => {
        const record = (await createAs(ctx, users.a1, example())).json();
        const changed = example();
        changed.shippingInstructionsReference = 'SI-MEANWHILE';
        // the change lands after the submission read the draft
        interleave(ctx, () => saveDraft(ctx, users.a2, record.id, changed));
        const late = await submit(ctx, users.a1, record.id, 1);
        expect(late.statusCode, late.body).to.equal(409);

        const draft = await ctx.repo.getVersion(record.id, 1);
        expect(draft.state).to.equal('draft');
        expect(draft.documentHash).to.equal(billOfLadingHash(draft.data));
        expect(draft.changes.map(c => c.action)).to.deep.equal([
          'create',
          'edit',
        ]);
        expect(ctx.published.map(e => e.type)).to.not.include(
          'records.draft.submitted',
        );

        const again = await submit(ctx, users.a1, record.id, 1);
        expect(again.statusCode, again.body).to.equal(200);
        const submitted = ctx.published.at(-1);
        expect(submitted.type).to.equal('records.draft.submitted');
        expect(submitted.data.documentHash).to.equal(draft.documentHash);
      });

      it('submits the open draft for review, once', async () => {
        const record = (await createAs(ctx, users.a1, example())).json();
        const res = await submit(ctx, users.a1, record.id, 1);
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().draftState).to.equal('in_review');
        expect(res.json().draft).to.include({
          state: 'in_review',
          submittedById: users.a1.id,
          submittedByName: users.a1.name,
        });
        expect((await submit(ctx, users.a1, record.id, 1)).statusCode).to.equal(
          409,
        );
        expect((await submit(ctx, users.a1, record.id, 7)).statusCode).to.equal(
          404,
        );
      });
    });

    describe('review decisions (the contract)', () => {
      it('never lets the submitter approve their own version (four-eyes, 403)', async () => {
        const id = await submittedDraft(ctx, users.a1, 'FOUREYES01');
        const own = await decide(ctx, 'commit', id, 1, {by: by(users.a1)});
        expect(own.statusCode).to.equal(403);
        const other = await decide(ctx, 'commit', id, 1, {by: by(users.a2)});
        expect(other.statusCode, other.body).to.equal(200);
        expect(other.json().current).to.include({
          state: 'committed',
          approvedById: users.a2.id,
          submittedById: users.a1.id,
        });
      });

      it('needs a comment to send a version back (400), then it is a draft again', async () => {
        const id = await submittedDraft(ctx, users.a1, 'REJECT0001');
        expect(
          (await decide(ctx, 'reject', id, 1, {by: by(users.a2)})).statusCode,
        ).to.equal(400);
        const res = await decide(ctx, 'reject', id, 1, {
          by: by(users.a2),
          comment: 'The consignee is missing',
        });
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json()).to.include({draftVersion: 1, draftState: 'draft'});
        expect(res.json().draft.reviewComment).to.equal(
          'The consignee is missing',
        );
        expect(
          (
            await saveDraft(
              ctx,
              users.a1,
              id,
              exampleWithReference('REJECT0001'),
            )
          ).statusCode,
        ).to.equal(200);
      });

      it('takes decisions from bpm only', async () => {
        const id = await submittedDraft(ctx, users.a1, 'ONLYBPM001');
        const asAudit = await call(
          ctx,
          'POST',
          `/records/${id}/versions/1/commit`,
          asService(ctx, 'audit'),
          {by: by(users.a2)},
        );
        expect(asAudit.statusCode).to.equal(403);
        const asUser = await call(
          ctx,
          'POST',
          `/records/${id}/versions/1/commit`,
          ctx.as(users.a2),
          {by: by(users.a2)},
        );
        expect(asUser.statusCode).to.equal(401);
      });
    });

    describe('the seal', () => {
      it('seals each committed version, chained, and its hash is the stored B/L', async () => {
        const id = await twiceCommitted(ctx, 'SEAL000001');
        const record = await ctx.repo.getRecord(id);
        let previous = null;
        for (const n of [1, 2]) {
          const res = await call(
            ctx,
            'GET',
            `/records/${id}/versions/${n}`,
            ctx.as(users.aReader),
          );
          const version = res.json();
          expect(version.documentHash).to.equal(billOfLadingHash(version.data));
          expect(version.seal).to.equal(sealOf(record, version));
          expect(version.previousSeal).to.equal(previous);
          previous = version.seal;
        }
        const check = await call(
          ctx,
          'GET',
          `/records/${id}/verify`,
          asService(ctx, 'audit'),
        );
        expect(check.json().intact).to.equal(true);
        expect(
          check.json().versions.map(v => [v.intact, v.linked]),
        ).to.deep.equal([
          [true, true],
          [true, true],
        ]);
      });

      it('finds a stored version that was changed afterwards', async () => {
        const id = await twiceCommitted(ctx, 'SEAL000002');
        const stored = await ctx.repo.getVersion(id, 1);
        const tampered = structuredClone(stored.data);
        tampered.document.shippingInstructionsReference = 'TAMPERED';
        await ctx.repo.updateVersion(id, 1, {data: tampered});
        const check = (
          await call(
            ctx,
            'GET',
            `/records/${id}/verify`,
            asService(ctx, 'audit'),
          )
        ).json();
        expect(check.intact).to.equal(false);
        expect(check.versions[0].intact).to.equal(false);
        expect(check.versions[1].intact).to.equal(true);
      });

      it('verifies for the audit service only', async () => {
        const id = await submittedDraft(ctx, users.a1, 'SEAL000003');
        const res = await call(
          ctx,
          'GET',
          `/records/${id}/verify`,
          ctx.as(users.a1),
        );
        expect(res.statusCode).to.equal(401);
      });

      it('refuses a seals cursor it did not give (400)', async () => {
        const res = await call(
          ctx,
          'GET',
          '/records/seals?after=bm90LWEtY3Vyc29y',
          asService(ctx, 'audit'),
        );
        expect(res.statusCode).to.equal(400);
      });
    });

    describe('events', () => {
      it("puts each version's step on the audit trail with the acting organisation", async () => {
        const record = (await createAs(ctx, users.a1, example())).json();
        await saveDraft(ctx, users.a1, record.id, example());
        await submit(ctx, users.a1, record.id, 1);
        await decide(ctx, 'reject', record.id, 1, {
          by: by(users.a2),
          comment: 'Fix it',
        });
        await submit(ctx, users.a1, record.id, 1);
        await decide(ctx, 'commit', record.id, 1, {by: by(users.a2)});

        expect(ctx.published.map(e => e.type)).to.deep.equal([
          'records.record.created',
          'records.draft.changed',
          'records.draft.submitted',
          'records.draft.rejected',
          'records.draft.submitted',
          'records.record.committed',
        ]);
        const [created, changed, submitted] = ctx.published;
        for (const event of [created, changed, submitted]) {
          expect(event.source).to.equal('shipping-records');
          expect(event.actor).to.deep.equal({
            id: users.a1.id,
            name: users.a1.name,
            org: 'org-a',
          });
          expect(Object.keys(event.data).sort()).to.deep.equal([
            'documentHash',
            'recordId',
            'recordNo',
            'versionNumber',
          ]);
        }
        const committed = ctx.published.at(-1);
        expect(committed.actor).to.deep.equal(by(users.a2));
        expect(Object.keys(committed.data).sort()).to.deep.equal([
          'approvedBy',
          'documentHash',
          'previousSeal',
          'recordId',
          'recordNo',
          'seal',
          'submittedBy',
          'versionNumber',
        ]);
        expect(committed.data.submittedBy).to.deep.equal(by(users.a1));
        const version = await ctx.repo.getVersion(record.id, 1);
        expect(committed.data.seal).to.equal(version.seal);
        expect(committed.data.documentHash).to.equal(version.documentHash);
      });
    });
  });
}
