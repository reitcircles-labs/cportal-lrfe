# Scalability: the test register and the load tests (API-769)

The portal is to hold a whole country's land register. These scripts measure how today's code
copes with that: `generate.js` fills a PostgreSQL test stack with a synthetic national register,
and `load-test.js` measures the officer's operations against it and writes a report. The targets
they are measured against are in [targets.json](targets.json).

## The targets (proposed, to be agreed with the client)

The numbers are sized for Namibia, the first client, and are **proposed until the client agrees
them**. Another country sets its own: they live in `targets.json`, not in the code.

| What | Proposed | Why |
|---|---|---|
| Parcels, and land records | 500,000 | Erven in proclaimed townships, farm portions and new tenure parcels, with room to grow |
| Filed documents, historical | 3,000,000 | About 6 per parcel: SG diagram, grant or first transfer, later transfers, bonds and cancellations, supporting documents |
| Filed documents per year | 150,000 | Some 50,000 registrations a year, each with about 3 documents |
| New filings per day | 600; at peak 3,000 a day, 600 in an hour | 250 working days; month-end and backlog days 5 times the average |
| Bulk import of the historical register | 20,000 documents a day | Back-scanning 3 million documents within about a year and a half |
| Officers working at once | 150; at peak 250 | The registry, its sub-registries and records desks in each region |
| Search (Documents screen, document search on the record screen) | median 300 ms, p95 800 ms | Typing-speed feedback |
| Document details | median 100 ms, p95 300 ms | A popover |
| Suggestions, New record preview | median 500 ms, p95 1.5 s | Opened once per record or dialog |
| Record list and work lists (with their filters) | median 300 ms, p95 800 ms | A screen an officer opens many times a day |
| Newly filed document to its record's flag | median 2 s, p95 10 s, at most 60 s | "Within seconds" (API-766), also at peak |
| Matching throughput | 60 documents a minute | The peak hour (10 a minute) with room to catch up |
| Catching up after a one-hour outage | 15 minutes | |

Response times are measured at the gateway with the whole register loaded, with 8 requests in
flight at all times (each of 8 workers sends its next request as soon as the last one is answered).
150 officers at one request every 20 seconds send about 8 requests a second, so 8 in flight is at
least that load whenever a request takes a second or more, and more than it when requests are fast.

## Running them

The register goes into a PostgreSQL test stack whose database is kept between runs
(`E2E_PG_DIR`, see [e2e/README.md](../../../e2e/README.md#on-postgresql)). Pick a folder outside
the repository with room for it (about 1 GB per 150,000 documents) and free ports:

```bash
# terminal 1: the services on PostgreSQL (from e2e/)
E2E_DB=postgres E2E_PG_DIR=~/lrfe-scale-pg E2E_API_PORT=3800 E2E_WEB_PORT=4500 node stack/start-backend.mjs

# terminal 2: the register, then the load tests (from backend/)
E2E_API_PORT=3800 npm run scale:generate -- --documents 500000 --replace
E2E_API_PORT=3800 npm run scale:load -- --out ~/scale-report.md
```

`E2E_API_PORT` must be the same in both terminals: the scripts find the database and the gateway
from it, as the stack does (`SCALE_DATABASE_URL` overrides the database; `DB_CONNECTION_STRING` is
ignored on purpose: the services' code loads `backend/.env`, which names the developer's own database).

### generate.js

| Option | Default | |
|---|---|---|
| `--documents` | 50,000 | About how many documents; turned into parcels (about 5.1 documents each) |
| `--parcels` | | The number of parcels, instead of `--documents` |
| `--records` | 0.8 | The share of parcels that have a land record; the rest are parcels only documents know |
| `--seed` | 769 | The same seed and options give the same register, to the byte |
| `--as-of` | 2026-10-01 | The register as it is on that day |
| `--scan-years`, `--record-years` | 2, 1 | Documents are filed over the years before `--as-of`, records created over the last year |
| `--replace` | | Empties the documents, records and intake's documents first (and, with `E2E_STORE_DIR`, their files); without it a database holding any is refused |
| `--files` | | Also the documents' files, with their text, stored encrypted (below, API-810); needs the stack started with `E2E_STORE_DIR` |
| `--resume` | | Carries on a run that stopped, with the same options: the batches already written are skipped |

What it makes:

- **Parcels**: erven (85%) in made-up townships of 150 to 3,000 erven, some named "… Extension n",
  4% of erven subdivided into portions; farm portions (15%), farms with up to six portions and some
  farm names repeated. Each township and farm is in a registration division and a region.
- **Documents**, per parcel, in the order they were registered: the SG diagram, a deed of grant or
  a first transfer, then transfers every few years (each citing the previous deed as prior title,
  some estate transfers, some preceded by a deed of sale), bonds with half of the transfers, and
  now and then another supporting document. Property descriptions are written as deeds write them
  ("Erf 1873, Dumar", "ERF NO. 1873 DUMAR", "Portion 2 of the Farm Kanduro No. 64").
- **Land records** for 80% of the parcels, in every state the work lists show: 84% approved, 5%
  drafts, 4% with a change in review, 2% in the bin, 2% needing review (a linked document
  corrected in edrms since, which gets a version 2.0), 3% with a new document not yet in the
  record. A fifth of the approved records, and of those needing review or with a new document,
  have a second approved version.

At the target size (`--documents 3000000 --records 0.85`: 588,000 parcels, 3 million documents,
500,000 records) it took 2.4 hours on an 8-core server and made an 18 GB database; 500,000
documents take about 5 minutes and 3 GB.

Everything is built with the services' own code (catalogue, search text, record metadata, parcel
reading, suggestions, checks and seals), so the rows are what the services would have written.
People, companies, banks, townships and farms are made up from syllables: no real person's data.
Not generated, as the load tests do not use them: the intake work queue, anchorings, and the
review tasks in bpm (a generated change in review cannot be approved or withdrawn). Without
`--files`, the scanned files either: each version has a stand-in hash, so opening a generated
document's file fails.

### The documents' files (--files, API-810)

For measuring the search index, documents need their text. With `--files` every document also
gets the PDF a scan of it would be and is stored as the services store it:

- **The PDF** (`documents.js`): A4, a first page stating the document's own fields in a deed's
  words (its number, parties and their ID numbers, property, extent, dates, prior title), then 0
  to 7 pages, by type, of conditions and clauses in a deed's usual wording, and the signatures with
  the parties again. On average 4.5 pages, 11 KB, 13 KB of text. Built on worker threads
  (`pdf-worker.js`).
- **Intake**: the scan and the AI's page text (a JSON file), the document filed, its review rows
  built by intake's own code from a reading of it (each value with its line as evidence; in 3% of
  documents one value misread and corrected by the officer, as edrms then records it), the
  reading and its history (captured, read, filed), in scanning batches of 50 parcels.
- **Edrms**: the same scan as version 1.0's file (its real hash and size, the seal made again, the
  reading as provenance), the page text beside it (`document_text`); a later version keeps version
  1.0's file, as a correction of values does.
- **Encrypted twice**, as on an install: each file with a data key of its own from the stack's
  OpenBao, wrapped with intake's or edrms' key (logged in with that service's AppRole); and the
  folder they are in is the stack's encrypted directory (`E2E_STORE_DIR/files`, fscrypt).

The same seed gives the same documents and the same PDFs; only the encrypted bytes differ (new
keys). Start the stack with the store kept, then generate and check:

```bash
# terminal 1 (from e2e/)
E2E_DB=postgres E2E_PG_DIR=~/lrfe-data/scale-810/pg E2E_STORE_DIR=~/lrfe-data/scale-810 node stack/start-backend.mjs

# terminal 2 (from backend/)
E2E_STORE_DIR=~/lrfe-data/scale-810 npm run scale:generate -- --documents 500000 --files --replace
E2E_STORE_DIR=~/lrfe-data/scale-810 node scripts/scale/check-files.js --sample 500
```

**Measured (API-810, 25 October 2026, `--documents 200000 --files`):** 199,470 documents (39,216
parcels), 797,880 encrypted files: 14 GB on the disk for the files and 3.6 GB for the database.
About 50 minutes on the shared 8-core server with spinning disks, 60 to 110 documents a second
depending on the other load on it; a 500-document sample passed every check below. A run stopped
part-way (OpenBao too slow under load once) is carried on with `--resume`; data-key requests that
time out are asked again.

`check-files.js` takes a random sample: each file must be ciphertext on the disk, decrypt, open as
a PDF with the document's page count, hold every field's value as filed, and equal the page text
kept in edrms and in intake; intake's scan must be the same file; then edrms' integrity check
(file hash and seal, every version) and intake's reading for the search service must answer
for it, and the land records that pin it must hold edrms' seal. It exits 1 on any problem. After
`--resume`, the report's file counts are those of the resumed part; `onDisk` is the whole folder.

### load-test.js

Each operation runs **alone** (`--samples` requests one at a time, at most two minutes) and **under
load** (`--concurrency` requests at once for `--duration` seconds), through the gateway, as a
records officer whose token the script signs with the test stack's secret. Inputs are drawn from
the register: deed numbers, erf numbers with their township, owners' names and word starts for
search; random records and documents for the rest.

| Operation | Request |
|---|---|
| Documents screen search | `GET /api/documents?q=…&limit=100` |
| Record screen document search | `GET /api/records/document-search?q=…&limit=30` |
| Document details | `GET /api/records/document-details/:id` |
| Suggestions | `GET /api/records/:id/suggestions` |
| New record preview | `POST /api/records/preview` with a filed title deed (API-765) |
| Record list, Record list search | `GET /api/records?limit=200`, with `q` = a record number, erf number or owner |
| Work lists | `GET /api/records?status=in_review` (and `needs_review`, `new_document`, `draft`, `in_bin`) |
| New-document matching | Files new bonds into edrms as intake does (`--filings` one at a time, then a `--burst` of them), each for a parcel with an approved record, and times each from filing to the time on the flag land-records puts on that record (API-766) |

The report gives per operation the median and 95th percentile, requests per second under load,
the database's time, statements and rows read per request (from `pg_stat_statements` and
`pg_stat_database`), the costliest statement, and whether the 95th percentile under load meets
its target, and a table of the work lists' totals against the records in the database (a work
list that leaves records out misses its target however fast it is: today "in review", "needs
review" and "new document" are filtered in the service from the newest 1,000 records only). The baseline measured with
these scripts is on API-769 in Jira. `--out report.md` also writes it with the raw numbers as `report.json`. `--only <name>`
runs only the operations whose name contains it. Matching files real documents and adds flags to
their records, so the register changes a little with every run (bond numbers start from the clock,
so runs never collide): regenerate it for a clean one.
