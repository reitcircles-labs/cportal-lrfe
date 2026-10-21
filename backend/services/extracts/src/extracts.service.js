import {randomBytes, randomUUID} from 'node:crypto';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@lrfe/common';
import {checkOnChain, checkOwner, lastFour} from './issue-checks.js';

/** Who an action is recorded as when no person makes it: tests. */
const SYSTEM = {id: 'system', name: 'System'};

/** A token nobody can guess: 32 random bytes, URL-safe (it goes into the extract's QR code). */
export const newToken = () => randomBytes(32).toString('base64url');

/**
 * The register of ownership extracts (README.md). An extract is issued for an owner on a land
 * record's current committed version (read from land-records) once that version is on the
 * blockchain (asked of the audit service); it can be revoked with a reason. Each issue and
 * revocation is an event, so it is in the audit trail.
 */
export class ExtractsService {
  constructor({
    repo,
    events,
    records = null,
    anchoring = null,
    clock = () => new Date(),
    token = newToken,
  }) {
    this.repo = repo;
    this.events = events;
    this.records = records; // land-records, read with the extracts service's token
    this.anchoring = anchoring; // the audit service: is a version on the blockchain
    this.clock = clock;
    this.token = token;
  }

  /** Run `fn` so its writes and the events it publishes are committed together (API-613). */
  atomic(fn) {
    return this.events?.atomic ? this.events.atomic(fn) : fn();
  }

  /**
   * Issue an extract of a land record's current version for one of its owners: `ownerIndex` on
   * version `versionNumber`, the ID number `idNo` typed from the identity document the staff member
   * was shown, `documentSeen` true. checkOwner and checkOnChain say what is refused.
   */
  async issue(request, actor = SYSTEM) {
    const record = await this.requireRecord(request.recordId);
    const owner = checkOwner(record, request);
    await checkOnChain(this.anchoring, record, request.versionNumber);
    const extract = {
      id: randomUUID(),
      recordId: record.id,
      recordNo: record.recordNo,
      versionNumber: request.versionNumber,
      issuedById: actor.id,
      issuedByName: actor.name,
      ownerIndex: owner.index,
      ownerName: owner.name,
      ownerIdLast4: lastFour(owner.idNo),
      documentSeen: true,
      issuedAt: this.clock(),
      token: this.token(),
      status: 'valid',
      revokedAt: null,
      revokedById: null,
      revokedByName: null,
      revokeReason: null,
    };
    // the register row and its event are committed together (API-613)
    await this.atomic(async () => {
      await this.repo.addExtract(extract);
      await this.events?.publish(
        'extracts.extract.issued',
        {...this.eventData(extract), issuedFor: {name: extract.ownerName}},
        {actor},
      );
    });
    return withCurrent(extract, record);
  }

  /** The extracts of a land record, newest first, each saying whether its version is still current. */
  async listForRecord(recordId) {
    const record = await this.requireRecord(recordId);
    const items = await this.repo.listExtracts(recordId);
    return {items: items.map(extract => withCurrent(extract, record))};
  }

  /** Revoke a valid extract, with the reason. A revoked extract stays in the register. */
  async revoke(id, {reason} = {}, actor = SYSTEM) {
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestError('Give the reason');
    const extract = await this.repo.getExtract(id);
    if (!extract) throw new NotFoundError('Extract not found');
    if (extract.status !== 'valid') {
      throw new ConflictError('The extract is already revoked');
    }
    let revoked;
    await this.atomic(async () => {
      revoked = await this.repo.revokeExtract(id, {
        revokedAt: this.clock(),
        revokedById: actor.id,
        revokedByName: actor.name,
        revokeReason: why,
      });
      // revoked by someone else meanwhile
      if (!revoked) throw new ConflictError('The extract is already revoked');
      await this.events?.publish(
        'extracts.extract.revoked',
        {...this.eventData(revoked), reason: why},
        {actor},
      );
    });
    return withCurrent(revoked, await this.requireRecord(revoked.recordId));
  }

  /** The land record with its current version, from land-records. */
  async requireRecord(recordId) {
    if (!this.records) {
      throw new AppError(503, 'The land records are not available');
    }
    const record = await this.records.getRecord(recordId);
    if (!record) throw new NotFoundError('Land record not found');
    return record;
  }

  /** What the events say about an extract: never the token or the owner's ID number. */
  eventData(extract) {
    return {
      extractId: extract.id,
      recordId: extract.recordId,
      recordNo: extract.recordNo,
      versionNumber: extract.versionNumber,
    };
  }
}

/** The register row with `isCurrentVersion`: its version is still the record's current one. */
function withCurrent(extract, record) {
  return {
    ...extract,
    isCurrentVersion: extract.versionNumber === record.currentVersion,
  };
}
