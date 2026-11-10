/**
 * The record contract (CB-4): the calls a product's record service answers for the shared
 * services, written once. `land-records` answers it today; the bill-of-lading service will answer
 * the same calls. Every call needs a service token. docs/architecture/products.md describes the
 * answers.
 *
 * The client builds the method and path of each call and leaves the sending to the caller's own
 * transport, so that each service keeps its timeouts and error texts.
 */

/**
 * The calls of the contract, by name: the method and the path (the query or body as noted).
 * @type {Readonly<Record<string, {method: string, path: string}>>}
 */
export const RECORD_CALLS = Object.freeze({
  /** A page of records: query `status`, `limit`, `offset`, optionally `q` and `match`. */
  list: {method: 'GET', path: '/records'},
  /** One record with its current committed version (`current`); 404 when unknown. */
  get: {method: 'GET', path: '/records/:id'},
  /** The versions of a record, without their data. */
  versions: {method: 'GET', path: '/records/:id/versions'},
  /** One version of a record, with its data. */
  version: {method: 'GET', path: '/records/:id/versions/:n'},
  /**
   * Numbers and labels of records, the documents of committed versions and the committed versions
   * that pin given documents: body `{recordIds, versions, pinning}`.
   */
  lookup: {method: 'POST', path: '/records/lookup'},
  /** The seals of committed versions, in pages: query `limit`, optionally `after`. */
  seals: {method: 'GET', path: '/records/seals'},
  /** The record service's own recomputation of each version's seal. */
  verify: {method: 'GET', path: '/records/:id/verify'},
  /** Commits a submitted version (approved): body `{by, comment}`. */
  commit: {method: 'POST', path: '/records/:id/versions/:n/commit'},
  /** Sends a submitted version back as a draft (rejected): body `{by, comment}`. */
  reject: {method: 'POST', path: '/records/:id/versions/:n/reject'},
});

/**
 * A transport: sends one call of the contract and answers its JSON.
 * @callback RecordTransport
 * @param {string} method e.g. `GET`
 * @param {string} path the path with its query, e.g. `/records/7/versions/2`
 * @param {object} [body] the JSON body of a POST
 * @return {Promise<any>}
 */

/**
 * A client of the record contract over a transport.
 * @param {RecordTransport} send
 */
export function createRecordClient(send) {
  const call = (name, params = {}, query, body) => {
    const {method, path} = RECORD_CALLS[name];
    return send(method, pathOf(path, params, query), body);
  };
  return {
    /**
     * @param {Record<string, string | number | undefined>} query in the order to send
     */
    list: query => call('list', {}, query),
    /** @param {string} id */
    get: id => call('get', {id}),
    /** @param {string} id */
    versions: id => call('versions', {id}),
    /**
     * @param {string} id
     * @param {number} n
     */
    version: (id, n) => call('version', {id, n}),
    /**
     * @param {{recordIds?: string[], versions?: object[], pinning?: string[]}} body
     */
    lookup: body => call('lookup', {}, undefined, body),
    /** @param {{limit: number, after?: string}} query */
    seals: ({limit, after}) => call('seals', {}, {limit, after}),
    /** @param {string} id */
    verify: id => call('verify', {id}),
    /**
     * @param {string} id
     * @param {number} n
     * @param {{by: {id: string, name: string}, comment?: string}} decision
     */
    commit: (id, n, decision) => call('commit', {id, n}, undefined, decision),
    /**
     * @param {string} id
     * @param {number} n
     * @param {{by: {id: string, name: string}, comment?: string}} decision
     */
    reject: (id, n, decision) => call('reject', {id, n}, undefined, decision),
  };
}

/**
 * Fills a path's `:id` and `:n` and adds the query (entries left out when undefined or empty).
 * @param {string} path
 * @param {{id?: string, n?: number}} params
 * @param {Record<string, unknown>} [query]
 * @return {string}
 */
export function pathOf(path, params, query) {
  let filled = path;
  if (params.id !== undefined) {
    filled = filled.replace(':id', encodeURIComponent(params.id));
  }
  if (params.n !== undefined) {
    filled = filled.replace(':n', String(Number(params.n)));
  }
  if (!query) {
    return filled;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `${filled}?${text}` : filled;
}
