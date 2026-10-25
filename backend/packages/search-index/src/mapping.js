/**
 * The search index (epic API-797, API-801): one entry per document from upload onward, keyed by
 * intake's document id. Searches go through the alias, so a rebuild can fill a new index and
 * switch the alias over (API-804).
 */
export const INDEX_ALIAS = 'lrfe-documents';

/** The index behind the alias, by version: `lrfe-documents-v1` (inside the roles' `lrfe-documents*`). */
export const indexName = version => `${INDEX_ALIAS}-v${version}`;

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

/**
 * The index the alias points to, null when there is no alias. During a switch (API-804) it can
 * point to two: the one written to, else the newest.
 */
async function aliasIndex(request) {
  const res = await request('GET', `/_alias/${INDEX_ALIAS}`);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`The search index cannot be read: ${res.status}`);
  }
  const names = Object.keys(res.body).sort();
  const writing = names.find(
    n => res.body[n].aliases?.[INDEX_ALIAS]?.is_write_index,
  );
  return writing ?? names.at(-1);
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
