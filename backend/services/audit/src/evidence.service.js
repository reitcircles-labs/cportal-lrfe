import { createHash } from 'node:crypto';
import { AppError, NotFoundError } from '@lrfe/common';
import { zip } from './zip.js';

export const PACK_FORMAT = 'lrfe-evidence-pack/1';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * The evidence pack of a land record (README.md section 6; API-660): one zip with everything needed
 * to defend the record outside the portal, checked by the offline verifier (verifier/lrfe-verify.mjs).
 *
 *   README.txt                                 a readable summary and how to check the pack
 *   manifest.json                              format, the record, who exported it when, every file's SHA-256
 *   record/record.json                         the land record
 *   record/versions/v<n>.json                  each committed version, as sealed (its seal recomputes from it)
 *   documents/<edrmsNo>/v<n>.json              each pinned document version's sealed metadata
 *   documents/<edrmsNo>/v<n>-<file>            its file (its SHA-256 is in the metadata, and so in the seal)
 *   trail/entries.json                         the record's audit trail (with its documents' steps)
 *   signoffs.json · findings.json              sign-offs and findings
 *   proofs/record-v<n>.json, proofs/<edrmsNo>-v<n>.json, proofs/trail-<seq>.json
 *                                              a proof for each version, document version and trail entry
 *
 * The export itself is a trail entry (`audit.evidence.exported`: who, which record, the manifest's hash).
 */
export class EvidenceService {
    constructor({ trail, proofs, signoffs, sources, events, cardano = null, clock = () => new Date(), logger = console }) {
        this.trail = trail;
        this.proofs = proofs;
        this.signoffs = signoffs;
        this.sources = sources;      // { record(id), versions(id), version(id, n), document(id), documentVersion(id, n), file(id, n) }
        this.events = events;
        this.cardano = cardano;
        this.clock = clock;
        this.logger = logger;
    }

    async build(recordId, actor) {
        const record = await this.sources.record(recordId);
        const committed = (await this.sources.versions(recordId)).filter(v => ['committed', 'superseded'].includes(v.state));
        if (!committed.length) throw new AppError(409, `${record.recordNo} has no committed version yet: there is nothing to export`);
        const files = [];
        const add = (path, data) => files.push({ path, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });
        const summary = { versions: [], documents: [], proofs: { anchored: 0, waiting: 0 } };
        // a proof for every item: the verifier requires one; an item not in the audit tree gets a placeholder
        const proof = async (path, kind, id, version, item) => {
            const p = await this.proofs.proof(kind, id, version).catch(err => {
                if (err.statusCode === 404) return { format: 'lrfe-audit-proof/1', status: 'not in the audit tree', item };
                throw err;
            });
            add(path, json(p));
            summary.proofs[['anchored', 'confirmed'].includes(p.status) ? 'anchored' : 'waiting']++;
            return p;
        };

        add('record/record.json', json(record));
        // each committed version, as sealed, and every document version it pins
        const pinned = new Map();                                  // documentId → Set of versions
        for (const s of committed) {
            const v = await this.sources.version(recordId, s.versionNumber);
            add(`record/versions/v${v.versionNumber}.json`, json(v));
            const p = await proof(`proofs/record-v${v.versionNumber}.json`, 'record-version', recordId, v.versionNumber, { kind: 'record-version', recordId, version: v.versionNumber, seal: v.seal });
            summary.versions.push({ version: v.versionNumber, committedAt: v.committedAt, approvedBy: v.approvedByName ?? null, seal: v.seal, proof: p?.status ?? 'not in the audit tree' });
            for (const d of v.data?.documents || []) {
                if (!pinned.has(d.edrmsDocumentId)) pinned.set(d.edrmsDocumentId, new Set());
                pinned.get(d.edrmsDocumentId).add(d.version);
            }
        }
        // a pinned document that cannot be read is named (a bare 404 would read as "no such record")
        const named = (what) => (err) => { throw new AppError(err.statusCode === 404 ? 409 : 502, `${what} could not be read for the pack: ${err.message}`); };
        for (const [documentId, versions] of pinned) {
            const doc = await this.sources.document(documentId).catch(named(`Document ${documentId}, pinned in the record,`));
            for (const n of [...versions].sort((a, b) => a - b)) {
                const v = await this.sources.documentVersion(documentId, n).catch(named(`${doc.edrmsNo} version ${n}, pinned in the record,`));
                const dir = `documents/${safe(doc.edrmsNo)}`;
                let file;
                try { file = await this.sources.file(documentId, n); } catch (err) {
                    throw new AppError(502, `The file of ${doc.edrmsNo} version ${n} could not be read: ${err.message}`);
                }
                // a stored file that no longer matches its seal is not exported as evidence of anything
                if (sha256(file) !== v.sha256) throw new AppError(409, `The stored file of ${doc.edrmsNo} version ${n} does not match the SHA-256 it was sealed with: check its integrity (Documents) before exporting`);
                const name = `${dir}/v${n}-${safe(v.fileName || 'file')}`;
                add(`${dir}/v${n}.json`, json({ documentId, edrmsNo: doc.edrmsNo, title: doc.title, docType: doc.docType, file: name.split('/').pop(), ...v }));
                add(name, file);
                const p = await proof(`proofs/${safe(doc.edrmsNo)}-v${n}.json`, 'document-version', documentId, n, { kind: 'document-version', documentId, version: n, seal: v.seal });
                summary.documents.push({ edrmsNo: doc.edrmsNo, title: doc.title, version: n, seal: v.seal, proof: p?.status ?? 'not in the audit tree' });
            }
        }

        // the record's trail, a proof for each entry, and the sign-offs and findings
        const entries = [];
        for (let offset = 0; ; offset += 500) {
            const page = await this.trail.list({ subject: `record:${recordId}`, limit: 500, offset });
            entries.push(...page.entries);
            if (entries.length >= page.total || !page.entries.length) break;
        }
        add('trail/entries.json', json(entries));
        for (const e of entries) await proof(`proofs/trail-${e.seq}.json`, 'trail-entry', String(e.seq), { kind: 'trail-entry', seq: e.seq });
        // the record's sign-offs and findings, and findings on its documents alone (they are in its trail too)
        const signoffs = await this.signoffs.listSignoffs({ recordId });
        const findings = await this.signoffs.listFindings({ recordId });
        for (const documentId of pinned.keys()) findings.push(...(await this.signoffs.listFindings({ documentId })).filter(f => !f.recordId));
        add('signoffs.json', json(signoffs));
        add('findings.json', json(findings));

        const exportedAt = this.clock().toISOString();
        const wallet = await this.walletAddress();
        add('README.txt', readme({ record, summary, entries, signoffs, findings, exportedAt, actor, wallet, network: this.cardano?.network ?? null }));
        const manifest = {
            format: PACK_FORMAT,
            record: { id: record.id, recordNo: record.recordNo, label: record.label },
            exportedAt, exportedBy: { id: actor.id, name: actor.name ?? null },
            anchoring: { network: this.cardano?.network ?? null, wallet },
            files: files.map(f => ({ path: f.path, sha256: sha256(f.data), bytes: f.data.length }))
        };
        const manifestText = json(manifest);
        const manifestSha256 = sha256(manifestText);
        // the pack first: the trail never records an export that did not happen
        const pack = zip([{ path: 'manifest.json', data: manifestText }, ...files], { date: new Date(exportedAt) });
        await this.events.publish('audit.evidence.exported', {
            recordId, recordNo: record.recordNo, files: files.length + 1, manifestSha256,
            versions: summary.versions.length, documents: summary.documents.length, trailEntries: entries.length
        }, { actor });
        return { fileName: `evidence-${safe(record.recordNo)}-${exportedAt.slice(0, 10)}.zip`, manifestSha256, zip: pack };
    }

    async walletAddress() {
        if (!this.cardano) return null;
        try { return await this.cardano.address(); } catch { return null; }
    }
}

function readme({ record, summary, entries, signoffs, findings, exportedAt, actor, wallet, network }) {
    const line = (s = '') => `${s}\n`;
    let t = '';
    t += line(`Evidence pack: land record ${record.recordNo} (${record.label})`);
    t += line(`Exported ${exportedAt} by ${actor.name ?? actor.id} from the Namibia land records portal.`);
    t += line();
    t += line('Committed versions');
    for (const v of summary.versions) t += line(`  version ${v.version}: committed ${v.committedAt}, approved by ${v.approvedBy ?? '-'}, seal ${v.seal}, proof: ${v.proof}`);
    t += line();
    t += line('Documents pinned in them');
    for (const d of summary.documents) t += line(`  ${d.edrmsNo} version ${d.version} (${d.title}): seal ${d.seal}, proof: ${d.proof}`);
    t += line();
    t += line(`Audit trail: ${entries.length} entries (trail/entries.json).`);
    t += line(`Sign-offs: ${signoffs.length}${signoffs.map(s => `\n  ${s.signedAt instanceof Date ? s.signedAt.toISOString() : s.signedAt} ${s.signedByName ?? s.signedById}: version ${s.recordVersion}${s.edrmsNo ? `, ${s.edrmsNo} version ${s.documentVersion}` : ''}: ${s.comment}`).join('')}`);
    t += line(`Findings: ${findings.length}${findings.map(f => `\n  ${f.status}: ${f.description}`).join('')}`);
    t += line(`Proofs: ${summary.proofs.anchored} anchored on Cardano, ${summary.proofs.waiting} waiting for the next anchoring.`);
    t += line();
    t += line('How to check this pack without the portal');
    t += line('  1. Get the offline verifier (lrfe-verify.mjs, one file; Node.js 18 or later) and the portal\'s');
    t += line(`     published anchoring wallet address${wallet ? ` (this pack names ${wallet}${network ? ` on ${network}` : ''})` : ''}.`);
    t += line('  2. Run:  node lrfe-verify.mjs <this-pack>.zip --address <the published wallet address>');
    t += line('     It checks every file against manifest.json, recomputes every seal from the versions and the');
    t += line('     files, follows the trail\'s hash chain, and checks every proof against the Cardano transaction');
    t += line('     (through the public Koios API; --source blockfrost with a key also works).');
    t += line('  3. VALID means the pack is consistent, nothing in it was changed, and every version, document and');
    t += line('     trail entry in it existed unchanged when its root was put on Cardano by the portal\'s wallet.');
    t += line('     Items it cannot prove on chain are listed ("VALID AS FAR AS ANCHORED"): they may be newer than');
    t += line('     the last anchoring; export the pack again after the next anchoring, or check them with the portal.');
    t += line();
    t += line('Not covered by any seal, shown as exported: this README, who exported the pack and when, the land');
    t += line('record\'s summary (record/record.json) beyond its id and current version, document titles, and the');
    t += line('times of sign-offs and findings. An offline check also cannot show that nothing was left out (the');
    t += line('newest version, or a trail entry, removed together with its proof);');
    t += line('the portal recorded this export with the SHA-256 of manifest.json in its audit trail');
    t += line('(audit.evidence.exported), anchored with the next root, so the portal can confirm it.');
    return t;
}

/** land-records and edrms for the pack, over HTTP with the audit service's token. */
export function createEvidenceSources({ recordsUrl, edrmsUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
    async function get(url, what, { binary = false } = {}) {
        let res;
        try {
            res = await fetchImpl(url, { headers: { authorization: `Bearer ${serviceToken()}` }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new AppError(503, `The ${what} cannot be reached: ${err.message}`);
        }
        if (binary && res.status < 400) return Buffer.from(await res.arrayBuffer());
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON: reported by status */ }
        if (res.status === 404) throw new NotFoundError(body?.message || 'Not found');
        if (res.status >= 400 || !body) throw new AppError(502, `Reading from the ${what} failed (${res.status}): ${body?.message || 'no detail'}`);
        return body;
    }
    const records = 'land records service', docs = 'document service';
    return {
        record: (id) => get(`${recordsUrl}/records/${id}`, records),
        versions: (id) => get(`${recordsUrl}/records/${id}/versions`, records),
        version: (id, n) => get(`${recordsUrl}/records/${id}/versions/${n}`, records),
        document: (id) => get(`${edrmsUrl}/documents/${id}`, docs),
        documentVersion: (id, n) => get(`${edrmsUrl}/documents/${id}/versions/${n}`, docs),
        file: (id, n) => get(`${edrmsUrl}/documents/${id}/versions/${n}/file`, docs, { binary: true })
    };
}
