import {expect} from 'chai';
import {AppError, createServiceTokenSigner} from '@lrfe/common';
import {newToken} from '../src/extracts.service.js';
import {subjectsOf} from '../../audit/src/subjects.js';
import {
  erf1873,
  erf1873Data,
  commitVersion,
} from '../../land-records/tests/helpers.js';
import {
  SECRET,
  actor,
  committedErf1873,
  makeExtracts,
  users,
} from './helpers.js';

const rec = actor(users.rec);
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/** Issuing for Maria Nghishidi, the first owner on version 1 of Erf 1873, her ID document seen. */
const forMaria = (record, extra = {}) => ({
  recordId: record.id,
  versionNumber: 1,
  ownerIndex: 0,
  idNo: '75060200418',
  documentSeen: true,
  ...extra,
});

async function rejects(promise, status, message) {
  try {
    await promise;
  } catch (err) {
    if (status) expect(err.statusCode).to.equal(status);
    if (message) expect(err.message).to.include(message);
    return err;
  }
  throw new Error('expected a rejection');
}

describe('ownership extracts (API-692)', () => {
  describe('issuing', () => {
    it('for an owner on the current version, ID document seen: the register row, and an audit event', async () => {
      const {records, service, published} = await makeExtracts();
      const record = await committedErf1873(records);
      // typed from the identity document, with spaces
      const extract = await service.issue(
        forMaria(record, {idNo: '750602 00418'}),
        rec,
      );
      expect(extract).to.include({
        recordId: record.id,
        recordNo: record.recordNo,
        versionNumber: 1,
        issuedById: users.rec.id,
        issuedByName: users.rec.name,
        ownerIndex: 0,
        ownerName: 'Maria Nghishidi',
        ownerIdLast4: '0418',
        documentSeen: true,
        status: 'valid',
        revokedAt: null,
        isCurrentVersion: true,
      });
      // the full ID number is not kept
      expect(JSON.stringify(extract)).to.not.include('75060200418');
      expect(extract.issuedAt).to.be.instanceOf(Date);
      expect(extract.token).to.match(/^[A-Za-z0-9_-]{43}$/);

      expect(published.map(e => e.type)).to.deep.equal([
        'extracts.extract.issued',
      ]);
      const [event] = published;
      expect(event.source).to.equal('extracts');
      expect(event.actor).to.deep.equal(rec);
      expect(event.data).to.deep.equal({
        extractId: extract.id,
        recordId: record.id,
        recordNo: record.recordNo,
        versionNumber: 1,
        issuedFor: {name: 'Maria Nghishidi'},
        // the issued PDF's SHA-256 (API-691)
        pdfSha256: extract.pdfSha256,
      });
      expect(extract.pdfSha256).to.match(/^[0-9a-f]{64}$/);
      // the audit trail files it under the land record (and the officer)
      expect(subjectsOf(event)).to.include(`record:${record.id}`);
    });

    it('refuses an ID number that does not match the owner, no such owner, and the document not seen', async () => {
      const {records, service, repo, published} = await makeExtracts();
      const record = await committedErf1873(records);
      await rejects(
        service.issue(forMaria(record, {idNo: '75060200419'}), rec),
        409,
        'The ID number does not match Maria Nghishidi’s ID number on the land record',
      );
      // another owner's ID number
      await rejects(
        service.issue(forMaria(record, {idNo: '01112500379'}), rec),
        409,
        'does not match',
      );
      await rejects(
        service.issue(forMaria(record, {ownerIndex: 3}), rec),
        409,
        `There is no such owner on version 1 of ${record.recordNo}`,
      );
      for (const documentSeen of [false, undefined]) {
        await rejects(
          service.issue(forMaria(record, {documentSeen}), rec),
          400,
          'Confirm that you have seen the owner’s identity document',
        );
      }
      expect(await repo.listExtracts(record.id)).to.deep.equal([]);
      expect(published).to.deep.equal([]);
    });

    it('refuses an owner without an ID number on the record', async () => {
      const {records, service} = await makeExtracts();
      const r = await records.service.createRecord({parcel: erf1873()}, rec);
      const data = erf1873Data();
      delete data.owners[0].idNo;
      await commitVersion(records, r.id, 1, data);
      await rejects(
        service.issue(forMaria(r), rec),
        409,
        'Maria Nghishidi has no ID number on the land record',
      );
    });

    it('refuses a record with no committed version, and an unknown record', async () => {
      const {records, service, published} = await makeExtracts();
      const draft = await records.service.createRecord(
        {parcel: erf1873()},
        rec,
      );
      await rejects(
        service.issue(forMaria(draft), rec),
        409,
        `${draft.recordNo} has no approved version yet`,
      );
      await rejects(
        service.issue({...forMaria(draft), recordId: UNKNOWN}, rec),
        404,
        'Land record not found',
      );
      expect(published).to.deep.equal([]);
    });

    it('only of the current version: an owner chosen on an older version is refused', async () => {
      const {records, service} = await makeExtracts();
      const record = await committedErf1873(records);
      await records.service.openDraft(record.id, rec);
      const data = erf1873Data();
      data.owners.reverse(); // Tomas first now
      await commitVersion(records, record.id, 2, data);
      await rejects(
        service.issue(forMaria(record), rec),
        409,
        `${record.recordNo} has a newer version (version 2)`,
      );
      // the same owner, on the current version
      const extract = await service.issue(
        forMaria(record, {versionNumber: 2, ownerIndex: 2}),
        rec,
      );
      expect(extract).to.include({
        versionNumber: 2,
        ownerIndex: 2,
        ownerName: 'Maria Nghishidi',
      });
    });

    it('only once the version is on the blockchain; refused when that cannot be checked', async () => {
      const {records, service, anchoring, published} = await makeExtracts();
      const record = await committedErf1873(records);
      const key = `record-version:${record.id}:1`;
      for (const status of [null, {status: 'waiting'}, {status: 'anchored'}]) {
        anchoring.status[key] = status;
        const err = await rejects(
          service.issue(forMaria(record), rec),
          409,
          `Version 1 of ${record.recordNo} is not on the blockchain yet`,
        );
        expect(err.details.status).to.equal(status?.status ?? 'waiting');
      }
      anchoring.status[key] = {status: 'confirmed'};
      anchoring.down = true;
      await rejects(
        service.issue(forMaria(record), rec),
        503,
        'cannot be checked now',
      );
      expect(published).to.deep.equal([]);
      anchoring.down = false;
      expect((await service.issue(forMaria(record), rec)).status).to.equal(
        'valid',
      );
    });

    it('gives every extract its own random token', async () => {
      const {records, service} = await makeExtracts();
      const record = await committedErf1873(records);
      const tokens = new Set();
      for (let i = 0; i < 20; i++) {
        tokens.add((await service.issue(forMaria(record), rec)).token);
      }
      expect(tokens.size).to.equal(20);
      expect(newToken()).to.not.equal(newToken());
      expect(newToken()).to.match(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    });
  });

  describe('the register', () => {
    it("lists a record's extracts newest first, only that record's, saying whether their version is still current", async () => {
      const {records, service, clock} = await makeExtracts();
      const record = await committedErf1873(records);
      const other = await records.service.createRecord(
        {parcel: {...erf1873(), number: '1874'}},
        rec,
      );
      await commitVersion(records, other.id, 1, erf1873Data());
      const first = await service.issue(forMaria(record), rec);
      clock.advance(60_000);
      const second = await service.issue(
        forMaria(record, {ownerIndex: 2, idNo: '01112500379'}),
        rec,
      );
      await service.issue(forMaria(other), rec);
      let {items} = await service.listForRecord(record.id);
      expect(items.map(e => e.id)).to.deep.equal([second.id, first.id]);
      expect(items.map(e => e.ownerName)).to.deep.equal([
        'Tomas Nghishidi',
        'Maria Nghishidi',
      ]);
      expect(items.map(e => e.isCurrentVersion)).to.deep.equal([true, true]);

      // a new version is committed: the extracts stay valid, of a replaced version
      await records.service.openDraft(record.id, rec);
      await commitVersion(records, record.id, 2, erf1873Data());
      ({items} = await service.listForRecord(record.id));
      expect(items.map(e => [e.status, e.isCurrentVersion])).to.deep.equal([
        ['valid', false],
        ['valid', false],
      ]);
      await rejects(service.listForRecord(UNKNOWN), 404);
    });

    it('revokes a valid extract with the reason, once; the event goes to the trail', async () => {
      const {records, service, published, clock} = await makeExtracts();
      const record = await committedErf1873(records);
      const extract = await service.issue(forMaria(record), rec);
      await rejects(service.revoke(extract.id, {reason: '  '}, rec), 400);
      await rejects(service.revoke(extract.id, {}, rec), 400);
      clock.advance(60_000);
      const revoked = await service.revoke(
        extract.id,
        {reason: 'Issued for the wrong owner'},
        rec,
      );
      expect(revoked).to.include({
        id: extract.id,
        status: 'revoked',
        revokedById: users.rec.id,
        revokedByName: users.rec.name,
        revokeReason: 'Issued for the wrong owner',
        token: extract.token,
        isCurrentVersion: true,
      });
      expect(revoked.revokedAt).to.deep.equal(clock());
      await rejects(
        service.revoke(extract.id, {reason: 'Again'}, rec),
        409,
        'The extract is already revoked',
      );
      await rejects(service.revoke(UNKNOWN, {reason: 'x'}, rec), 404);
      // a revoked extract stays in the register
      const {items} = await service.listForRecord(record.id);
      expect(items.map(e => e.status)).to.deep.equal(['revoked']);
      expect(published.map(e => e.type)).to.deep.equal([
        'extracts.extract.issued',
        'extracts.extract.revoked',
      ]);
      const event = published[1];
      expect(event.actor).to.deep.equal(rec);
      expect(event.data).to.deep.equal({
        extractId: extract.id,
        recordId: record.id,
        recordNo: record.recordNo,
        versionNumber: 1,
        reason: 'Issued for the wrong owner',
      });
      expect(subjectsOf(event)).to.include(`record:${record.id}`);
    });
    it('revokes even when the land record cannot be read just after: isCurrentVersion is then null', async () => {
      const {records, service, published} = await makeExtracts();
      const record = await committedErf1873(records);
      const extract = await service.issue(forMaria(record), rec);
      service.records = {
        async getRecord() {
          throw new AppError(503, 'The land records cannot be reached');
        },
      };
      const revoked = await service.revoke(
        extract.id,
        {reason: 'Issued for the wrong owner'},
        rec,
      );
      expect(revoked).to.include({
        id: extract.id,
        status: 'revoked',
        isCurrentVersion: null,
      });
      expect((await service.repo.getExtract(extract.id)).status).to.equal(
        'revoked',
      );
      expect(published.map(e => e.type)).to.include('extracts.extract.revoked');
    });
  });

  describe('over HTTP', () => {
    it('extract.issue for issuing, listing and revoking', async () => {
      const {records, app, as} = await makeExtracts();
      const record = await committedErf1873(records);
      const issue = (u, payload) =>
        app.inject({
          method: 'POST',
          url: '/extracts',
          headers: u ? as(u) : {},
          payload,
        });

      expect((await issue(null, forMaria(record))).statusCode).to.equal(401);
      const denied = await issue(users.sup, forMaria(record));
      expect(denied.statusCode).to.equal(403);
      expect(denied.json().details).to.deep.equal({perm: 'extract.issue'});
      const {idNo: _, ...withoutIdNo} = forMaria(record);
      expect((await issue(users.rec, withoutIdNo)).statusCode).to.equal(400);
      expect(
        (await issue(users.rec, forMaria(record, {documentSeen: false})))
          .statusCode,
      ).to.equal(400);

      const created = await issue(users.rec, forMaria(record));
      expect(created.statusCode).to.equal(201);
      const extract = created.json();
      expect(extract).to.include({
        status: 'valid',
        ownerName: 'Maria Nghishidi',
        isCurrentVersion: true,
      });
      const wrongId = await issue(
        users.rec,
        forMaria(record, {idNo: '99999999999'}),
      );
      expect(wrongId.statusCode).to.equal(409);

      const list = u =>
        app.inject({url: `/extracts?recordId=${record.id}`, headers: as(u)});
      expect((await list(users.sup)).statusCode).to.equal(403);
      expect((await list(users.rec)).json().items.map(e => e.id)).to.deep.equal(
        [extract.id],
      );
      expect(
        (await app.inject({url: '/extracts', headers: as(users.rec)}))
          .statusCode,
      ).to.equal(400);

      const revoke = (u, payload = {reason: 'Lost at the counter'}) =>
        app.inject({
          method: 'POST',
          url: `/extracts/${extract.id}/revoke`,
          headers: as(u),
          payload,
        });
      expect((await revoke(users.sup)).statusCode).to.equal(403);
      expect((await revoke(users.rec, {})).statusCode).to.equal(400);
      expect((await revoke(users.rec)).json().status).to.equal('revoked');
      expect((await revoke(users.rec)).statusCode).to.equal(409);
    });

    it('land-records lets the extracts service read one record and one version, and nothing else', async () => {
      const {records} = await makeExtracts();
      const record = await committedErf1873(records);
      const asService = service => ({
        authorization: `Bearer ${createServiceTokenSigner({secret: SECRET, service})()}`,
      });
      const one = await records.app.inject({
        url: `/records/${record.id}`,
        headers: asService('extracts'),
      });
      expect(one.statusCode).to.equal(200);
      expect(one.json().current.data.owners).to.have.length(3);
      // one version: when the version after an extract's was committed (API-693)
      const version = await records.app.inject({
        url: `/records/${record.id}/versions/1`,
        headers: asService('extracts'),
      });
      expect(version.statusCode).to.equal(200);
      expect(version.json().committedAt).to.be.a('string');
      for (const url of [
        '/records',
        `/records/${record.id}/versions`,
        `/records/${record.id}/history`,
        `/records/${record.id}/verify`,
      ]) {
        const res = await records.app.inject({
          url,
          headers: asService('extracts'),
        });
        expect([401, 403], url).to.include(res.statusCode);
      }
      // another service is still refused the record
      expect(
        (
          await records.app.inject({
            url: `/records/${record.id}`,
            headers: asService('bpm'),
          })
        ).statusCode,
      ).to.equal(403);
      expect(
        (
          await records.app.inject({
            url: `/records/${record.id}/versions/1`,
            headers: asService('bpm'),
          })
        ).statusCode,
      ).to.equal(403);
    });
  });
});
