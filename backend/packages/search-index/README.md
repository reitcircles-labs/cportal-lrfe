# @lrfe/search-index

*Document search (epic API-797): the index design (API-801). Writing into it is API-808 (the
search service), searching it API-803 (edrms), rebuilding it API-804.*

One entry per document from upload onward, keyed by intake's document id; the EDRMS number, the
corrected fields and the status `filed` are added at filing. Searches go through the alias
`lrfe-documents`, on the index `lrfe-documents-v1`, so a rebuild can fill a new version and switch
the alias over. The package has no connection of its own: `ensureIndex(request, pack)` takes the
caller's `request(method, path, body) → {status, body}`, with its login and certificate.

## The fields

| Field | Matched | Holds |
| --- | --- | --- |
| `reference`, `edrmsNo`, `refs` | whole, punctuation and case ignored ("T 2210/2008" = "t2210 / 2008") | the document's own reference, its EDRMS number, every reference on it (prior title, SG diagram, …) |
| `numbers` | whole: "880" is not every ID number starting with 880 | ID numbers; erf, farm and portion numbers |
| `names`, `places`, `title` | folded words ("Hoäeb" = "hoaeb", "!Naruseb" = "naruseb"), word starts ("Klein Wind"), the pack's spellings ("Ngishidi" = "Nghishidi"), one or two letters off | parties; the property and its township or farm |
| `text` | folded words, weighted below the fields above; named `text` in the hits, so a result can say "found in the text" | the AI's page text |
| `status`, `intakeStatus`, `docType`, `registry`, `uploadedAt`, `filedAt` | filters and display | `status` is `intake` or `filed`: shown, never used to hide |
| `access.audience`, `access.restriction`, `access.registry` | filters (API-803) | `intake` (users with intake's read permission) or `edrms` (its access restriction and registry) |
| `shown` | not searched | the values the result list shows (the corrected ones) |

For a field the officer corrected, the AI's value and the corrected one are both in these fields,
so a search for either finds the document. Every typed word must match.

## The country pack

The analysers and the reference formats come from the country's pack (`country-packs/<code>.json`,
`loadCountryPack('NA')`; the search part of API-713's country pack, Namibia first):

- `references`: the patterns of the registry references, each checked against its `examples` when
  the pack is loaded;
- `nameVariants`: the spellings that are the same name, as replacements (doubled letters,
  Oshiwambo "gh");
- `wordStartMin` (word starts from this many letters) and `variantMinLength` (words this long also
  match one or two letters off).

## Tests

`npm test -w @lrfe/search-index`. The test set (exact references and numbers, name variants, text
matches below field matches, the AI's and the corrected value, a document in intake) runs on a
throwaway container of the install's search engine image (`opensearchproject/opensearch:3.9.0`,
never pulled; about 35 seconds), or on `SEARCH_TEST_OPENSEARCH_URL` (an engine without login and without an `lrfe-documents` index:
the test refuses one that has it). It
is skipped when neither is there.
