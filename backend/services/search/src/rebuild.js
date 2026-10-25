import {
  INDEX_ALIAS,
  REBUILD_INDEX,
  aliasIndex,
  indexBody,
  indexName,
  indexVersions,
} from '@lrfe/search-index';

/** Where a rebuild keeps its progress, so that it can be stopped and run again. */
const STATE = `/${REBUILD_INDEX}/_doc/current`;

/**
 * How far back the catch-ups start before the moment they cover: a change saved just before that
 * moment can reach the database a little later, and the services' clocks can differ a little.
 */
const MARGIN_MS = 5 * 60_000;

/**
 * The steps of a rebuild and the one after each. Search uses the old index (through the alias)
 * until `switch`.
 *   fill       every document of intake and edrms into the new index
 *   catch-up   the documents changed since the fill began (written to the old index meanwhile)
 *   switch     the alias moves to the new index, in one step
 *   after      the documents changed since the catch-up began, now in the new index too
 *   remove     the old index is removed
 */
const NEXT = {
  fill: 'catch-up',
  'catch-up': 'switch',
  switch: 'after',
  after: 'remove',
  remove: 'done',
};

/**
 * Rebuilds the search index without a search outage (API-804): fills a new index from intake and
 * edrms, catches up on what changed meanwhile, switches the alias over and removes the old index.
 * Progress is saved after each page: when stopped (`stop()` true, or the process ended), running
 * it again resumes where it was. Returns `{ index, previous, done, total, results, stopped }`
 * (`done`: the documents filled; `results`: the counts of every step, catch-ups included).
 *
 * `progress(state)` is called after each page and each step, with `{ step, index, done, total,
 * startedAt }` (`total`: the documents to fill, counted at the start), and awaited. `pageSize`:
 * documents per page (tests).
 * @param {import('./search.service.js').SearchService} service
 */
export async function rebuildIndex(
  service,
  {
    progress = () => {},
    stop = () => false,
    clock = () => new Date(),
    pageSize = undefined,
  } = {},
) {
  const engine = service.engine;
  if (!engine) throw new Error('There is no search engine to rebuild');
  const before = ms => new Date(clock().getTime() - ms).toISOString();

  let state = await readState(engine);
  if (!state) {
    state = await begin(service, before(MARGIN_MS), clock);
  } else if (state.step !== 'remove') {
    // writes into a missing index would create one without the index's design
    const there = await engine('HEAD', `/${state.index}`);
    if (there.status !== 200) {
      throw new Error(
        `The rebuild's index ${state.index} is not there any more: remove ${REBUILD_INDEX} to start again`,
      );
    }
  }
  const save = () => call(engine, 'PUT', STATE, state, 'save the progress');

  while (state.step !== 'done') {
    if (['fill', 'catch-up', 'after'].includes(state.step)) {
      const results = await service.reindex({
        // fill: everything; catch-up and after: what changed since the step before began
        since: state.step === 'fill' ? null : state.since,
        index: state.index,
        start: state.position,
        stop,
        pageSize,
        onPage: async page => {
          state.position = page.position;
          if (state.step === 'fill') state.done += page.done;
          for (const [k, v] of Object.entries(page.results)) {
            state.results[k] = (state.results[k] ?? 0) + v;
          }
          await save();
          await progress(state);
        },
      });
      if (results.stopped) return report(state, true);
      state.position = null;
      if (state.step === 'fill') {
        // the catch-up begins now: the step after it covers what changes from here on
        state.nextSince = before(MARGIN_MS);
      } else if (state.step === 'catch-up') {
        state.since = state.nextSince;
      }
    } else if (state.step === 'switch') {
      await switchAlias(engine, state);
    } else if (state.step === 'remove' && state.previous) {
      const res = await engine('DELETE', `/${state.previous}`);
      if (res.status >= 300 && res.status !== 404) {
        throw engineError('remove the old index', res);
      }
    }
    state.step = NEXT[state.step];
    await save();
    await progress(state);
  }
  await engine('DELETE', STATE);
  return report(state, false);
}

/** The rebuild under way, or null. */
export async function readState(engine) {
  const res = await engine('GET', STATE);
  if (res.status === 404) return null;
  if (res.status !== 200) throw engineError('read the progress', res);
  return res.body.found ? res.body._source : null;
}

/** Starts a rebuild: the new index (the next version, not searched yet) and its progress. */
async function begin(service, startedAt, clock) {
  const engine = service.engine;
  await ensureStateIndex(engine);
  const previous = await aliasIndex(engine);
  const versions = await indexVersions(engine);
  const index = indexName((versions.at(-1) ?? 0) + 1);
  const body = indexBody(service.pack, {alias: false});
  // filled faster without making each page searchable; turned back on at the switch
  body.settings.refresh_interval = '-1';
  await call(engine, 'PUT', `/${index}`, body, `create ${index}`);
  const state = {
    step: 'fill',
    index,
    previous,
    startedAt: clock().toISOString(),
    // the catch-up covers what changed from (a little before) the fill began
    since: startedAt,
    nextSince: null,
    position: null,
    done: 0,
    total: await service.countChanged(),
    results: {},
  };
  // created only if no other rebuild began at the same moment
  const res = await engine('PUT', `${STATE}?op_type=create`, state);
  if (res.status === 409) {
    await engine('DELETE', `/${index}`);
    throw new Error(
      'Another rebuild has just begun; run it again to follow it',
    );
  }
  if (res.status >= 300) throw engineError('save the progress', res);
  return state;
}

/** The progress index: one entry, never searched. */
async function ensureStateIndex(engine) {
  const res = await engine('PUT', `/${REBUILD_INDEX}`, {
    settings: {number_of_shards: 1, number_of_replicas: 0},
    mappings: {dynamic: false, properties: {}},
  });
  if (
    res.status >= 300 &&
    res.body?.error?.type !== 'resource_already_exists_exception'
  ) {
    throw engineError(`create ${REBUILD_INDEX}`, res);
  }
}

/**
 * Makes the new index searchable and moves the alias to it in one request: a search is answered
 * by the old index or by the new one, never by none. Run again after a stop, it changes nothing.
 */
async function switchAlias(engine, state) {
  await call(
    engine,
    'PUT',
    `/${state.index}/_settings`,
    {index: {refresh_interval: null}},
    'make the new index searchable',
  );
  await call(engine, 'POST', `/${state.index}/_refresh`, undefined, 'refresh');
  const current = await aliasIndex(engine);
  if (current === state.index) return;
  const actions = [
    ...(current ? [{remove: {index: current, alias: INDEX_ALIAS}}] : []),
    {add: {index: state.index, alias: INDEX_ALIAS}},
  ];
  await call(engine, 'POST', '/_aliases', {actions}, 'switch the alias');
}

async function call(engine, method, path, body, what) {
  const res = await engine(method, path, body);
  if (res.status >= 300) throw engineError(what, res);
  return res;
}

function engineError(what, res) {
  return new Error(
    `The search engine could not ${what}: ${res.status} ${res.body?.error?.type ?? ''}`.trim(),
  );
}

function report(state, stopped) {
  return {
    index: state.index,
    previous: state.previous,
    done: state.done,
    total: state.total,
    results: state.results,
    stopped,
  };
}
