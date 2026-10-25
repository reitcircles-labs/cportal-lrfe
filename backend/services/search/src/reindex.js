/**
 * "Re-index since <date>" (API-808): indexes again every document intake or edrms changed at or
 * after the date, or all of them without one; used after a restore of the index (API-806) and
 * for documents from before the search service. In the install:
 *   docker compose exec search node src/reindex.js --since 2026-10-01T00:00:00Z
 * Prints the counts; documents that cannot be fetched or written stop it with an error, and it
 * can simply be run again.
 */
import {parseArgs} from 'node:util';
import {createEventBus} from '@lrfe/common';
import {createSearchService, prepareIndex} from './setup.js';

const {values} = parseArgs({options: {since: {type: 'string'}}});
if (values.since && Number.isNaN(Date.parse(values.since))) {
  console.error(`--since ${values.since} is not a date`);
  process.exit(2);
}
const service = createSearchService({
  events: createEventBus({driver: 'log', source: 'search'}),
});
if (!service.engine) {
  console.error('OPENSEARCH_URL is not set: there is no index to fill');
  process.exit(2);
}
await prepareIndex(service, console, {tries: 1});
const results = await service.reindex({since: values.since ?? null});
console.log(JSON.stringify({since: values.since ?? 'all', ...results}));
// the engine's connection is kept open for reuse: end here
process.exit(0);
