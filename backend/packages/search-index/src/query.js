/**
 * @fileoverview The search of the index for what a user typed (API-801; filters and paging are API-803's). Every
 * word must match somewhere (as edrms' search today):
 *   - a registry reference (the pack's formats) or a word with digits matches whole, never as a
 *     start or a near spelling: "880" is not every ID number starting with 880;
 *   - another word matches a name, place or title whole, by its start, by the pack's spellings or
 *     one or two letters off; or the page text, weighted below, and named "text" so a result can
 *     say "found in the text".
 */
const BOOST = {own: 10, word: 3, start: 2, variant: 1.5, near: 1, text: 0.2};
const WORD_FIELDS = ['names', 'places', 'title'];

/** A reference or number as the index's normaliser keeps it: letters and digits, folded. */
export function exactForm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The query's parts: references in the pack's formats, other words with digits (numbers, EDRMS
 * numbers) and plain words, folded.
 */
export function queryParts(q, pack) {
  let rest = String(q ?? '').normalize('NFC');
  const exact = [];
  for (const ref of pack.search.references) {
    rest = rest.replace(new RegExp(ref.pattern, 'giu'), match => {
      exact.push(exactForm(match));
      return ' ';
    });
  }
  const words = [];
  for (const chunk of rest.split(/[\s,;]+/).filter(Boolean)) {
    if (/\p{N}/u.test(chunk)) {
      exact.push(exactForm(chunk));
    } else {
      words.push(...foldedWords(chunk));
    }
  }
  return {exact: exact.filter(Boolean), words};
}

/** A chunk's words, folded; an apostrophe inside a word is kept, as the index does ("O'Brien"). */
function foldedWords(chunk) {
  return chunk
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .map(w => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** One reference or number: equal to one on the document. */
function exactClause(value) {
  return {
    bool: {
      should: [
        {term: {refs: value}},
        {term: {numbers: value}},
        {term: {edrmsNo: value}},
        {term: {reference: value}},
      ],
      minimum_should_match: 1,
      _name: 'field',
    },
  };
}

/** One word: its best match over the checked fields, or the page text below them. */
function wordClause(word, pack) {
  const fields = [];
  for (const f of WORD_FIELDS) {
    fields.push({match: {[f]: {query: word, boost: BOOST.word}}});
    if (word.length >= pack.search.wordStartMin) {
      fields.push({match: {[`${f}.start`]: {query: word, boost: BOOST.start}}});
    }
    if (word.length >= pack.search.variantMinLength) {
      fields.push({
        match: {[`${f}.variant`]: {query: word, boost: BOOST.variant}},
      });
      fields.push({
        fuzzy: {
          [f]: {
            value: word,
            fuzziness: 'AUTO',
            prefix_length: 1,
            boost: BOOST.near,
          },
        },
      });
    }
  }
  return {
    dis_max: {
      queries: [
        {dis_max: {queries: fields, _name: 'field'}},
        {match: {text: {query: word, boost: BOOST.text, _name: 'text'}}},
      ],
    },
  };
}

/**
 * The search body for what was typed; null when nothing can be searched. A document whose own
 * reference or EDRMS number was typed ranks first.
 */
export function buildSearchQuery(q, pack, {size = 20, from = 0} = {}) {
  const {exact, words} = queryParts(q, pack);
  if (exact.length === 0 && words.length === 0) return null;
  return {
    size,
    from,
    track_total_hits: true,
    query: {
      bool: {
        must: [
          ...exact.map(exactClause),
          ...words.map(word => wordClause(word, pack)),
        ],
        should: exact.flatMap(value => [
          {term: {reference: {value, boost: BOOST.own}}},
          {term: {edrmsNo: {value, boost: BOOST.own}}},
        ]),
      },
    },
  };
}
