# search service

*Document search (epic API-797): the connection to intake and edrms (API-802). Writing into the
index is API-808; searching, API-803 and API-804.*

A document is searchable as soon as the AI has read it, and the officer's corrections are added
when it is filed. The search service follows the events that change what the index holds and
fetches each document from where it is, with its own service token. Port 3508, no database, no
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

- **Catch-up.** A consumer resumes where it stopped, so documents read, rejected, filed or
  corrected while the service was down are fetched once it is back, as long as the stream still
  has them (`EVENT_STREAM_MAX_AGE_DAYS`, 30 by default). A consumer made for the first time starts
  with the events published from then on: documents from before are indexed by the re-index
  (API-808).
- **Failures.** A document that is no longer there is counted (`missing`) and the event
  acknowledged. When intake or edrms cannot answer, the event is delivered again after 5 seconds.
- **No content in the log.** Until API-808 what was fetched is only counted and logged: the
  document's id, its status or EDRMS number, its type, how many fields and pages, its access
  restriction. Never a field's value or the page text.

## Health

`GET /health` as every service. `GET /health/events`, for the readiness check
(`demo/check-readiness.mjs`):

```json
{ "lag": 0, "consumers": [{ "event": "intake.document.extracted", "durable": "search-intake-extracted",
  "received": 12, "fetched": 12, "missing": 0, "failed": 0, "lastHandledAt": "…", "pending": 0, "unacked": 0 }] }
```

The counts are since the service started. `pending` (not given to the service yet) and `unacked`
(being handled) come from the event stream; `lag` is their total, null when the event bus cannot
say (not connected, or a driver other than `nats`).

## Settings

`JWT_SECRET` (its service token), `EVENT_BUS_DRIVER=nats` and `NATS_URL`, `INTAKE_URL` (default
`http://localhost:3504`), `EDRMS_URL` (default `http://localhost:3502`), `PORT` (default 3508).

## Tests

`npm test -w @lrfe/search`: the four events with a real intake and edrms in-process, the clients,
the health. The catch-up and the lag on a real NATS: `backend/packages/common/tests/outbox.test.js`.
In the containers: `e2e/tests/search-connection.spec.ts` (`npm run test:docker`).
