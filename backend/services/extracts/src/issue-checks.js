import {AppError, BadRequestError, ConflictError} from '@lrfe/common';

/** An ID number as compared: without spaces or dashes. */
const idKey = idNo => String(idNo ?? '').replace(/[\s-]+/g, '');

/** The last four characters of an ID number: all of it the register keeps. */
export const lastFour = idNo => idKey(idNo).slice(-4);

/**
 * The owner an extract is issued for, checked against the record's current version: the version
 * the staff member chose from must still be the current one, `ownerIndex` an owner on it, and the
 * ID number typed from the identity document they were shown the owner's ID number on the version.
 * @return {{index: number, name: string, idNo: string}}
 */
export function checkOwner(
  record,
  {versionNumber, ownerIndex, idNo, documentSeen},
) {
  if (documentSeen !== true) {
    throw new BadRequestError(
      'Confirm that you have seen the owner’s identity document',
    );
  }
  const version = record.current;
  if (!version) {
    throw new ConflictError(
      `${record.recordNo} has no approved version yet: an extract can be issued once a version is approved`,
      {recordNo: record.recordNo},
    );
  }
  if (version.versionNumber !== versionNumber) {
    throw new ConflictError(
      `${record.recordNo} has a newer version (version ${version.versionNumber}): open the record again and choose the owner there`,
      {recordNo: record.recordNo, versionNumber: version.versionNumber},
    );
  }
  const owner = (version.data?.owners || [])[ownerIndex];
  if (!owner) {
    throw new ConflictError(
      `There is no such owner on version ${versionNumber} of ${record.recordNo}`,
    );
  }
  if (!idKey(owner.idNo)) {
    throw new ConflictError(
      `${owner.name} has no ID number on the land record: the identity document cannot be checked against it`,
    );
  }
  if (idKey(idNo) !== idKey(owner.idNo)) {
    throw new ConflictError(
      `The ID number does not match ${owner.name}’s ID number on the land record: check the identity document`,
    );
  }
  return {index: ownerIndex, name: owner.name, idNo: owner.idNo};
}

/**
 * Refuses a version that is not on the blockchain yet: its anchoring must be confirmed (the audit
 * service's status of the leaf `record-version:<id>:<n>`). The status client is best effort and
 * says nothing for a key it could not ask about: then the check cannot be made now.
 */
export async function checkOnChain(anchoring, record, versionNumber) {
  const key = `record-version:${record.id}:${versionNumber}`;
  const statuses = anchoring ? await anchoring.statusOf([key]) : {};
  if (!(key in statuses)) {
    throw new AppError(
      503,
      'Whether the version is on the blockchain cannot be checked now: try again later',
    );
  }
  if (statuses[key]?.status !== 'confirmed') {
    throw new ConflictError(
      `Version ${versionNumber} of ${record.recordNo} is not on the blockchain yet: an extract can be issued once it is`,
      {status: statuses[key]?.status ?? 'waiting'},
    );
  }
}
