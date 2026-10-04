import { createHash, randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '@lrfe/common';
import { DOC_TYPE_IDS, docType, formatEdrmsNo, instrumentRefOf, normalizeRef } from './catalogue.js';
import { validateRecordMetadata } from './record-metadata.js';
import { sealOf } from './seal.js';
import { storageKey } from './storage/index.js';

/**
 * The encrypting store's key service (OpenBao) failed: sealed, unreachable, or this service's login
 * or key refused. Screens get a neutral message (no tool names); the cause stays on the error for logs.
 */
const UNAVAILABLE = 'The document store is temporarily unavailable. Try again shortly.';
function storeError(err) {
    if (err?.name !== 'KeyringError') return err;
    return Object.assign(new AppError(503, UNAVAILABLE), { cause: err });
}

const MIME_TYPES = ['application/pdf', 'image/tiff', 'image/png', 'image/jpeg'];
const SYSTEM = { id: null, name: 'System' };

/**
 * After storing: reject empty files, and files cut off by the upload size limit (multipart
 * streams mark themselves `truncated` rather than failing).
 */
function assertComplete(file, size) {
    if (file.stream.truncated) throw new AppError(413, 'The file is larger than the allowed upload size');
    if (size === 0) throw new BadRequestError('The file is empty');
}

/** Optional provenance of the filed values (e.g. the intake extraction). A small JSON object. */
function cleanProvenance(p) {
    if (p === undefined || p === null) return null;
    if (typeof p !== 'object' || Array.isArray(p)) throw new BadRequestError('meta.provenance must be an object');
    if (JSON.stringify(p).length > 20_000) throw new BadRequestError('meta.provenance is too large (max 20 kB)');
    return p;
}

/** Drain an unused upload stream so the request can complete. */
const discard = async (stream) => { if (stream) for await (const _ of stream) { /* drain */ } };

function cleanFields(fields) {
    if (!Array.isArray(fields) || fields.length === 0) throw new BadRequestError('fields must be a non-empty list');
    const seen = new Set();
    return fields.map((f, i) => {
        if (!f || typeof f.k !== 'string' || !f.k || typeof f.v !== 'string') throw new BadRequestError(`fields[${i}] needs a key "k" and a string value "v"`);
        if (seen.has(f.k)) throw new BadRequestError(`Duplicate field "${f.k}"`);
        seen.add(f.k);
        return {
            k: f.k, label: String(f.label || f.k), v: f.v,
            ...(typeof f.c === 'number' ? { c: f.c } : {}),
            ...(f.edited ? { edited: true } : {})
        };
    });
}

const propsOf = (fields) => Object.fromEntries(fields.map(f => [f.k, f.v]));

/**
 * The EDRMS: documents of record for the land registry. A document is created once, by filing
 * (intake service, after metadata review), and never deleted. Every version is immutable and
 * sealed; a correction is an amendment — a new major version with a reason.
 */
export class EdrmsService {
    constructor({ repo, store, events, clock = () => new Date(), config = {} }) {
        this.repo = repo;
        this.store = store;
        this.events = events;
        this.clock = clock;
        this.config = {
            country: 'NA',
            registry: 'WDH',
            urlTtlSeconds: 300,
            defaultRecordMetadata: {
                aggregationLevel: 'item',
                language: 'en',
                businessFunction: 'Deeds registration',
                retentionSchedule: 'permanent',
                dispositionAction: 'retain',
                accessRestriction: 'restricted'
            },
            ...config
        };
    }

    async requireDocument(id) {
        const doc = await this.repo.getDocument(id);
        if (!doc) throw new NotFoundError('Document not found');
        return doc;
    }

    // ---------------------------------------------------------------- filing

    /**
     * File a reviewed document as a record (called by the intake service).
     *   meta: { sourceId, batchId?, registry?, docType, title, pages, fields: [{k, label, v, c?, edited?}],
     *           recordMetadata?, capturedBy?: {id, name}, reviewedBy: {id, name} }
     *   file: { stream, fileName, mimeType }
     * Idempotent on `sourceId` (the intake document id): filing it again returns the existing record.
     */
    async fileDocument({ meta, file }) {
        let uploadedKey = null;
        try {
            if (!meta || typeof meta !== 'object') throw new BadRequestError('meta is required');
            if (!meta.sourceId) throw new BadRequestError('meta.sourceId is required');
            const existing = await this.repo.findDocument({ sourceId: String(meta.sourceId) });
            if (existing) {
                await discard(file?.stream);
                return { document: existing, created: false };
            }
            if (!DOC_TYPE_IDS.includes(meta.docType)) throw new BadRequestError(`docType must be one of ${DOC_TYPE_IDS.join(', ')}`);
            if (!String(meta.title || '').trim()) throw new BadRequestError('meta.title is required');
            if (!Number.isInteger(meta.pages) || meta.pages < 1) throw new BadRequestError('meta.pages must be a positive whole number');
            if (!meta.reviewedBy?.id) throw new BadRequestError('meta.reviewedBy is required');
            if (!file?.stream) throw new BadRequestError('A file is required');
            if (!MIME_TYPES.includes(file.mimeType)) throw new BadRequestError(`File type must be one of ${MIME_TYPES.join(', ')}`);

            const fields = cleanFields(meta.fields);
            const instrumentRef = instrumentRefOf(meta.docType, fields);
            if (docType(meta.docType).refField && !instrumentRef) {
                throw new BadRequestError(`A ${docType(meta.docType).label.toLowerCase()} needs the "${docType(meta.docType).refField}" field`);
            }
            if (instrumentRef) {
                const dup = await this.repo.findDocument({ instrumentRef });
                if (dup) throw new ConflictError(`${instrumentRef} is already filed as ${dup.edrmsNo}`, { field: 'instrumentRef', documentId: dup.id, edrmsNo: dup.edrmsNo });
            }
            const recordMetadata = this.buildRecordMetadata(meta);
            const provenance = cleanProvenance(meta.provenance);

            const id = randomUUID();
            const now = this.clock();
            const key = storageKey(id, 1, file.fileName);
            const { sha256, size, encryption } = await this.store.put({ key, body: file.stream, contentType: file.mimeType }).catch(err => { throw storeError(err); });
            uploadedKey = key;
            assertComplete(file, size);

            const reviewer = meta.reviewedBy;
            const document = await this.repo.createDocument({
                year: now.getUTCFullYear(),
                build: (seq) => {
                    const edrmsNo = formatEdrmsNo(this.config.country, now.getUTCFullYear(), seq);
                    const version = {
                        id: randomUUID(), documentId: id, versionNumber: 1, label: '1.0', kind: 'filed', reason: null, changes: [],
                        fields, recordMetadata, storageKey: key, fileName: key.split('/').pop(), mimeType: file.mimeType, size, sha256,
                        createdAt: now, createdById: reviewer.id, createdByName: reviewer.name ?? null,
                        ...(provenance ? { provenance } : {}),
                        ...(encryption ? { encryption } : {})
                    };
                    version.seal = sealOf(id, edrmsNo, version);
                    return {
                        version,
                        document: {
                            id, edrmsNo, docType: meta.docType, title: meta.title.trim(), instrumentRef,
                            registry: meta.registry || this.config.registry, batchId: meta.batchId ?? null, sourceId: String(meta.sourceId),
                            pages: meta.pages, fields, props: propsOf(fields), recordMetadata, currentVersion: 1,
                            filedAt: now, filedById: reviewer.id, filedByName: reviewer.name ?? null, updatedAt: now
                        }
                    };
                }
            });
            uploadedKey = null;
            const v1 = await this.repo.getVersion(id, 1);
            await this.events.publish('edrms.document.filed', {
                documentId: id, edrmsNo: document.edrmsNo, docType: document.docType, instrumentRef, batchId: document.batchId,
                sourceId: document.sourceId, props: document.props, sha256, seal: v1.seal
            }, { actor: { id: reviewer.id, name: reviewer.name } });
            return { document, created: true };
        } catch (err) {
            await discard(file?.stream).catch(() => {});
            // Content written but the record never committed: remove the orphan (best effort).
            if (uploadedKey) await this.store.delete(uploadedKey).catch(() => {});
            throw err;
        }
    }

    buildRecordMetadata(meta) {
        const provided = validateRecordMetadata(meta.recordMetadata);
        const agents = [
            meta.capturedBy?.id && { role: 'capturer', identifier: String(meta.capturedBy.id), name: meta.capturedBy.name },
            { role: 'reviewer', identifier: String(meta.reviewedBy.id), name: meta.reviewedBy.name }
        ].filter(Boolean);
        return validateRecordMetadata({
            ...this.config.defaultRecordMetadata,
            businessActivity: `Registration: ${docType(meta.docType).label.toLowerCase()}`,
            agents,
            ...provided
        });
    }

    // ---------------------------------------------------------------- amendments

    /**
     * Correct a filed record: a new major version. Field corrections and/or a replacement file
     * (e.g. a better rescan); the reason is mandatory. Earlier versions stay readable and sealed.
     *   changes: [{ k, v }]    only existing field keys
     *   expectedVersion:       the version the requester was looking at (optimistic concurrency)
     *   actor / approvedBy:    requester and approver (four-eyes, via the bpm service); both sealed
     *
     * TODO: the HTTP route only accepts field/metadata changes. A replacement file needs a staged
     * upload that bpm can reference until the change is approved.
     */
    async amendDocument({ id, expectedVersion, reason, changes = [], recordMetadata, file, actor = SYSTEM, approvedBy = null }) {
        let uploadedKey = null;
        try {
            const doc = await this.requireDocument(id);
            if (!String(reason || '').trim() || String(reason).trim().length < 5) throw new BadRequestError('A reason (at least 5 characters) is required');
            if (expectedVersion !== undefined && expectedVersion !== doc.currentVersion) {
                throw new ConflictError(`The document is now at version ${doc.currentVersion}.0. Reload and try again.`);
            }
            if (file && !MIME_TYPES.includes(file.mimeType)) throw new BadRequestError(`File type must be one of ${MIME_TYPES.join(', ')}`);

            const fields = structuredClone(doc.fields);
            const changed = [];
            for (const { k, v } of changes) {
                const field = fields.find(f => f.k === k);
                if (!field) throw new BadRequestError(`Unknown field "${k}"`);
                if (typeof v !== 'string') throw new BadRequestError(`Value for "${k}" must be a string`);
                if (field.v === v) continue;
                changed.push({ k, from: field.v, to: v });
                field.v = v;
                field.edited = true;
            }
            const nextMetadata = recordMetadata ? validateRecordMetadata({ ...doc.recordMetadata, ...recordMetadata }) : doc.recordMetadata;
            const metadataChanged = JSON.stringify(nextMetadata) !== JSON.stringify(doc.recordMetadata);
            if (!changed.length && !file && !metadataChanged) {
                await discard(file?.stream);
                throw new BadRequestError('Nothing to amend: no field, metadata or file changes');
            }

            const previous = await this.repo.getVersion(id, doc.currentVersion);
            const n = doc.currentVersion + 1;
            // Without a new file the version points at the previous one's file, encrypted as it was
            let content = {
                storageKey: previous.storageKey, fileName: previous.fileName, mimeType: previous.mimeType, size: previous.size, sha256: previous.sha256,
                ...(previous.encryption ? { encryption: previous.encryption } : {})
            };
            if (file) {
                const key = storageKey(id, n, file.fileName);
                const { sha256, size, encryption } = await this.store.put({ key, body: file.stream, contentType: file.mimeType }).catch(err => { throw storeError(err); });
                uploadedKey = key;
                assertComplete(file, size);
                content = { storageKey: key, fileName: key.split('/').pop(), mimeType: file.mimeType, size, sha256, ...(encryption ? { encryption } : {}) };
            }

            const now = this.clock();
            const version = {
                id: randomUUID(), documentId: id, versionNumber: n, label: `${n}.0`, kind: 'amendment', reason: reason.trim(),
                changes: [...changed, ...(file ? [{ k: '(file)', from: previous.sha256, to: content.sha256 }] : [])],
                fields, recordMetadata: nextMetadata, ...content,
                createdAt: now, createdById: actor.id, createdByName: actor.name,
                approvedById: approvedBy?.id ?? null, approvedByName: approvedBy?.name ?? null
            };
            version.seal = sealOf(id, doc.edrmsNo, version);
            const updated = await this.repo.addVersion(id, doc.currentVersion, version, {
                fields, props: propsOf(fields), recordMetadata: nextMetadata,
                instrumentRef: instrumentRefOf(doc.docType, fields), currentVersion: n, updatedAt: now
            });
            uploadedKey = null;
            await this.events.publish('edrms.document.amended', {
                documentId: id, edrmsNo: doc.edrmsNo, version: n, reason: version.reason, changes: version.changes,
                instrumentRef: updated.instrumentRef, props: updated.props, sha256: content.sha256, seal: version.seal
            }, { actor });
            return { document: updated, version: this.publicVersion(version) };
        } catch (err) {
            await discard(file?.stream).catch(() => {});
            if (uploadedKey) await this.store.delete(uploadedKey).catch(() => {});
            throw err;
        }
    }

    // ---------------------------------------------------------------- reading

    /** A version as clients see it: without its storage key and its encryption record (wrapped key). */
    publicVersion(v) {
        const { storageKey: _key, encryption: _encryption, ...rest } = v;
        return rest;
    }

    async getDocument(id) {
        const doc = await this.requireDocument(id);
        const versions = await this.repo.listVersions(id);
        return {
            ...doc,
            versions: versions.map(v => ({
                versionNumber: v.versionNumber, label: v.label, kind: v.kind, reason: v.reason, changes: v.changes,
                sha256: v.sha256, seal: v.seal, size: v.size, mimeType: v.mimeType,
                createdAt: v.createdAt, createdById: v.createdById, createdByName: v.createdByName,
                approvedById: v.approvedById ?? null, approvedByName: v.approvedByName ?? null
            }))
        };
    }

    async listDocuments(query) {
        if (query.docType && !DOC_TYPE_IDS.includes(query.docType)) throw new BadRequestError(`Unknown docType "${query.docType}"`);
        return this.repo.listDocuments(query);
    }

    async findByReference({ edrmsNo, instrumentRef, sourceId }) {
        const where = edrmsNo ? { edrmsNo } : instrumentRef ? { instrumentRef: normalizeRef(instrumentRef) } : sourceId ? { sourceId } : null;
        if (!where) throw new BadRequestError('Give edrmsNo, instrumentRef or sourceId');
        const doc = await this.repo.findDocument(where);
        if (!doc) throw new NotFoundError('Document not found');
        return doc;
    }

    async getVersion(id, versionNumber) {
        await this.requireDocument(id);
        const v = await this.repo.getVersion(id, versionNumber);
        if (!v) throw new NotFoundError('Version not found');
        return v;
    }

    /**
     * A short-lived link to a version's content. S3 gives a presigned URL; other stores return
     * null and the route layer builds its own HMAC-signed /content URL.
     */
    async contentLink(id, versionNumber) {
        const doc = await this.requireDocument(id);
        const v = await this.getVersion(id, versionNumber ?? doc.currentVersion);
        const expiresIn = this.config.urlTtlSeconds;
        const url = await this.store.signedUrl(v.storageKey, { expiresIn, fileName: `${doc.edrmsNo}-v${v.versionNumber}-${v.fileName}`, contentType: v.mimeType });
        return { url, version: v.versionNumber, mimeType: v.mimeType, sha256: v.sha256, expiresIn };
    }

    async openContent(id, versionNumber) {
        const v = await this.getVersion(id, versionNumber);
        const stream = await this.store.getStream(v.storageKey, { encryption: v.encryption }).catch(err => { throw storeError(err); });
        return { stream, mimeType: v.mimeType, size: v.size, fileName: v.fileName };
    }

    /**
     * Integrity check for auditors: re-hash the stored content and recompute the seal.
     * `intact` is false if the file bytes or the version's metadata were altered after sealing.
     */
    async verifyVersion(id, versionNumber) {
        const doc = await this.requireDocument(id);
        const v = await this.getVersion(id, versionNumber);
        const hash = createHash('sha256');
        let contentSha256 = null;
        try {
            for await (const chunk of await this.store.getStream(v.storageKey, { encryption: v.encryption })) hash.update(chunk);
            contentSha256 = hash.digest('hex');
        } catch (err) {
            // An encrypted file that fails authentication was changed or cut off: not intact.
            if (err?.code !== 'EDECRYPT') throw storeError(err);
        }
        const seal = sealOf(id, doc.edrmsNo, { ...v, sha256: contentSha256 ?? v.sha256 });
        return {
            documentId: id, edrmsNo: doc.edrmsNo, version: v.versionNumber,
            contentIntact: contentSha256 === v.sha256, sealIntact: seal === v.seal, intact: contentSha256 === v.sha256 && seal === v.seal,
            sha256: contentSha256, seal: v.seal, checkedAt: this.clock()
        };
    }
}
