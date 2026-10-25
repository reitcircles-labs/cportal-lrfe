/**
 * The search index (epic API-797, API-801): one entry per document from upload onward, keyed by
 * intake's document id. Searches go through the alias, so a rebuild can fill a new index and
 * switch the alias over (API-804).
 */
export const INDEX_ALIAS = 'lrfe-documents';

/** The index behind the alias, by version: `lrfe-documents-v1` (inside the roles' `lrfe-documents*`). */
export const indexName = version => `${INDEX_ALIAS}-v${version}`;

/**
 * The documents that keep failing to be indexed (API-808), one entry per document: no content,
 * only what failed and when; shown by the readiness check, cleared when the document is indexed.
 */
export const DEAD_LETTER_INDEX = `${INDEX_ALIAS}-failed`;

/** A rebuild's progress (API-804): one entry while a rebuild is under way, never searched. */
export const REBUILD_INDEX = `${INDEX_ALIAS}-rebuild`;

const DEAD_LETTER_BODY = {
  settings: {number_of_shards: 1, number_of_replicas: 0},
  mappings: {
    dynamic: 'strict',
    properties: {
      documentId: {type: 'keyword'},
      event: {type: 'keyword'},
      attempts: {type: 'integer'},
      error: {type: 'keyword', index: false},
      at: {type: 'date'},
    },
  },
};

/** A field matched whole, punctuation and case ignored: "T 2210/2008" = "t2210 / 2008" = "T2210/2008". */
const EXACT = {type: 'keyword', normalizer: 'lrfe_reference'};
const KEYWORD = {type: 'keyword'};
/** A name or place: folded words, with their word starts and their spelling variants. */
const WORDS = {
  type: 'text',
  analyzer: 'lrfe_folded',
  fields: {
    start: {
      type: 'text',
      analyzer: 'lrfe_word_start',
      search_analyzer: 'lrfe_folded',
    },
    variant: {type: 'text', analyzer: 'lrfe_variant'},
  },
};

/**
 * What an entry holds. References, numbers, names and places hold the AI's value and, for a field
 * the officer corrected, the corrected one too, so a search for either finds the document; what is
 * shown is in `shown`, which is stored but not searched.
 */
export const MAPPINGS = {
  dynamic: 'strict',
  properties: {
    // intake's document id (also the entry's id)
    documentId: KEYWORD,
    // "intake" or "filed": shown on the result, never used to hide it
    status: KEYWORD,
    // intake's own status (ready, rejected, filed, …)
    intakeStatus: KEYWORD,
    // once filed: the EDRMS document and its number
    edrmsId: KEYWORD,
    edrmsNo: EXACT,
    // the document's own reference (deed, SG or bond number): an exact match ranks it first
    reference: EXACT,
    docType: KEYWORD,
    registry: KEYWORD,
    uploadedAt: {type: 'date'},
    filedAt: {type: 'date'},
    // what a search is filtered on (API-803): who may see the entry
    access: {
      properties: {
        // "intake" (users with intake's read permission) or "edrms" (edrms' rules)
        audience: KEYWORD,
        // edrms' access restriction once filed: public, restricted or confidential
        restriction: KEYWORD,
        registry: KEYWORD,
      },
    },
    // every reference on the document: its own and the ones it cites (prior title, SG diagram, …)
    refs: EXACT,
    // ID numbers and the erf, farm and portion numbers
    numbers: EXACT,
    names: WORDS,
    places: WORDS,
    title: WORDS,
    // the AI's page text: its own field, weighted below the checked fields
    text: {type: 'text', analyzer: 'lrfe_folded'},
    // what the result list shows (the corrected values)
    shown: {type: 'object', enabled: false},
  },
};

/**
 * The analysers, from the country pack's search part (`country-pack.js`).
 * @param {{search: {wordStartMin: number, nameVariants: {pattern: string, replacement: string}[]}}} pack
 */
export function analysis(pack) {
  const variants = Object.fromEntries(
    pack.search.nameVariants.map((v, i) => [
      `lrfe_variant_${i + 1}`,
      {type: 'pattern_replace', pattern: v.pattern, replacement: v.replacement},
    ]),
  );
  return {
    char_filter: {
      lrfe_no_punctuation: {
        type: 'pattern_replace',
        pattern: '[^\\p{L}\\p{N}]+',
        replacement: '',
      },
    },
    normalizer: {
      lrfe_reference: {
        type: 'custom',
        char_filter: ['lrfe_no_punctuation'],
        filter: ['lowercase', 'asciifolding'],
      },
    },
    filter: {
      lrfe_word_start: {
        type: 'edge_ngram',
        min_gram: pack.search.wordStartMin,
        max_gram: 20,
        preserve_original: true,
      },
      ...variants,
    },
    analyzer: {
      // "Hoäeb" → hoaeb, "!Naruseb" → naruseb
      lrfe_folded: {
        type: 'custom',
        tokenizer: 'standard',
        filter: ['lowercase', 'asciifolding'],
      },
      // "Windhoek" → win, wind, windh, …: "Klein Wind" finds "Klein Windhoek"
      lrfe_word_start: {
        type: 'custom',
        tokenizer: 'standard',
        filter: ['lowercase', 'asciifolding', 'lrfe_word_start'],
      },
      // the pack's spellings of the same name: "Ngishidi" and "Nghishidi" → ngishidi
      lrfe_variant: {
        type: 'custom',
        tokenizer: 'standard',
        filter: ['lowercase', 'asciifolding', ...Object.keys(variants)],
      },
    },
  };
}

/** The body that creates an index: its analysers from the pack, its fields, its alias. */
export function indexBody(pack, {shards = 1, replicas = 0, alias = true} = {}) {
  return {
    settings: {
      number_of_shards: shards,
      number_of_replicas: replicas,
      analysis: analysis(pack),
    },
    mappings: MAPPINGS,
    ...(alias ? {aliases: {[INDEX_ALIAS]: {}}} : {}),
  };
}

/** Creates the dead-letter index unless it exists (another service creating it at once is fine). */
export async function ensureDeadLetterIndex(request, {replicas = 0} = {}) {
  const there = await request('HEAD', `/${DEAD_LETTER_INDEX}`);
  if (there.status === 200) return;
  const body = {
    ...DEAD_LETTER_BODY,
    settings: {...DEAD_LETTER_BODY.settings, number_of_replicas: replicas},
  };
  const created = await request('PUT', `/${DEAD_LETTER_INDEX}`, body);
  if (
    created.status >= 300 &&
    created.body?.error?.type !== 'resource_already_exists_exception'
  ) {
    throw new Error(
      `The dead-letter index cannot be created: ${created.status}`,
    );
  }
}

/**
 * The index the alias points to, null when there is no alias. During a switch (API-804) it can
 * point to two: the one written to, else the newest.
 */
export async function aliasIndex(request) {
  // asked among the indexes the service's role covers (lrfe-documents*): a bare /_alias/… is
  // a question about every index, which the role does not allow
  const res = await request(
    'GET',
    `/${INDEX_ALIAS}-*/_alias/${INDEX_ALIAS}?allow_no_indices=true&ignore_unavailable=true`,
  );
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`The search index cannot be read: ${res.status}`);
  }
  const names = Object.keys(res.body ?? {})
    .filter(n => res.body[n].aliases?.[INDEX_ALIAS])
    .sort();
  if (names.length === 0) return null;
  const writing = names.find(
    n => res.body[n].aliases?.[INDEX_ALIAS]?.is_write_index,
  );
  return writing ?? names.at(-1);
}

/** The versions of the indexes there are (`lrfe-documents-v1` → 1), lowest first. */
export async function indexVersions(request) {
  const res = await request(
    'GET',
    `/${INDEX_ALIAS}-v*/_alias?allow_no_indices=true&ignore_unavailable=true`,
  );
  if (res.status === 404) return [];
  if (res.status !== 200) {
    throw new Error(`The search indexes cannot be listed: ${res.status}`);
  }
  return Object.keys(res.body ?? {})
    .map(n => n.match(new RegExp(`^${INDEX_ALIAS}-v(\\d+)$`))?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Creates the index of this version with the alias on it, unless the alias already exists; returns
 * the index the alias points to. `request(method, path, body)` → `{status, body}` is the caller's
 * connection to the search engine (its login and certificate are the caller's).
 */
export async function ensureIndex(
  request,
  pack,
  {version = 1, ...options} = {},
) {
  const existing = await aliasIndex(request);
  if (existing) return existing;
  const name = indexName(version);
  const created = await request('PUT', `/${name}`, indexBody(pack, options));
  // another service created it at the same moment: theirs is used
  if (created.body?.error?.type === 'resource_already_exists_exception') {
    return (await aliasIndex(request)) ?? name;
  }
  if (created.status >= 300) {
    throw new Error(
      `The search index ${name} cannot be created: ${created.status} ${JSON.stringify(created.body?.error?.reason ?? created.body)}`,
    );
  }
  return name;
}
