import {AppError} from '@lrfe/common';

/** The list filters of the Audit screen (README.md section 5). */
export const LIST_FILTERS = ['changed', 'attention', 'all'];

/** How many land records are read from land-records per request while filtering. */
const READ_PAGE = 200;

/**
 * The land records list of the Audit screen (API-661). Auditors check a sample, so the list offers
 * the population to pick from, not a to-do list:
 *
 *   changed     records with a version committed since their last audit sign-off
 *   attention   records with an open finding, or an item found changed since review and not yet
 *               re-reviewed
 *   all         every record with a committed version
 *
 * The filters and their counts use only what the audit service already knows (sign-offs, findings,
 * changed items), so they stay cheap. Each record on the page also gets its audit summary: the open
 * range, how many documents it added, and the result of the blockchain check as far as it is known.
 * The full check runs when a record is opened (`GET /audit/records/:id/check`).
 *
 * `sources`: { records({ q, status, limit, offset }), versions(recordId) → committed versions with
 * their data } from land-records.
 */
export class AuditListService {
  constructor({repo, proofs, sources}) {
    this.repo = repo;
    this.proofs = proofs;
    this.sources = sources;
  }

  async list({q, filter = 'changed', limit = 25, offset = 0} = {}) {
    const records = await this.allRecords(q);
    const lastTo = await this.lastAudited();
    const attention = await this.needingAttention(records);
    const isChanged = r => r.currentVersion > (lastTo.get(r.id) ?? 0);
    const tests = {
      changed: isChanged,
      attention: r => attention.has(r.id),
      all: () => true,
    };
    const counts = {
      changed: records.filter(tests.changed).length,
      attention: records.filter(tests.attention).length,
      all: records.length,
    };
    const matching = records.filter(tests[filter]);
    const page = matching.slice(offset, offset + limit);
    const items = [];
    for (const r of page) {
      items.push(
        await this.summary(r, lastTo.get(r.id) ?? 0, attention.has(r.id)),
      );
    }
    return {items, total: matching.length, counts};
  }

  /** Every land record with a committed version, matching `q`, newest change first. */
  async allRecords(q) {
    const out = [];
    for (let offset = 0; ; offset += READ_PAGE) {
      const page = await this.sources.records({
        q,
        status: 'committed',
        limit: READ_PAGE,
        offset,
      });
      out.push(...page.items.filter(r => r.currentVersion));
      if (page.items.length < READ_PAGE || out.length >= page.total) {
        break;
      }
    }
    return out.sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
  }

  /** recordId → the last version an audit sign-off covered. */
  async lastAudited() {
    const out = new Map();
    for (const s of await this.repo.listSignoffs({})) {
      if (s.kind === 'checkpoint' && s.toVersion > (out.get(s.recordId) ?? 0)) {
        out.set(s.recordId, s.toVersion);
      }
    }
    return out;
  }

  /** The ids of the records with an open finding, or a changed item not re-reviewed since. */
  async needingAttention(records) {
    const current = new Map(records.map(r => [r.id, r.currentVersion]));
    const out = new Set();
    for (const f of await this.repo.listFindings({status: 'open'})) {
      if (f.recordId) {
        out.add(f.recordId);
      }
    }
    for (const alert of await this.repo.listAlerts()) {
      // no version committed since the change was found: not re-reviewed yet
      if (current.get(alert.recordId) === alert.currentVersion) {
        out.add(alert.recordId);
      }
    }
    return out;
  }

  /** One record's row: its current version, proof, open audit range and what is known of it. */
  async summary(record, lastTo, needsAttention) {
    const versions = (await this.sources.versions(record.id)).filter(v =>
      ['committed', 'superseded'].includes(v.state),
    );
    const current = versions.find(
      v => v.versionNumber === record.currentVersion,
    );
    const inRange = versions.filter(v => v.versionNumber > lastTo);
    const covered = new Set(
      versions.filter(v => v.versionNumber <= lastTo).flatMap(v => pinKeys(v)),
    );
    const newDocuments = [...new Set(inRange.flatMap(v => pinKeys(v)))].filter(
      k => !covered.has(k),
    );
    const keys = [
      ...inRange.map(v => `record-version:${record.id}:${v.versionNumber}`),
      ...newDocuments,
    ];
    const anchoring = keys.length ? await this.proofs.anchoringOf(keys) : {};
    const currentKey = `record-version:${record.id}:${record.currentVersion}`;
    const currentProof = (await this.proofs.anchoringOf([currentKey]))[
      currentKey
    ];
    return {
      id: record.id,
      recordNo: record.recordNo,
      label: record.label,
      currentVersion: record.currentVersion,
      changedAt: current?.committedAt ?? record.updatedAt,
      owners: (current?.data?.owners || []).map(o => o.name),
      proof: currentProof?.status ?? 'waiting',
      proofBatch: currentProof?.batch ?? null,
      needsAttention,
      audit: {
        range: inRange.length
          ? {from: lastTo + 1, to: record.currentVersion}
          : null,
        newDocuments: newDocuments.length,
        check: await this.knownCheck(record, keys, anchoring),
        openFindings: (
          await this.repo.listFindings({recordId: record.id, status: 'open'})
        ).length,
        lastSignoff: await this.lastSignoff(record.id),
      },
    };
  }

  /**
   * What is known of the open range without checking it now: `changed` when an item was found
   * changed and not re-reviewed since, `notOnChain` when an item is not in a block yet, else
   * `matches` (as of the last check).
   */
  async knownCheck(record, keys, anchoring) {
    for (const key of keys) {
      const alert = await this.repo.getAlert(key);
      if (alert && alert.currentVersion === record.currentVersion) {
        return 'changed';
      }
    }
    if (
      keys.some(k => !['onChain', 'confirmed'].includes(anchoring[k]?.status))
    ) {
      return 'notOnChain';
    }
    return 'matches';
  }

  /** The record's last audit sign-off and how far its own trail entry has got on the blockchain. */
  async lastSignoff(recordId) {
    const signoffs = (await this.repo.listSignoffs({recordId})).filter(
      s => s.kind === 'checkpoint',
    );
    const last = signoffs.at(-1);
    if (!last) {
      return null;
    }
    // the four states of the record screens, and the batch its trail entry is in (API-699)
    const {status, batch} = await this.proofs.signoffBatch(recordId, last.id);
    return {
      toVersion: last.toVersion,
      signedAt: last.signedAt,
      signedByName: last.signedByName,
      proof: status,
      batch,
    };
  }
}

/** The leaf keys of the document versions a land record version pins. */
function pinKeys(version) {
  return (version.data?.documents || []).map(
    d => `document-version:${d.edrmsDocumentId}:${d.version}`,
  );
}

/** land-records over HTTP with the audit service's token. */
export function createListSources({
  recordsUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  const read = async url => {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {authorization: `Bearer ${serviceToken()}`},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AppError(
        503,
        `The land records service cannot be reached: ${err.message}`,
      );
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON (a proxy's error page): reported by status below
    }
    if (res.status >= 400 || !json) {
      throw new AppError(
        502,
        `Reading from the land records service failed (${res.status}): ${json?.message || 'no detail'}`,
      );
    }
    return json;
  };
  return {
    records({q, status, limit, offset}) {
      const params = new URLSearchParams({
        status,
        limit: String(limit),
        offset: String(offset),
      });
      if (q) {
        params.set('q', q);
      }
      return read(`${recordsUrl}/records?${params}`);
    },
    /** Every committed version with its data (the list leaves the data out). */
    async versions(recordId) {
      const listed = await read(`${recordsUrl}/records/${recordId}/versions`);
      const committed = listed.filter(v =>
        ['committed', 'superseded'].includes(v.state),
      );
      return Promise.all(
        committed.map(v =>
          read(`${recordsUrl}/records/${recordId}/versions/${v.versionNumber}`),
        ),
      );
    },
  };
}
