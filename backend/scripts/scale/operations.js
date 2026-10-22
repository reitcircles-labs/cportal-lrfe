/**
 * What the load tests do (API-769): the officer's requests, through the gateway as the web app
 * sends them, with inputs drawn from the test register itself; and filing new documents into edrms
 * as intake does, timed until land-records has flagged the record they belong to (API-766).
 */
import {createHmac, randomUUID} from 'node:crypto';
import {createServiceTokenSigner} from '@lrfe/common';
import {ROLES, effectivePerms} from '../../services/identity/src/catalogue.js';
import {createRandom} from './random.js';

/** Inputs drawn from the register per kind, enough that caches see a realistic spread. */
const SAMPLE = 400;

/**
 * A records officer's access token, as identity issues it at sign-in, signed with the stack's
 * secret. Signed here because signing in needs the officer's authenticator code, and
 * @lrfe/common only signs service tokens.
 */
export function officerToken(secret) {
  const now = Math.floor(Date.now() / 1000);
  const base64Json = value =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    typ: 'access',
    sub: 'load-test-officer',
    name: 'Load test records officer',
    email: 'load-test@example.invalid',
    roles: ['rec'],
    perms: effectivePerms(['rec'], ROLES),
    sid: randomUUID(),
    iat: now,
    exp: now + 4 * 3600,
  };
  const data = `${base64Json({alg: 'HS256', typ: 'JWT'})}.${base64Json(claims)}`;
  const signature = createHmac('sha256', secret)
    .update(data)
    .digest('base64url');
  return `${data}.${signature}`;
}

/** Search words an officer types: a deed number, an erf number and township, a name, a word start. */
function searchTerms(documents) {
  const terms = [];
  for (const document of documents) {
    if (document.ref) terms.push(document.ref);
    if (document.owner) terms.push(document.owner);
    const erf = /^(?:Portion \w+ of )?Erf (\d+), (.+)$/.exec(
      document.property ?? '',
    );
    if (erf) {
      const [, number, township] = erf;
      terms.push(`${number} ${township}`, township.slice(0, 4));
    }
  }
  return terms;
}

/** Inputs for every operation, sampled from the register in the database. */
export async function sampleInputs(db) {
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  const documents = await rows(
    `SELECT "id", "instrumentRef" AS "ref", "props"->>'property' AS "property", "props"->>'tee1' AS "owner"
       FROM "edrms"."document" WHERE "docType" IN ('deed_of_transfer', 'deed_of_grant')
      ORDER BY random() LIMIT ${SAMPLE}`,
  );
  const records = await rows(
    `SELECT "id", "recordNo", "label", "searchText" FROM "records"."land_record"
      WHERE "status" = 'committed' AND "discardedAt" IS NULL ORDER BY random() LIMIT ${SAMPLE}`,
  );
  // a record number, an erf number, and an owner's name: the search text is the record
  // number, label, parcel key, then the owners' names and ID numbers (search-text.js)
  const recordTerms = records.flatMap(record => [
    record.recordNo,
    record.label.replace(/^Erf (\d+),.*$/, '$1'),
    record.searchText.split(' · ')[3] ?? record.label,
  ]);
  return {
    documentIds: documents.map(document => document.id),
    terms: searchTerms(documents),
    recordIds: records.map(record => record.id),
    recordTerms,
  };
}

/** The operations measured, each a function that sends one request with a random input. */
export function createOperations({gatewayUrl, token, inputs, seed}) {
  const random = createRandom(seed);
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const send = async (path, body) => {
    const res = await fetch(`${gatewayUrl}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
    }
  };
  const query = params => new URLSearchParams(params).toString();
  const term = () => random.pick(inputs.terms);
  const recordId = () => random.pick(inputs.recordIds);
  const list = status => () =>
    send(`/records?${query({...(status ? {status} : {}), limit: '200'})}`);
  return {
    'Documents screen search': () =>
      send(`/documents?${query({q: term(), limit: '100'})}`),
    'Record screen document search': () =>
      send(`/records/document-search?${query({q: term(), limit: '30'})}`),
    'Document details': () =>
      send(`/records/document-details/${random.pick(inputs.documentIds)}`),
    Suggestions: () => send(`/records/${recordId()}/suggestions`),
    'New record preview': () =>
      send('/records/preview', {
        edrmsDocumentId: random.pick(inputs.documentIds),
      }),
    'Record list': list(null),
    'Record list search': () =>
      send(
        `/records?${query({q: random.pick(inputs.recordTerms), limit: '200'})}`,
      ),
    'Work list: in review': list('in_review'),
    'Work list: needs review': list('needs_review'),
    'Work list: new document': list('new_document'),
    'Work list: drafts': list('draft'),
    'Work list: bin': list('in_bin'),
  };
}

/** What each work list holds in the database, as the service defines it (records-reading.js). */
const WORK_LISTS = {
  in_review: `"draftState" = 'in_review'`,
  needs_review: `EXISTS (SELECT 1 FROM jsonb_array_elements("flags") flag WHERE flag->>'type' <> 'document_filed')`,
  new_document: `"flags" @> '[{"type": "document_filed"}]'`,
  draft: `"status" = 'draft'`,
};

/**
 * Whether each work list shows every record it should: the total the screen gets against the
 * records in the database. Fast answers are worth little if records go missing at scale.
 */
export async function workListCompleteness({gatewayUrl, token, db}) {
  const out = [];
  for (const [status, condition] of Object.entries(WORK_LISTS)) {
    const res = await fetch(
      `${gatewayUrl}/api/records?status=${status}&limit=200`,
      {headers: {authorization: `Bearer ${token}`}},
    );
    if (!res.ok) {
      throw new Error(`work list ${status}: ${res.status} ${await res.text()}`);
    }
    const {total: shown} = await res.json();
    const {rows} = await db.query(
      `/* load-test */ SELECT count(*)::int AS "n" FROM "records"."land_record"
        WHERE "discardedAt" IS NULL AND ${condition}`,
    );
    out.push({status, shown, inDatabase: rows[0].n});
  }
  return out;
}

/**
 * Files new documents for parcels that have an approved record, as intake files them into edrms,
 * and resolves each with the time until land-records has flagged the record (API-766).
 */
export function createFiling({edrmsUrl, secret, db}) {
  const token = createServiceTokenSigner({secret, service: 'intake'});
  // a bond number no document has: the register numbers each year from 1, and each run starts
  // from the clock, so a second run on the same register does not repeat the first one's
  let next = Math.floor(Date.now() / 1000) % 100_000_000;

  /** Committed records with the property and last title deed their documents give. */
  async function parcels(count) {
    const {rows} = await db.query(
      `/* load-test */ WITH r AS (
         SELECT "id", "currentVersion" FROM "records"."land_record"
          WHERE "status" = 'committed' AND "discardedAt" IS NULL AND "draftVersion" IS NULL
          ORDER BY random() LIMIT $1)
       SELECT r."id", d->'fields'->>'property' AS "property", d->>'ref' AS "deed"
         FROM r
         JOIN "records"."record_version" v ON v."recordId" = r."id" AND v."versionNumber" = r."currentVersion"
         CROSS JOIN LATERAL (
           SELECT x FROM jsonb_array_elements(v."data"->'documents') x
            WHERE x->>'docType' IN ('deed_of_transfer', 'deed_of_grant') ORDER BY x->>'edrmsNo' DESC LIMIT 1) t(d)`,
      [count],
    );
    return rows;
  }

  /** A new bond over the parcel, citing its title deed: matched by property and by chain. */
  async function file(parcel) {
    next += 1;
    const bondNo = `B ${next}/2026`;
    const meta = {
      sourceId: randomUUID(),
      docType: 'mortgage_bond',
      title: 'Mortgage bond',
      pages: 4,
      fields: [
        {k: 'bondNo', label: 'Bond number', v: bondNo},
        {k: 'regDate', label: 'Registration date', v: '1 October 2026'},
        {k: 'property', label: 'Property description', v: parcel.property},
        {k: 'mortgagor', label: 'Mortgagor', v: 'Load Test Owner'},
        {k: 'mortgagee', label: 'Mortgagee', v: 'Load Test Bank Ltd'},
        {k: 'priorTitle', label: 'Title deed', v: parcel.deed},
      ],
      reviewedBy: {id: 'load-test-reviewer', name: 'Load test reviewer'},
    };
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append(
      'file',
      new Blob(['%PDF-1.4\n% load test\n'], {type: 'application/pdf'}),
      `${bondNo.replace(/\W+/g, '-')}.pdf`,
    );
    // wall-clock time on this machine, as the flag's own time: polling late does not count
    const started = Date.now();
    const res = await fetch(`${edrmsUrl}/documents`, {
      method: 'POST',
      headers: {authorization: `Bearer ${token()}`},
      body: form,
    });
    const text = await res.text();
    if (res.status !== 201) {
      throw new Error(`filing failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const {document} = JSON.parse(text);
    return {recordId: parcel.id, documentId: document.id, started};
  }

  /**
   * Resolves when every filing's record carries its flag, or after `timeoutMs`: for each, the
   * milliseconds from filing to the time land-records gave the flag.
   */
  async function flagged(filings, timeoutMs) {
    const waiting = new Map(filings.map(filing => [filing.documentId, filing]));
    const recordIds = [...new Set(filings.map(filing => filing.recordId))];
    const times = [];
    const until = Date.now() + timeoutMs;
    while (waiting.size && Date.now() < until) {
      const {rows} = await db.query(
        `/* load-test */ SELECT flag->>'edrmsDocumentId' AS "documentId", flag->>'at' AS "at"
           FROM "records"."land_record" r CROSS JOIN LATERAL jsonb_array_elements(r."flags") flag
          WHERE r."id" = ANY($1::uuid[]) AND flag->>'edrmsDocumentId' = ANY($2::text[])`,
        [recordIds, [...waiting.keys()]],
      );
      for (const {documentId, at} of rows) {
        const filing = waiting.get(documentId);
        if (filing) {
          times.push(Date.parse(at) - filing.started);
          waiting.delete(documentId);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {times, missed: waiting.size};
  }

  return {parcels, file, flagged};
}
