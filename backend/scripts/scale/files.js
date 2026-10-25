/**
 * The files of the test register (API-810, generate.js --files): every filed document gets the PDF
 * a scan of it would be, with its text (documents.js), and is stored as the services store it, so
 * that opening, checking and searching it work as on an install:
 *
 *   intake  the scan, and the AI's page text (a JSON file), with the document's review row (the
 *           fields read, as accepted or corrected by the officer), its reading and its history
 *   edrms   the same scan as the version's file (its real hash, size and seal), and the page text
 *           beside it (document_text)
 *
 * Each file is encrypted as the services encrypt it (packages/storage, README.md section 6): a data
 * key of its own from the stack's OpenBao, wrapped with intake's or edrms' key, logged in with that
 * service's AppRole. The stores are folders in the stack's encrypted directory (E2E_STORE_DIR/files).
 */
import {readFileSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {Readable} from 'node:stream';
import {Worker} from 'node:worker_threads';
import {join} from 'node:path';
import {
  createBaoKeyring,
  createEncryptingStore,
  createLocalStore,
  storageKey,
} from '@lrfe/storage';
import {sealOf} from '../../services/edrms/src/seal.js';
import {normalize} from '../../services/intake/src/extraction/normalize.js';
import {
  buildRows,
  flagOf,
} from '../../services/intake/src/extraction/pipeline.js';
import {PROMPT_VERSION} from '../../services/intake/src/extraction/prompt.js';
import {pagesOf} from './documents.js';
import {createRandom} from './random.js';

const HOUR_MS = 3_600_000;
/** The share of documents in which the officer corrected one value the AI misread. */
const CORRECTED = 0.03;
/** Files stored at once. */
const CONCURRENCY = 48;
/** The reading's model, as the extraction row names it: the register's own, not a real AI. */
const READER = {provider: 'test-register', model: 'generated'};

/** Builds PDFs on worker threads; `build(job)` gives the PDF as a Buffer. */
class PdfPool {
  constructor(size) {
    this.workers = Array.from(
      {length: size},
      () => new Worker(new URL('./pdf-worker.js', import.meta.url)),
    );
    this.waiting = new Map();
    this.next = 0;
    this.id = 0;
    for (const w of this.workers) {
      w.on('message', ({id, pdf, error}) => {
        const {resolve, reject} = this.waiting.get(id);
        this.waiting.delete(id);
        if (error) {
          reject(new Error(error));
        } else {
          resolve(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
        }
      });
    }
  }

  /** The PDF of `{ pages, title, at, scan }` (documents.js pdfOf), from the next worker. */
  build(job) {
    const id = ++this.id;
    const worker = this.workers[this.next++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.waiting.set(id, {resolve, reject});
      worker.postMessage({id, ...job, at: job.at.toISOString()});
    });
  }

  async close() {
    await Promise.all(this.workers.map(w => w.terminate()));
  }
}

/** Runs `fn` on every item, at most `limit` at once. */
async function eachLimit(items, limit, fn) {
  let at = 0;
  const run = async () => {
    while (at < items.length) await fn(items[at++]);
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
}

/** A value as the AI might have misread it: two neighbouring characters swapped. */
function misread(random, value) {
  const at = random.int(0, value.length - 2);
  return value.slice(0, at) + value[at + 1] + value[at] + value.slice(at + 2);
}

/** An encrypting store over a folder, with the service's own key and login. */
function serviceStore({filesDir, baoAddr, baoDir}, service, keyName) {
  const keyring = createBaoKeyring({
    addr: baoAddr,
    roleId: readRoleId(baoDir, service),
    secretIdFile: join(baoDir, 'approle', `${service}-secret-id`),
    keyName,
  });
  return createEncryptingStore(
    createLocalStore({root: join(filesDir, service)}),
    keyring,
  );
}

/** The service's AppRole id, written by the stack once its OpenBao is ready. */
function readRoleId(baoDir, service) {
  return readFileSync(
    join(baoDir, 'approle', `${service}-role-id`),
    'utf8',
  ).trim();
}

/**
 * The register's file writer. `add(entries)` takes the documents of a batch of parcels (as
 * RegisterBuilder gives them, in filing order), stores their files, completes their edrms rows
 * (version file, hash, size, seal, pages, provenance, batch) and returns the rows to insert:
 * `{ intakeBatches, intakeDocuments, intakeExtractions, intakeEvents, edrmsTexts }`.
 * `totals()`: files and bytes written so far.
 */
export function createFileWriter({
  seed,
  profile,
  filesDir,
  baoAddr,
  baoDir,
  workers = Math.max(1, Math.min(8, availableParallelism() - 2)),
}) {
  const random = createRandom(seed + 2);
  const stores = {
    intake: serviceStore({filesDir, baoAddr, baoDir}, 'intake', 'intake-files'),
    edrms: serviceStore({filesDir, baoAddr, baoDir}, 'edrms', 'edrms-files'),
  };
  const pool = new PdfPool(workers);
  const batches = new Map();
  const counts = {files: 0, plainBytes: 0, storedBytes: 0, corrected: 0};

  const put = async (store, key, body, contentType) => {
    let res;
    for (let attempt = 1; !res; attempt++) {
      try {
        res = await store.put({
          key,
          body: Readable.from([body]),
          contentType,
        });
      } catch (err) {
        if (attempt === 5 || !['EEXIST', 'EUNAVAILABLE'].includes(err.code)) {
          throw err;
        } else if (err.code === 'EEXIST') {
          // left by a run that stopped in this batch (--resume): written again
          await store.delete(key);
        } else {
          // OpenBao slow under load: wait and ask again
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }
    counts.files += 1;
    counts.plainBytes += res.size;
    counts.storedBytes += res.encryption?.cipherSize ?? res.size;
    return res;
  };

  /** What is decided for a document before its files are written (in order: the seed's sequence). */
  function plan(entry, out) {
    // the scan shows the values as first filed (version 1.0), not a later correction's
    const first = entry.versions[0];
    const document = {
      ...entry.document,
      fields: first.fields,
      props: Object.fromEntries(first.fields.map(f => [f.k, f.v])),
    };
    const {pages, evidence} = pagesOf(random, document, profile);
    const capturedAt = new Date(
      document.filedAt.getTime() - random.int(2, 96) * HOUR_MS,
    );
    const readAt = new Date(capturedAt.getTime() + random.int(30, 300) * 1000);
    let batch = batches.get(document.batchId);
    if (!batch) {
      batch = {
        id: `${profile.registry}-B${String(batches.size + 1).padStart(3, '0')}`,
        registry: profile.registry,
        source: 'Back-scanning of the register (generated)',
        createdById: entry.capturedBy.id,
        createdByName: entry.capturedBy.name,
        createdAt: capturedAt,
        sheets: 0,
      };
      batches.set(document.batchId, batch);
      out.intakeBatches.push(batch);
    }
    batch.sheets += 1;
    // now and then the AI misread a value and the officer corrected it
    const long = document.fields.filter(f => f.v.length > 3);
    const corrected =
      long.length && random.chance(CORRECTED) ? random.pick(long).k : null;
    const read = Object.fromEntries(
      document.fields.map(f => [
        f.k,
        f.k === corrected ? misread(random, f.v) : f.v,
      ]),
    );
    return {
      ...entry,
      filedFields: first.fields,
      pages,
      evidence,
      capturedAt,
      readAt,
      batch,
      sheet: batch.sheets,
      corrected,
      read,
      intakeId: document.sourceId,
      extractionId: random.uuid(),
    };
  }

  /** The document's files and rows. */
  async function write(p, out) {
    const {document, versions, intakeId} = p;
    const [version] = versions;
    const pdf = await pool.build({
      pages: p.pages,
      title: document.title,
      at: p.capturedAt,
      scan: `${p.batch.id} sheet ${p.sheet}`,
    });
    const text = Buffer.from(JSON.stringify(p.pages));
    const fileName = version.fileName;
    const intakeKey = storageKey('intake', intakeId, 1, fileName);
    const intakeTextKey = storageKey(
      'intake',
      intakeId,
      1,
      'transcription-1.json',
    );
    const edrmsTextKey = storageKey(
      'edrms',
      document.id,
      1,
      `transcription-${p.extractionId}.json`,
    );
    const [scan, intakeText, filed, edrmsText] = await Promise.all([
      put(stores.intake, intakeKey, pdf, 'application/pdf'),
      put(stores.intake, intakeTextKey, text, 'application/json'),
      put(stores.edrms, version.storageKey, pdf, 'application/pdf'),
      put(stores.edrms, edrmsTextKey, text, 'application/json'),
    ]);

    // the AI's reading, and the review rows built from it as intake builds them
    const answerFields = p.filedFields.map(f => ({
      k: f.k,
      value: p.read[f.k],
      page: p.evidence[f.k].page,
      evidence: p.evidence[f.k].text,
      legible: true,
      confidence: 0.97,
    }));
    const answer = {
      docType: document.docType,
      docTypeReason: 'The heading names the instrument',
      languages: ['en'],
      handwritingPresent: false,
      fields: answerFields,
    };
    const {rows} = buildRows(
      {...answer, pages: p.pages},
      {model: READER.model},
    );
    const filedValue = new Map(p.filedFields.map(f => [f.k, f.v]));
    for (const row of rows) {
      if (!filedValue.has(row.k)) continue;
      if (row.k === p.corrected) {
        row.value = filedValue.get(row.k);
        row.normalized = normalize(row.type, row.value).normalized;
        row.status = 'edited';
      } else {
        row.status = 'accepted';
      }
      row.flag = flagOf(row);
    }
    if (p.corrected) {
      // corrected by the officer before filing: marked so in every version and the document
      counts.corrected += 1;
      const mark = fields =>
        fields.map(f => (f.k === p.corrected ? {...f, edited: true} : f));
      version.fields = mark(version.fields);
      document.fields = mark(document.fields);
    }

    // edrms: the version's real file, the reading it came from, and its seal again
    Object.assign(version, {
      size: filed.size,
      sha256: filed.sha256,
      encryption: filed.encryption,
      provenance: {
        intakeDocumentId: intakeId,
        extractionId: p.extractionId,
        provider: READER.provider,
        model: READER.model,
        promptVersion: PROMPT_VERSION,
        extractedAt: p.readAt,
        escalated: false,
        extracted: p.read,
        corrected: p.corrected ? [p.corrected] : [],
      },
    });
    version.seal = sealOf(document.id, document.edrmsNo, version);
    document.pages = p.pages.length;
    document.batchId = p.batch.id;
    out.edrmsTexts.push({
      documentId: document.id,
      versionNumber: 1,
      storageKey: edrmsTextKey,
      pages: p.pages.length,
      size: edrmsText.size,
      sha256: edrmsText.sha256,
      encryption: edrmsText.encryption,
      createdAt: document.filedAt,
    });

    // intake: the scan's row as it stands once filed, its reading and its history
    const reviewer = {id: document.filedById, name: document.filedByName};
    out.intakeDocuments.push({
      id: intakeId,
      batchId: p.batch.id,
      status: 'filed',
      fileKey: intakeKey,
      fileName,
      mimeType: 'application/pdf',
      size: scan.size,
      sha256: scan.sha256,
      encryption: scan.encryption,
      capturedById: p.capturedBy.id,
      capturedByName: p.capturedBy.name,
      capturedAt: p.capturedAt,
      docType: document.docType,
      docTypeReason: answer.docTypeReason,
      languages: answer.languages,
      handwritingPresent: false,
      pages: p.pages.length,
      fields: rows,
      notes: [],
      latestExtractionId: p.extractionId,
      transcription: {
        key: intakeTextKey,
        sha256: intakeText.sha256,
        size: intakeText.size,
        pages: p.pages.length,
        encryption: intakeText.encryption,
      },
      escalated: false,
      extractionCostUsd: 0,
      filedDocumentId: document.id,
      edrmsNo: document.edrmsNo,
      filedAt: document.filedAt,
      filedById: reviewer.id,
      filedByName: reviewer.name,
      updatedAt: document.filedAt,
      version: 3,
    });
    out.intakeExtractions.push({
      id: p.extractionId,
      documentId: intakeId,
      role: 'primary',
      ok: true,
      ...READER,
      promptVersion: PROMPT_VERSION,
      answer,
      usage: null,
      costUsd: 0,
      durationMs: p.readAt - p.capturedAt,
      createdAt: p.readAt,
    });
    out.intakeEvents.push(
      {
        documentId: intakeId,
        action: 'captured',
        detail: `${fileName} · ${p.pages.length} page(s) · ${scan.size} bytes`,
        byId: p.capturedBy.id,
        byName: p.capturedBy.name,
        at: p.capturedAt,
      },
      {
        documentId: intakeId,
        action: 'extracted',
        detail: `${document.docType} · ${rows.length} fields · 0 conflict, 0 to check`,
        byId: null,
        byName: 'System',
        at: p.readAt,
      },
      {
        documentId: intakeId,
        action: 'filed',
        detail: document.edrmsNo,
        byId: reviewer.id,
        byName: reviewer.name,
        at: document.filedAt,
      },
    );
  }

  return {
    async add(entries) {
      const out = {
        intakeBatches: [],
        intakeDocuments: [],
        intakeExtractions: [],
        intakeEvents: [],
        edrmsTexts: [],
      };
      const planned = entries.map(e => plan(e, out));
      await eachLimit(planned, CONCURRENCY, p => write(p, out));
      out.intakeBatches = out.intakeBatches.map(({sheets: _sheets, ...b}) => b);
      return out;
    },
    /** A batch written before (--resume): planned only, so that the next ones are the same. */
    skip(entries) {
      const out = {intakeBatches: []};
      for (const e of entries) plan(e, out);
    },
    /** The number of intake batches, for intake's counter. */
    batchCount: () => batches.size,
    totals: () => ({...counts}),
    close: () => pool.close(),
  };
}
