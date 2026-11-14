import {ConflictError} from '@lrfe/common';

/**
 * A copy of a stored value, so a caller never changes the store by changing what it got.
 * @param {*} value
 * @return {*}
 */
function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

/**
 * Compares two values for sorting: negative, zero or positive.
 * @param {(number|string)} a
 * @param {(number|string)} b
 * @return {number}
 */
function compare(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * The position of a committed version in the seals list: when, which record, which version.
 * @param {{at: (Date|string), id: string, version: number}} position
 * @return {!Array<(number|string)>}
 */
function sealKey({at, id, version}) {
  return [new Date(at).getTime(), id, version];
}

/**
 * Compares two positions of the seals list.
 * @param {!Array<(number|string)>} a
 * @param {!Array<(number|string)>} b
 * @return {number}
 */
function compareSealKeys(a, b) {
  return compare(a[0], b[0]) || compare(a[1], b[1]) || compare(a[2], b[2]);
}

/**
 * Whether a record's number or label holds the words searched for (any case).
 * @param {object} record
 * @param {string} needle lower case
 * @return {boolean}
 */
function matches(record, needle) {
  return [record.recordNo, record.label].some(text =>
    String(text).toLowerCase().includes(needle),
  );
}

/**
 * The error for a B/L reference the organisation already holds.
 * @return {!ConflictError}
 */
function duplicate() {
  return new ConflictError(
    'Your organisation already has a B/L with this carrier code and transport document reference',
  );
}

/**
 * Whether a version may be updated: it exists, and is still in the state and at the revision the
 * caller read (when it names them).
 * @param {(object|undefined)} version the stored version
 * @param {{expectedState?: string, expectedRevision?: number}} expected
 * @return {boolean}
 */
function canUpdate(version, {expectedState, expectedRevision}) {
  if (!version) {
    return false;
  }
  if (expectedState !== undefined && version.state !== expectedState) {
    return false;
  }
  return (
    expectedRevision === undefined || version.revision === expectedRevision
  );
}

/**
 * In-memory shipping-records repository (tests, RECORDS_STORE=memory). Behaviour must match
 * ./sequelize.js: one record per organisation, carrier code and reference, one version per number,
 * state and revision checks on version updates, commits that change the version and the record
 * in one step, and one title per B/L changed only at the revision read.
 * @return {!Object<string, function(...*): !Promise<*>>}
 */
export function createMemoryRepo() {
  const records = new Map();
  const versions = [];
  const titles = new Map();

  /**
   * The stored version itself (not a copy), or undefined.
   * @param {string} recordId
   * @param {number} n
   * @return {(object|undefined)}
   */
  function findVersion(recordId, n) {
    return versions.find(v => v.recordId === recordId && v.versionNumber === n);
  }

  /**
   * The stored record of this organisation with this carrier code and reference, or undefined.
   * @param {{organisationId: string, carrierCode: string, recordNo: string}} reference
   * @return {(object|undefined)}
   */
  function findByReference({organisationId, carrierCode, recordNo}) {
    return [...records.values()].find(
      r =>
        r.organisationId === organisationId &&
        r.carrierCode === carrierCode &&
        r.recordNo === recordNo,
    );
  }

  return {
    /**
     * A new record with its first version; 409 when its organisation already holds the reference.
     * @param {{record: object, version: object}} created
     * @return {!Promise<object>} the record
     */
    async createRecord({record, version}) {
      if (findByReference(record)) {
        throw duplicate();
      }
      records.set(record.id, clone(record));
      versions.push(clone(version));
      return clone(record);
    },
    /**
     * @param {string} id
     * @return {!Promise<?object>}
     */
    async getRecord(id) {
      return clone(records.get(id)) ?? null;
    },
    /**
     * The record of an organisation with a carrier code and reference.
     * @param {{organisationId: string, carrierCode: string, recordNo: string}} reference
     * @return {!Promise<?object>}
     */
    async findRecord(reference) {
      return clone(findByReference(reference)) ?? null;
    },
    /**
     * A page of records, newest first; `organisationId` null for every organisation's.
     * @param {{
     *   organisationId?: ?string,
     *   status?: string,
     *   draftState?: string,
     *   q?: string,
     *   limit?: number,
     *   offset?: number,
     * }} [query]
     * @return {!Promise<{items: !Array<object>, total: number}>}
     */
    async listRecords({
      organisationId = null,
      status,
      draftState,
      q,
      limit = 50,
      offset = 0,
    } = {}) {
      const needle = q?.toLowerCase();
      const all = [...records.values()]
        .filter(
          r => organisationId === null || r.organisationId === organisationId,
        )
        .filter(r => !status || r.status === status)
        .filter(r => !draftState || r.draftState === draftState)
        .filter(r => !needle || matches(r, needle))
        .sort(
          (a, b) =>
            compare(b.createdAt.getTime(), a.createdAt.getTime()) ||
            compare(a.id, b.id),
        );
      return {
        items: all.slice(offset, offset + limit).map(clone),
        total: all.length,
      };
    },
    /**
     * @param {string} id
     * @param {object} patch
     * @return {!Promise<?object>} the record, or null when there is none
     */
    async updateRecord(id, patch) {
      const record = records.get(id);
      if (!record) {
        return null;
      }
      Object.assign(record, clone(patch));
      return clone(record);
    },

    /**
     * @param {string} recordId
     * @param {number} n
     * @return {!Promise<?object>}
     */
    async getVersion(recordId, n) {
      return clone(findVersion(recordId, n)) ?? null;
    },
    /**
     * @param {string} recordId
     * @return {!Promise<!Array<object>>} oldest first
     */
    async listVersions(recordId) {
      return versions
        .filter(v => v.recordId === recordId)
        .sort((a, b) => a.versionNumber - b.versionNumber)
        .map(clone);
    },
    /**
     * @param {object} version
     * @return {!Promise<object>}
     */
    async addVersion(version) {
      if (findVersion(version.recordId, version.versionNumber)) {
        throw new ConflictError(
          `Version ${version.versionNumber} already exists`,
        );
      }
      versions.push(clone(version));
      return clone(version);
    },
    /**
     * Update a version; with `expectedState` and `expectedRevision`, only while it is still in
     * that state and at that revision (else null).
     * @param {string} recordId
     * @param {number} n
     * @param {object} patch
     * @param {{expectedState?: string, expectedRevision?: number}} [expected]
     * @return {!Promise<?object>}
     */
    async updateVersion(recordId, n, patch, expected = {}) {
      const version = findVersion(recordId, n);
      if (!canUpdate(version, expected)) {
        return null;
      }
      Object.assign(version, clone(patch));
      return clone(version);
    },
    /**
     * Commit a version in review: it becomes committed and the record is updated.
     * @param {{
     *   recordId: string,
     *   versionNumber: number,
     *   versionPatch: object,
     *   recordPatch: object,
     * }} commit
     * @return {!Promise<{record: object, version: object}>}
     */
    async commit({recordId, versionNumber, versionPatch, recordPatch}) {
      const version = findVersion(recordId, versionNumber);
      if (!version || version.state !== 'in_review') {
        throw new ConflictError('The version is not in review');
      }
      Object.assign(version, clone(versionPatch), {state: 'committed'});
      Object.assign(records.get(recordId), clone(recordPatch));
      return {record: clone(records.get(recordId)), version: clone(version)};
    },

    /**
     * The title of a B/L (CB-31), or null before it is issued.
     * @param {string} recordId
     * @return {!Promise<?object>}
     */
    async getTitle(recordId) {
      return clone(titles.get(recordId)) ?? null;
    },
    /**
     * A B/L's first title; null when it has one already (one title per B/L, as the primary key
     * of ./sequelize.js's table makes it).
     * @param {object} title the title with its `recordId`
     * @return {!Promise<?object>}
     */
    async createTitle(title) {
      if (titles.has(title.recordId)) {
        return null;
      }
      titles.set(title.recordId, clone(title));
      return clone(title);
    },
    /**
     * Changes a B/L's title, only while it is still at the revision the caller read (else null).
     * @param {string} recordId
     * @param {object} patch
     * @param {number} expectedRevision
     * @return {!Promise<?object>}
     */
    async updateTitle(recordId, patch, expectedRevision) {
      const title = titles.get(recordId);
      if (!title || title.revision !== expectedRevision) {
        return null;
      }
      Object.assign(title, clone(patch));
      return clone(title);
    },

    /**
     * Every committed version's seal, oldest first, after the cursor `after`.
     * @param {{after?: ?{at: string, id: string, version: number}, limit?: number}} [page]
     * @return {!Promise<!Array<{recordId: string, version: number, seal: string, at: Date}>>}
     */
    async listSeals({after = null, limit = 500} = {}) {
      /**
       * A version's position in the seals list.
       * @param {object} v
       * @return {!Array<(number|string)>}
       */
      const keyOf = v =>
        sealKey({at: v.committedAt, id: v.recordId, version: v.versionNumber});
      const from = after ? sealKey(after) : null;
      return versions
        .filter(v => v.seal)
        .sort((a, b) => compareSealKeys(keyOf(a), keyOf(b)))
        .filter(v => !from || compareSealKeys(keyOf(v), from) > 0)
        .slice(0, limit)
        .map(v => ({
          recordId: v.recordId,
          version: v.versionNumber,
          seal: v.seal,
          at: v.committedAt,
        }));
    },
    /**
     * Number and label of each record by id.
     * @param {!Array<string>} ids
     * @return {!Promise<!Array<{id: string, recordNo: string, label: string}>>}
     */
    async recordLabels(ids) {
      return ids
        .filter(id => records.has(id))
        .map(id => ({
          id,
          recordNo: records.get(id).recordNo,
          label: records.get(id).label,
        }));
    },
    /**
     * Which of these versions are committed.
     * @param {!Array<{recordId: string, versionNumber: number}>} pairs
     * @return {!Promise<!Array<{recordId: string, versionNumber: number}>>}
     */
    async committedVersions(pairs) {
      return pairs
        .filter(
          p => findVersion(p.recordId, p.versionNumber)?.state === 'committed',
        )
        .map(p => ({recordId: p.recordId, versionNumber: p.versionNumber}));
    },
  };
}
