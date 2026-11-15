import {createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {exampleWithReference, makeHttp, stores} from './helpers.js';

/**
 * CB-44: a carrier's B/L draft is approved on the platform by a second person of the carrier
 * (four eyes, decided on CB-11, 2026-11-14): never the person who drafted it.
 *
 *   POST /records/:id/versions/:n/approve   bl.issue, a user of the B/L's owner organisation
 *     body {comment?}
 *     200  the record as GET /records/:id answers it: the version committed (sealed, chained),
 *          approved by the caller; the event records.record.committed, its actor the approver
 *     403  {details.code: 'own-draft'} for anyone who created, changed or submitted that version
 *          (the drafter), nothing written, nothing published
 *     403  without bl.issue (a clerk who only drafts), and for a user of no organisation
 *     404  "B/L not found" for a user of another organisation; "Version not found"
 *     409  for a version not in review (still a draft, or already committed by someone else);
 *          of two approvals at the same moment, one wins and the other gets 409
 *     A retry by the same approver answers the committed record unchanged.
 *
 * After the approval the B/L is issued to the shipper with the title API (CB-34) and the shipper
 * sees it in its list (CB-42).
 */

/** The organisations of the tests: the carrier drafts and issues, the shipper is its first holder. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const OTHER_CARRIER = 'org-other-carrier';

/** A clerk drafts; a release manager approves and issues; a reader only reads. */
const CLERK_PERMS = ['bl.read', 'bl.draft'];
const MANAGER_PERMS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

const clerk = {
  id: 'u-clerk',
  name: 'Lena Okafor',
  org: CARRIER,
  perms: CLERK_PERMS,
};
const editor = {
  id: 'u-editor',
  name: 'Jonas Weber',
  org: CARRIER,
  perms: MANAGER_PERMS,
};
const manager = {
  id: 'u-manager',
  name: 'Ravi Menon',
  org: CARRIER,
  perms: MANAGER_PERMS,
};
const secondManager = {
  id: 'u-manager-2',
  name: 'Mia Hoffmann',
  org: CARRIER,
  perms: MANAGER_PERMS,
};
const drafterManager = {
  id: 'u-drafting-manager',
  name: 'Sam Carter',
  org: CARRIER,
  perms: MANAGER_PERMS,
};
const otherCarrier = {
  id: 'u-other',
  name: 'Hendrik Visser',
  org: OTHER_CARRIER,
  perms: MANAGER_PERMS,
};
const noOrganisation = {
  id: 'u-none',
  name: 'Lukas Haufiku',
  perms: MANAGER_PERMS,
};
const shipperStaff = {
  id: 'u-shipper',
  name: 'Ana Ribeiro',
  org: SHIPPER,
  perms: ['bl.read', 'bl.endorse'],
};

/** How many references nextReference gave. */
let references = 0;

/**
 * A new transport document reference, so each B/L of a test is new.
 * @return {string}
 */
function nextReference() {
  references += 1;
  return `CB44-APP-${references}`;
}

describe('approving a B/L draft on the platform, four eyes (CB-44)', () => {
  for (const store of stores()) {
    describe(`on ${store.name}`, () => {
      let ctx;

      beforeEach(async () => {
        ctx = await makeHttp(store, {signer: await createLocalSigner()});
      });

      afterEach(async () => {
        await ctx.close();
      });

      /**
       * A user's call: the raw answer.
       * @param {string} method
       * @param {string} url
       * @param {?object} user the caller, null for no token
       * @param {object} [payload]
       * @return {!Promise<object>}
       */
      function call(method, url, user, payload) {
        const headers = user ? ctx.as(user) : {};
        return ctx.app.inject({method, url, headers, payload});
      }

      /**
       * A B/L of the carrier drafted by `drafter`, its shipper linked, submitted by `submitter`.
       * @param {object} drafter
       * @param {object} [submitter]
       * @return {!Promise<string>} its id
       */
      async function submittedBy(drafter, submitter = drafter) {
        const created = await call('POST', '/records', drafter, {
          format: 'dcsa-3.0',
          document: exampleWithReference(nextReference()),
          partyOrganisations: {shipper: SHIPPER},
        });
        expect(created.statusCode, created.body).to.equal(201);
        const id = created.json().id;
        const submitted = await call(
          'POST',
          `/records/${id}/versions/1/submit`,
          submitter,
        );
        expect(submitted.statusCode, submitted.body).to.equal(200);
        return id;
      }

      /**
       * Approves version `n` of a B/L as a user: the raw answer.
       * @param {string} id
       * @param {?object} user
       * @param {number} [n]
       * @param {object} [body]
       * @return {!Promise<object>}
       */
      function approve(id, user, n = 1, body = {}) {
        return call('POST', `/records/${id}/versions/${n}/approve`, user, body);
      }

      /**
       * The events published so far, by type.
       * @param {string} type
       * @return {!Array<object>}
       */
      function eventsOf(type) {
        return ctx.published.filter(e => e.type === type);
      }

      it('a second person of the carrier with bl.issue approves: the version is committed, sealed and approved by them', async () => {
        const id = await submittedBy(clerk);
        const res = await approve(id, manager, 1, {comment: 'Checked'});
        expect(res.statusCode, res.body).to.equal(200);
        const record = res.json();
        expect([
          record.status,
          record.currentVersion,
          record.draftVersion,
        ]).to.deep.equal(['committed', 1, null]);
        expect(record.current.seal).to.match(/^[0-9a-f]{64}$/);
        expect(record.current.approvedById).to.equal(manager.id);
        expect(record.current.approvedByName).to.equal(manager.name);
        expect(record.current.submittedById).to.equal(clerk.id);
        const committed = eventsOf('records.record.committed');
        expect(committed).to.have.length(1);
        expect(committed[0].data.approvedBy).to.deep.equal({
          id: manager.id,
          name: manager.name,
        });
        expect(committed[0].actor?.id).to.equal(manager.id);
        // the change log names the approver and that the approval was made on the platform
        const entry = record.current.changes.at(-1);
        expect(entry).to.include({
          action: 'commit',
          byId: manager.id,
          byName: manager.name,
          via: 'approval',
          comment: 'Checked',
        });
      });

      it('the drafter may never approve their own draft: 403 own-draft, nothing written or published', async () => {
        const id = await submittedBy(drafterManager);
        const before = eventsOf('records.record.committed').length;
        const res = await approve(id, drafterManager);
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().details?.code).to.equal('own-draft');
        expect(eventsOf('records.record.committed')).to.have.length(before);
        const read = await call('GET', `/records/${id}`, drafterManager);
        expect([read.json().status, read.json().draftState]).to.deep.equal([
          'draft',
          'in_review',
        ]);
      });

      it('who changed the draft is a drafter too, even when someone else submitted it: 403 own-draft', async () => {
        const id = await submittedBy(clerk, clerk);
        // a second B/L: drafted by the clerk, changed by the editor, submitted by the clerk
        const second = await call('POST', '/records', clerk, {
          format: 'dcsa-3.0',
          document: exampleWithReference(nextReference()),
          partyOrganisations: {shipper: SHIPPER},
        });
        const secondId = second.json().id;
        const changed = await call(
          'PUT',
          `/records/${secondId}/draft`,
          editor,
          {
            format: 'dcsa-3.0',
            document: {
              ...exampleWithReference(second.json().recordNo),
              termsAndConditions: 'Changed by the editor.',
            },
            partyOrganisations: {shipper: SHIPPER},
          },
        );
        expect(changed.statusCode, changed.body).to.equal(200);
        const submitted = await call(
          'POST',
          `/records/${secondId}/versions/1/submit`,
          clerk,
        );
        expect(submitted.statusCode, submitted.body).to.equal(200);
        const res = await approve(secondId, editor);
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().details?.code).to.equal('own-draft');
        // the first B/L, untouched by the editor, the editor may approve
        expect((await approve(id, editor)).statusCode).to.equal(200);
      });

      it('who created the draft is a drafter, even when someone else submitted it: 403 own-draft', async () => {
        const id = await submittedBy(drafterManager, clerk);
        const res = await approve(id, drafterManager);
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().details?.code).to.equal('own-draft');
      });

      it('commit itself refuses a drafter approving on the platform (four eyes on the version it reads)', async () => {
        const created = await call('POST', '/records', clerk, {
          format: 'dcsa-3.0',
          document: exampleWithReference(nextReference()),
          partyOrganisations: {shipper: SHIPPER},
        });
        const id = created.json().id;
        const changed = await call('PUT', `/records/${id}/draft`, editor, {
          format: 'dcsa-3.0',
          document: exampleWithReference(created.json().recordNo),
          partyOrganisations: {shipper: SHIPPER},
        });
        expect(changed.statusCode, changed.body).to.equal(200);
        await call('POST', `/records/${id}/versions/1/submit`, clerk);
        let refused = null;
        try {
          await ctx.service.commit(id, 1, {by: {id: editor.id}}, 'approval');
        } catch (error) {
          refused = error;
        }
        expect(refused?.statusCode).to.equal(403);
        expect(refused?.details?.code).to.equal('own-draft');
      });

      it('sent back, changed by the approver and submitted again while the approval was under way: 403 own-draft', async () => {
        const id = await submittedBy(clerk);
        // the approval reads the version; meanwhile it is sent back, changed by the approver
        // and submitted again by the clerk, before the commit reads it again
        const read = ctx.service.requireVersion.bind(ctx.service);
        let meanwhile = async () => {
          await ctx.service.reject(
            id,
            1,
            {by: {id: secondManager.id}, comment: 'Fix the weight'},
            'bpm',
          );
          const record = await ctx.service.getRecord(id, CARRIER);
          await ctx.service.saveDraft(
            id,
            {
              format: 'dcsa-3.0',
              document: exampleWithReference(record.recordNo),
              partyOrganisations: {shipper: SHIPPER},
            },
            manager,
            CARRIER,
          );
          await ctx.service.submit(id, 1, clerk, CARRIER);
        };
        ctx.service.requireVersion = async (record, n) => {
          const version = await read(record, n);
          if (meanwhile !== null) {
            const run = meanwhile;
            meanwhile = null;
            await run();
          }
          return version;
        };
        const res = await approve(id, manager);
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().details?.code).to.equal('own-draft');
        expect(eventsOf('records.record.committed')).to.have.length(0);
      });

      it('a clerk without bl.issue may not approve: 403', async () => {
        const id = await submittedBy(drafterManager);
        const res = await approve(id, clerk);
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().details?.code).not.to.equal('own-draft');
      });

      it('a user of another organisation gets 404 "B/L not found", before any other refusal', async () => {
        const id = await submittedBy(clerk);
        const res = await approve(id, otherCarrier);
        expect(res.statusCode, res.body).to.equal(404);
        expect(res.json().message).to.equal('B/L not found');
      });

      it('a user of no organisation gets 403, without a token 401', async () => {
        const id = await submittedBy(clerk);
        expect((await approve(id, noOrganisation)).statusCode).to.equal(403);
        expect((await approve(id, null)).statusCode).to.equal(401);
      });

      it('a version that is not in review is refused (409); an unknown version 404, an unknown B/L 404', async () => {
        const created = await call('POST', '/records', clerk, {
          format: 'dcsa-3.0',
          document: exampleWithReference(nextReference()),
        });
        const id = created.json().id;
        const draft = await approve(id, manager);
        expect(draft.statusCode, draft.body).to.equal(409);
        const missing = await approve(id, manager, 7);
        expect(missing.statusCode, missing.body).to.equal(404);
        const unknown = await approve(
          '00000000-0000-4000-8000-000000000000',
          manager,
        );
        expect(unknown.statusCode, unknown.body).to.equal(404);
        const wrongId = await approve('not-a-uuid', manager);
        expect(wrongId.statusCode, wrongId.body).to.equal(400);
      });

      it('a retry by the same approver answers it unchanged; a second approver after the first gets 409', async () => {
        const id = await submittedBy(clerk);
        const first = await approve(id, manager);
        expect(first.statusCode, first.body).to.equal(200);
        const retry = await approve(id, manager);
        expect(retry.statusCode, retry.body).to.equal(200);
        expect(retry.json().current.seal).to.equal(first.json().current.seal);
        expect(eventsOf('records.record.committed')).to.have.length(1);
        const late = await approve(id, secondManager);
        expect(late.statusCode, late.body).to.equal(409);
      });

      it('of two approvals at the same moment, exactly one commits', async () => {
        const id = await submittedBy(clerk);
        const answers = await Promise.all([
          approve(id, manager),
          approve(id, secondManager),
        ]);
        const codes = answers.map(a => a.statusCode).sort();
        expect(codes).to.deep.equal([200, 409]);
        expect(eventsOf('records.record.committed')).to.have.length(1);
      });

      it('approved, the B/L is issued to the shipper, who then sees it in its list', async () => {
        const id = await submittedBy(clerk);
        const before = await call('GET', `/records/${id}/title`, manager);
        expect(before.json().allowedCommands).not.to.include('issue');
        expect((await approve(id, manager)).statusCode).to.equal(200);
        const ready = await call('GET', `/records/${id}/title`, manager);
        expect(ready.json().allowedCommands).to.include('issue');
        // the clerk may not issue (no bl.issue): the command is not offered to them
        const forClerk = await call('GET', `/records/${id}/title`, clerk);
        expect(forClerk.json().allowedCommands).not.to.include('issue');
        const issued = await call(
          'POST',
          `/records/${id}/title/issue`,
          manager,
          {},
        );
        expect(issued.statusCode, issued.body).to.equal(200);
        expect(issued.json().title.holder).to.equal(SHIPPER);
        const list = await call('GET', '/records/title', shipperStaff);
        expect(list.statusCode, list.body).to.equal(200);
        const item = list.json().items.find(i => i.id === id);
        expect(item?.roles).to.deep.equal(['holder']);
      });
    });
  }
});
