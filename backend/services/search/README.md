# search service

*Document search (epic API-797): the connection to intake and edrms (API-802) and the writing of
the index (API-808, the index itself: `packages/search-index`, API-801). Searching is API-803,
rebuilding API-804.*

A document is searchable as soon as the AI has read it, and the officer's corrections are added
when it is filed. The search service follows the events that change what the index holds,
fetches each document from where it is, with its own service token, and writes its entry. Port 3508, no database, no
route through the gateway: it is reached on the internal networks only (in the compose file, profile
`search`, on the network `search` with the search engine).

## The events

Each event has its own durable consumer on the event stream (`LRFE`, `backend/packages/common/src/events.js`):

| Event | Durable consumer | Fetched from |
| --- | --- | --- |
| `intake.document.extracted`, also a new AI reading of the same document | `search-intake-extracted` | intake `GET /documents/:id/reading`: the fields and the page text (API-798) |
| `intake.document.rejected`, a reviewer rejected the upload | `search-intake-rejected` | intake, the same reading (status `rejected`) |
| `edrms.document.filed` | `search-edrms-filed` | edrms `GET /documents/:id`: the corrected fields, the EDRMS number, `recordMetadata.accessRestriction` |
| `edrms.document.amended`, an approved correction | `search-edrms-amended` | edrms, the same |

Intake's reading route takes the search service's token only, never a browser's. Edrms gives the
filed document to the services in its `READ_SERVICES`, `search` among them.

Once a document is filed, intake clears its copy (API-807): its reading then says `cleared`, with
no fields or page text, and the search service reads the page text and the AI's values from edrms
`GET /documents/:id/reading` (the search service's token only), so the entry stays the same.

- **Catch-up.** A consumer resumes where it stopped, so documents read, rejected, filed or
  corrected while the service was down are fetched once it is back, as long as the stream still
  has them (`EVENT_STREAM_MAX_AGE_DAYS`, 30 by default). A consumer made for the first time starts
  with the events published from then on: documents from before are indexed by the re-index
  (API-808).
- **Failures.** A document that is no longer there is counted (`missing`) and the event
  acknowledged. When intake or edrms cannot answer, the event is delivered again after 5 seconds.
- **No content in the log.** Only the document's id, its status or EDRMS number, its type, how
  many fields and pages, its access restriction and what was done (`indexed`, `removed`, `stale`,
  `skipped` for an upload the AI has not read).
  Never a field's value or the page text.

## The index

One entry per document, keyed by intake's document id (`src/entry.js`), built from both sides as
they are now on every event: intake's reading (the AI's values, the AI's value of a field the
officer changed, the page text) and, once filed, the EDRMS document (the corrected and later
amended values, the AI's values carried with them, its number, its access restriction). Each
field's role (reference, number, name, place) comes from intake's catalogue (`searchRole`).

- **Same event twice:** the same entry. **An older state never replaces a newer one:** an entry
  is written with the time of the last change on either side as its version, and the index keeps
  the newer (`stale` when it already had it).
- **Rejected:** the entry is removed (also when a reading's event comes after the rejection).
- **Retries:** a failed event is delivered again after 5 s, 10 s, 20 s, … at most 5 minutes apart;
  after 8 failures the document goes to the dead-letter list (`lrfe-documents-failed`: its id,
  the event, the error, when), shown at `/health/events` and by the readiness check, and leaves
  it once indexed again.
- **Re-index since a date:** `node src/reindex.js --since <date>` (all without it) fetches every
  document intake or edrms changed since then (their `GET /documents/changed`, search service
  only, a page at a time after a cursor) and writes its entries in bulk.
- **Rebuild (API-804):** `node src/reindex.js --rebuild` fills a new index (`lrfe-documents-v<n+1>`)
  from both sources while search uses the old one, catches up on what changed meanwhile, moves
  the alias in one step and removes the old index (`src/rebuild.js`). Its progress is kept in
  `lrfe-documents-rebuild` after each page: stopped (Ctrl-C) or failed, it resumes when run again.
  Measured (API-804) on the test register of API-810, 199,470 documents with their text (398,940
  entries: intake's and edrms'): 86 minutes, 77 entries a second, on a shared server with spinning
  disks; 3 GB of index. A search every 2 s answered throughout (also at the switch), except one
  that took over 10 s while the disks were busy filling.
- **Without a search engine** (`OPENSEARCH_URL` not set: development, an install without the
  profile) documents are only fetched and logged, as before API-808.

## Health

`GET /health` as every service. `GET /health/events`, for the readiness check
(`demo/check-readiness.mjs`):

```json
{ "lag": 0, "consumers": [{ "event": "intake.document.extracted", "durable": "search-intake-extracted",
  "received": 12, "fetched": 12, "indexed": 12, "removed": 0, "stale": 0, "missing": 0, "failed": 0,
  "deadLettered": 0, "lastHandledAt": "…", "pending": 0, "unacked": 0 }],
  "deadLetters": { "total": 0, "items": [] } }
```

The counts are since the service started. `pending` (not given to the service yet) and `unacked`
(being handled) come from the event stream; `lag` is their total, null when the event bus cannot
say (not connected, or a driver other than `nats`).

## Settings

`JWT_SECRET` (its service token), `EVENT_BUS_DRIVER=nats` and `NATS_URL`, `INTAKE_URL` (default
`http://localhost:3504`), `EDRMS_URL` (default `http://localhost:3502`), `PORT` (default 3508);
`OPENSEARCH_URL` and `OPENSEARCH_LOGIN_DIR` (its login: `user`, `password`, `ca.pem`), and
`SEARCH_COUNTRY_CODE` (the country pack, default `NA`).

## Tests

`npm test -w @lrfe/search`: the four events with a real intake and edrms in-process, the clients,
the health, and the writing on a real search engine (a throwaway container, as
`packages/search-index`). The catch-up and the lag on a real NATS: `backend/packages/common/tests/outbox.test.js`.
In the containers: `e2e/tests/search-connection.spec.ts`
(`npm run test:docker`, with a throwaway search engine).
