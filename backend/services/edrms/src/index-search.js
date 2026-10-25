import {AppError} from '@lrfe/common';
import {INDEX_ALIAS, buildSearchQuery} from '@lrfe/search-index';

/** Totals above this many are reported as "more than" it (counting every match costs time). */
export const TOTAL_CAP = 1000;

/** What a search reads of an entry: enough to load a filed document, or to show one in intake. */
const SOURCE = [
  'documentId',
  'status',
  'intakeStatus',
  'edrmsId',
  'docType',
  'shown',
];

/**
 * Document search through the search index (API-803, `EDRMS_SEARCH=opensearch`): the matching
 * entries, best first, among only those the user may see. Every query carries that filter: filed
 * documents (edrms' rule: any of its read permissions, checked by the route) and, for a user with
 * intake's read permission, documents still in intake. When the engine cannot answer, an error:
 * never results without the filter, never a fallback that would show other results.
 * @param {{request: Function, pack: object}} deps the engine connection and the country pack
 */
export function createIndexSearch({request, pack}) {
  return {
    /**
     * `{ hits: [entry], total, totalCapped }`; `totalCapped`: there are more than `total`.
     * @param {{q: string, docType?: string, intake: boolean, limit: number, offset: number}} query
     */
    async search({q, docType, intake, limit, offset}) {
      const body = buildSearchQuery(q, pack, {size: limit, from: offset});
      if (!body) return {hits: [], total: 0, totalCapped: false};
      body.track_total_hits = TOTAL_CAP;
      body._source = SOURCE;
      body.query = {
        bool: {
          must: [body.query],
          filter: [
            {
              terms: {
                'access.audience': intake ? ['edrms', 'intake'] : ['edrms'],
              },
            },
            ...(docType ? [{term: {docType}}] : []),
          ],
        },
      };
      let res;
      try {
        res = await request('POST', `/${INDEX_ALIAS}/_search`, body);
      } catch (err) {
        throw unavailable(err.message);
      }
      if (res.status !== 200) {
        throw unavailable(
          `${res.status} ${res.body?.error?.type ?? ''}`.trim(),
        );
      }
      const {value, relation} = res.body.hits.total;
      return {
        hits: res.body.hits.hits.map(h => h._source),
        total: value,
        totalCapped: relation === 'gte',
      };
    },
  };
}

/** A 503 the screens show as it is; its cause is logged (5xx are), never sent to the browser. */
function unavailable(cause) {
  const err = new AppError(
    503,
    'Document search is not available at the moment. Try again in a few minutes.',
  );
  err.cause = `search engine: ${cause}`;
  return err;
}
