/**
 * The re-index command.
 *
 * "Re-index since <date>" (API-808): indexes again every document intake or edrms changed at or
 * after the date, or all of them without one; used after a restore of the index (API-806) and
 * for documents from before the search service:
 *   docker compose exec search node src/reindex.js --since 2026-10-01T00:00:00Z
 * Prints the counts; documents that cannot be fetched or written stop it with an error, and it
 * can simply be run again.
 *
 * "Rebuild" (API-804): fills a new index from intake and edrms while search keeps using the old
 * one, then switches over and removes the old one (after a change of the index design or the
 * country pack's analysers). Progress is shown every 10 seconds; Ctrl-C stops it after the page
 * under way, and running it again resumes:
 *   docker compose exec search node src/reindex.js --rebuild
 */
import {parseArgs} from 'node:util';
import {createEventBus} from '@lrfe/common';
import {rebuildIndex} from './rebuild.js';
import {createSearchService, prepareIndex} from './setup.js';

const {values} = parseArgs({
  options: {since: {type: 'string'}, rebuild: {type: 'boolean'}},
});
if (values.since && Number.isNaN(Date.parse(values.since))) {
  console.error(`--since ${values.since} is not a date`);
  process.exit(2);
}
if (values.since && values.rebuild) {
  console.error('--rebuild takes every document: leave out --since');
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

if (values.rebuild) {
  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error('Stopping after the page under way; run it again to resume.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const began = Date.now();
  const firstDone = {value: null};
  let shownAt = 0;
  let shownStep = null;
  const result = await rebuildIndex(service, {
    stop: () => stopping,
    progress: state => {
      const stepChanged = state.step !== shownStep;
      if (!stepChanged && Date.now() - shownAt < 10_000) return;
      shownStep = state.step;
      shownAt = Date.now();
      console.error(describe(state, began, firstDone));
    },
  });
  const minutes = Math.round((Date.now() - began) / 6000) / 10;
  console.log(JSON.stringify({...result, minutes}));
} else {
  const results = await service.reindex({since: values.since ?? null});
  console.log(JSON.stringify({since: values.since ?? 'all', ...results}));
}
// the engine's connection is kept open for reuse: end here
process.exit(0);

/** One line of progress: the step, how many of how many, the rate and the time left. */
function describe(state, began, firstDone) {
  if (state.step !== 'fill') return `${state.index}: ${state.step}`;
  // the rate of this run (a resumed run starts from what was done before)
  firstDone.value ??= state.done;
  const seconds = (Date.now() - began) / 1000;
  const rate = seconds > 0 ? (state.done - firstDone.value) / seconds : 0;
  const left =
    rate > 0 ? Math.ceil((state.total - state.done) / rate / 60) : null;
  const percent = state.total
    ? Math.floor((state.done / state.total) * 100)
    : 100;
  const n = x => x.toLocaleString('en');
  return (
    `${state.index}: fill, ${n(state.done)} of ${n(state.total)} documents (${percent}%), ` +
    `${n(Math.round(rate))} a second` +
    (left === null ? '' : `, about ${left} minutes left`)
  );
}
