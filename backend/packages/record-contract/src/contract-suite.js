/**
 * The contract test (CB-4): a mocha suite that checks a record service answers every call of
 * the record contract (RECORD_CALLS) with the documented shape. It checks shapes, never a
 * product's values, so every record service runs the same suite: land-records and
 * shipping-records (each in its own tests/contract.test.js).
 *
 * Imported from `@lrfe/record-contract/contract-suite`, apart from the client, so that a service
 * never loads test code. It needs mocha's globals (`describe`, `it`, `before`).
 */
/* global describe, it, before */
import assert from 'node:assert/strict';

/**
 * What the suite needs from the service under test, read in its `before` hook.
 * @typedef {object} ContractFixture
 * @property {string} recordId a record with at least one committed version
 * @property {number} versionNumber a committed version of that record
 * @property {?string} documentId a document that committed version is made of; null for a
 *     product whose versions pin no documents (the lookup is then checked for its shape only)
 * @property {string} unknownId an id no record has (in the service's id format)
 * @property {{recordId: string, versionNumber: number}} toCommit a version submitted for review
 * @property {{recordId: string, versionNumber: number}} toReject another version submitted for review
 * @property {{id: string, name: string}} by the person who decides, other than the submitters
 */

/**
 * Describes the contract test of a record service.
 *
 * `client` answers a client of the contract (`createRecordClient` over the test's transport):
 * each call resolves with the answer's JSON and rejects, when the service refuses, with an
 * error whose `statusCode` is the answer's status. The transport signs each call as the service
 * that makes it (audit for the reading calls, bpm for commit and reject).
 * @param {{
 *   name: string,
 *   client: () => ReturnType<typeof import('./index.js').createRecordClient>,
 *   fixture: () => ContractFixture | Promise<ContractFixture>,
 * }} options
 */
export function describeRecordContract({name, client: clientOf, fixture}) {
  describe(`${name} answers the record contract (CB-4)`, () => {
    let client;
    /** @type {ContractFixture} */
    let given;

    before(async () => {
      given = await fixture();
      client = clientOf();
    });

    it('list: a page of records with their number, label, status and current version', async () => {
      const page = await client.list({status: 'committed', limit: 10});
      assert.equal(typeof page.total, 'number');
      assert.ok(Array.isArray(page.items));
      assert.ok(page.items.length >= 1, 'the committed record is listed');
      for (const record of page.items) {
        assertRecordSummary(record);
      }
      assert.ok(page.items.some(r => r.id === given.recordId));
      const one = await client.list({limit: 1, offset: 0});
      assert.ok(one.items.length <= 1);
    });

    it('get: one record with its current committed version (`current`)', async () => {
      const record = await client.get(given.recordId);
      assertRecordSummary(record);
      assert.equal(record.id, given.recordId);
      assert.equal(typeof record.currentVersion, 'number');
      assertVersion(record.current);
      assert.equal(record.current.versionNumber, record.currentVersion);
    });

    it('get: 404 for an unknown record, and for an unknown version', async () => {
      await assertStatus(client.get(given.unknownId), 404);
      await assertStatus(client.versions(given.unknownId), 404);
      await assertStatus(client.verify(given.unknownId), 404);
      await assertStatus(client.version(given.recordId, 9999), 404);
    });

    it('versions: the versions of a record, without their data', async () => {
      const versions = await client.versions(given.recordId);
      assert.ok(Array.isArray(versions));
      const committed = versions.find(
        v => v.versionNumber === given.versionNumber,
      );
      assert.ok(committed, 'the committed version is listed');
      for (const v of versions) {
        assert.equal(typeof v.versionNumber, 'number');
        assert.equal(typeof v.state, 'string');
        assert.ok(!('data' in v), 'no data in the list');
        assertStringOrNull(v.seal, 'seal');
        assertStringOrNull(v.committedAt, 'committedAt');
        assertStringOrNull(v.approvedByName, 'approvedByName');
      }
      assert.equal(typeof committed.seal, 'string');
    });

    it('version: one version with its data', async () => {
      const v = await client.version(given.recordId, given.versionNumber);
      assertVersion(v);
      assert.equal(v.versionNumber, given.versionNumber);
    });

    it('lookup: record labels, the documents of versions and the versions pinning documents', async () => {
      const pinning = given.documentId === null ? [] : [given.documentId];
      const answer = await client.lookup({
        recordIds: [given.recordId],
        versions: [
          {recordId: given.recordId, versionNumber: given.versionNumber},
        ],
        pinning,
      });
      assert.deepEqual(Object.keys(answer).sort(), [
        'pinnedBy',
        'records',
        'versions',
      ]);
      const record = answer.records.find(r => r.id === given.recordId);
      assert.ok(record, 'the record asked for is named');
      assert.equal(typeof record.recordNo, 'string');
      assert.equal(typeof record.label, 'string');
      const made = answer.versions.find(
        v =>
          v.recordId === given.recordId &&
          v.versionNumber === given.versionNumber,
      );
      assert.ok(made, 'the version asked for has its documents');
      assert.ok(Array.isArray(made.documents), 'documents is a list');
      for (const d of made.documents) {
        assert.equal(typeof d.id, 'string');
        assert.equal(typeof d.version, 'number');
      }
      assert.ok(Array.isArray(answer.pinnedBy), 'pinnedBy is a list');
      if (given.documentId === null) {
        // a product whose versions pin no documents: the shape only
        return;
      }
      assert.ok(made.documents.some(d => d.id === given.documentId));
      const pin = answer.pinnedBy.find(p => p.documentId === given.documentId);
      assert.ok(pin, 'the document is pinned by the committed version');
      assert.equal(pin.recordId, given.recordId);
      assert.equal(pin.versionNumber, given.versionNumber);
      assert.equal(typeof pin.version, 'number');
    });

    it('seals: the seals of committed versions in pages, with a cursor to the next', async () => {
      const first = await client.seals({limit: 1});
      assert.equal(first.items.length, 1);
      assertSeal(first.items[0]);
      assert.ok(first.next === null || typeof first.next === 'string');
      const all = await client.seals({limit: 1000});
      assert.equal(all.next, null, 'no cursor after the last page');
      assert.ok(
        all.items.some(
          s =>
            s.recordId === given.recordId && s.version === given.versionNumber,
        ),
      );
      for (const seal of all.items) {
        assertSeal(seal);
      }
      if (first.next) {
        const second = await client.seals({limit: 1, after: first.next});
        assert.notDeepEqual(second.items[0], first.items[0]);
      }
    });

    it('verify: each committed version recomputed: seal, intact and linked', async () => {
      const check = await client.verify(given.recordId);
      assert.equal(check.recordId, given.recordId);
      assert.equal(typeof check.intact, 'boolean');
      assert.ok(Array.isArray(check.versions));
      assert.ok(check.versions.length >= 1);
      for (const v of check.versions) {
        assert.equal(typeof v.versionNumber, 'number');
        assert.equal(typeof v.seal, 'string');
        assert.equal(typeof v.intact, 'boolean');
        assert.equal(typeof v.linked, 'boolean');
      }
      assert.equal(check.intact, true, 'the fixture record is intact');
    });

    it('commit: a submitted version becomes the current committed version', async () => {
      const {recordId, versionNumber} = given.toCommit;
      const record = await client.commit(recordId, versionNumber, {
        by: given.by,
        comment: 'Contract test: approved',
      });
      assertRecordSummary(record);
      assert.equal(record.id, recordId);
      assert.equal(record.currentVersion, versionNumber);
      assertVersion(record.current);
      assert.equal(typeof record.current.seal, 'string');
      const again = await client.commit(recordId, versionNumber, {
        by: given.by,
      });
      assert.equal(again.currentVersion, versionNumber, 'a retry is answered');
    });

    it('reject: a submitted version goes back as a draft', async () => {
      const {recordId, versionNumber} = given.toReject;
      const record = await client.reject(recordId, versionNumber, {
        by: given.by,
        comment: 'Contract test: sent back',
      });
      assertRecordSummary(record);
      assert.equal(record.id, recordId);
      assert.equal(record.draftVersion, versionNumber);
      assert.equal(record.draftState, 'draft');
      await assertStatus(
        client.commit(recordId, versionNumber, {by: given.by}),
        409,
      );
    });
  });
}

/**
 * A record as the list, get, commit and reject answer it.
 * @param {object} record
 */
function assertRecordSummary(record) {
  assert.equal(typeof record.id, 'string');
  assert.equal(typeof record.recordNo, 'string');
  assert.equal(typeof record.label, 'string');
  assert.equal(typeof record.status, 'string');
  assert.ok(
    record.currentVersion === null || typeof record.currentVersion === 'number',
    'currentVersion is a number or null',
  );
  assert.ok(
    record.draftVersion === null || typeof record.draftVersion === 'number',
    'draftVersion is a number or null',
  );
}

/**
 * A committed version with its data, its seal and the seal it is chained to.
 * @param {object} v
 */
function assertVersion(v) {
  assert.ok(v && typeof v === 'object', 'a version');
  assert.equal(typeof v.versionNumber, 'number');
  assert.equal(typeof v.state, 'string');
  assert.ok(v.data && typeof v.data === 'object', 'the version has its data');
  assert.equal(typeof v.seal, 'string');
  assertStringOrNull(v.previousSeal, 'previousSeal');
  assert.equal(typeof v.approvedById, 'string');
  assert.ok(!Number.isNaN(Date.parse(v.committedAt)), 'committedAt is a date');
}

/**
 * One entry of the seals list.
 * @param {object} seal
 */
function assertSeal(seal) {
  assert.equal(typeof seal.recordId, 'string');
  assert.equal(typeof seal.version, 'number');
  assert.equal(typeof seal.seal, 'string');
  assert.ok(!Number.isNaN(Date.parse(seal.at)), 'at is a date');
}

/**
 * @param {unknown} value
 * @param {string} what
 */
function assertStringOrNull(value, what) {
  assert.ok(
    value === null || typeof value === 'string',
    `${what} is a string or null`,
  );
}

/**
 * Waits for a call the service must refuse, and checks its status.
 * @param {Promise<unknown>} call
 * @param {number} statusCode
 */
async function assertStatus(call, statusCode) {
  const err = await call.then(
    () => null,
    e => e,
  );
  assert.ok(err, `expected a ${statusCode} answer`);
  assert.equal(err.statusCode, statusCode, err.message);
}
