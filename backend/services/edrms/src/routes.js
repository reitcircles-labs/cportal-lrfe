import { createHmac } from 'node:crypto';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError, describeGuard } from '@lrfe/common';
import { DOC_TYPES, DOC_TYPE_IDS, FILING_SERVICES, READ_PERMS } from './catalogue.js';
import { describeRecordMetadataFields } from './record-metadata.js';
import { safeEqual } from './util.js';

/** Services that may read documents with a service token. */
const READ_SERVICES = ['intake', 'land-records', 'audit', 'search', 'bpm'];

const idParams = (extra = {}) => ({
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' }, ...extra } }
});
const versionParam = { n: { type: 'integer', minimum: 1 } };

function parseMeta(raw) {
    if (raw === undefined) throw new BadRequestError('Send a "meta" JSON field before the file');
    try {
        return JSON.parse(raw);
    } catch {
        throw new BadRequestError('"meta" must be valid JSON');
    }
}

/**
 * multipart/form-data: a `meta` field (JSON) FIRST, then a `file` field. Parts are read in order
 * and the file is handed to `handle(meta, file)` while it is still streaming — it goes straight
 * to storage and is never buffered — so `meta` has to arrive before it.
 */
async function withUpload(req, handle) {
    let meta, result, handled = false;
    for await (const part of req.parts()) {
        if (part.type === 'field') {
            if (part.fieldname === 'meta') meta = part.value;
            continue;
        }
        if (part.fieldname !== 'file' || handled) throw new BadRequestError('Send exactly one file, in a field named "file"');
        const parsed = parseMeta(meta);
        result = await handle(parsed, { stream: part.file, fileName: part.filename, mimeType: part.mimetype });
        handled = true;
    }
    if (!handled) throw new BadRequestError('A file is required');
    return result;
}

export async function edrmsRoutes(app, { service, contentUrl }) {
    const sign = (id, n, exp) => createHmac('sha256', contentUrl.secret).update(`${id}:${n}:${exp}`).digest('base64url');

    async function canRead(req, reply) {
        try {
            await req.jwtVerify();
        } catch {
            throw new UnauthorizedError('Invalid or expired token');
        }
        if (req.user.typ === 'service') {
            if (!READ_SERVICES.includes(req.user.sub)) throw new ForbiddenError('Not permitted', { service: req.user.sub });
            return;
        }
        return app.requireAnyPerm(...READ_PERMS)(req, reply);
    }
    describeGuard(canRead, { kind: 'user-or-service', anyOf: READ_PERMS, services: READ_SERVICES });

    // ------------------------------------------------------------------ catalogue

    app.get('/catalogue', { onRequest: app.authenticate }, async () => ({ docTypes: DOC_TYPES, recordMetadataFields: describeRecordMetadataFields() }));

    // ------------------------------------------------------------------ filing (intake only)

    app.post('/documents', { onRequest: app.requireService(...FILING_SERVICES) }, async (req, reply) => {
        const { document, created } = await withUpload(req, (meta, file) => service.fileDocument({ meta, file }));
        return reply.status(created ? 201 : 200).send({ document, created });
    });

    // ------------------------------------------------------------------ reading

    app.get('/documents', {
        onRequest: canRead,
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    q: { type: 'string', maxLength: 200 },
                    docType: { type: 'string', enum: DOC_TYPE_IDS },
                    batchId: { type: 'string', maxLength: 50 },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    offset: { type: 'integer', minimum: 0, default: 0 }
                },
                // field.<key>=<value> filters on extracted fields, e.g. field.property=Erf 1873, Klein Windhoek
                patternProperties: { '^field\\.[A-Za-z0-9_]+$': { type: 'string', maxLength: 200 } },
                additionalProperties: false
            }
        }
    }, async (req) => {
        const { q, docType, batchId, limit, offset, ...rest } = req.query;
        const props = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k.slice('field.'.length), v]));
        return service.searchDocuments({ q, docType, batchId, props, limit, offset });
    });

    app.get('/documents/lookup', {
        onRequest: canRead,
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { edrmsNo: { type: 'string' }, instrumentRef: { type: 'string' }, sourceId: { type: 'string' } } } }
    }, async (req) => service.findByReference(req.query));

    // every document version's seal, oldest first, for the audit service's backfill (API-669)
    app.get('/documents/seals', {
        onRequest: app.requireService('audit'),
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'string', maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 } } } }
    }, async (req) => {
        // `after`/`next`: an opaque cursor, the position of the last seal read (base64url JSON)
        let after = null;
        if (req.query.after) {
            try { after = JSON.parse(Buffer.from(req.query.after, 'base64url').toString()); } catch { after = null; }
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!after || Number.isNaN(Date.parse(after.at)) || !uuid.test(after.id ?? '') || !Number.isInteger(after.version)) throw new BadRequestError('Not a cursor from this list');
        }
        const items = await service.listSeals({ after, limit: req.query.limit });
        const last = items.at(-1);
        return { items, next: items.length === req.query.limit ? Buffer.from(JSON.stringify({ at: last.at, id: last.documentId, version: last.version })).toString('base64url') : null };
    });

    app.get('/documents/:id', { onRequest: canRead, schema: idParams() }, async (req) => service.getDocument(req.params.id, { withAnchoring: req.user.typ !== 'service' }));

    app.get('/documents/:id/versions/:n', { onRequest: canRead, schema: idParams(versionParam) },
        async (req) => service.publicVersion(await service.getVersion(req.params.id, req.params.n)));

    /** A short-lived URL for the viewer. `?version=` defaults to the current version. */
    app.get('/documents/:id/content', {
        onRequest: canRead,
        schema: { ...idParams(), querystring: { type: 'object', properties: { version: { type: 'integer', minimum: 1 } } } }
    }, async (req) => {
        const link = await service.contentLink(req.params.id, req.query.version);
        if (!link.url) {
            const exp = Math.floor(Date.now() / 1000) + link.expiresIn;
            link.url = `${contentUrl.base}/${req.params.id}/${link.version}?exp=${exp}&sig=${sign(req.params.id, link.version, exp)}`;
        }
        return link;
    });

    /** A version's file for the audit service's evidence pack (API-660): the bytes, from the store. */
    app.get('/documents/:id/versions/:n/file', { onRequest: app.requireService('audit'), schema: idParams(versionParam) }, async (req, reply) => {
        const content = await service.openContent(req.params.id, req.params.n);
        reply.header('content-type', content.mimeType);
        reply.header('content-disposition', `attachment; filename="${content.fileName}"`);
        return reply.send(content.stream);
    });

    /** Content for stores without presigned URLs (local, memory). Authorised by the signature, not a token. */
    app.get('/content/:id/:n', {
        schema: {
            ...idParams(versionParam),
            querystring: { type: 'object', required: ['exp', 'sig'], properties: { exp: { type: 'integer' }, sig: { type: 'string' } } }
        }
    }, async (req, reply) => {
        const { id, n } = req.params;
        const { exp, sig } = req.query;
        if (exp < Math.floor(Date.now() / 1000) || !safeEqual(sig, sign(id, n, exp))) throw new NotFoundError('Link expired or invalid');
        const content = await service.openContent(id, n);
        reply.header('content-type', content.mimeType);
        reply.header('content-disposition', `inline; filename="${content.fileName}"`);
        reply.header('cache-control', 'private, max-age=300');
        return reply.send(content.stream);
    });

    // the integrity check: auditors, and the audit service verifying a proof (API-658)
    async function canVerify(req, reply) {
        try { await req.jwtVerify(); } catch { throw new UnauthorizedError('Invalid or expired token'); }
        if (req.user.typ === 'service') {
            if (req.user.sub !== 'audit') throw new ForbiddenError('Not permitted', { service: req.user.sub });
            return;
        }
        return app.requirePerm('audit.view')(req, reply);
    }
    describeGuard(canVerify, { kind: 'user-or-service', allOf: ['audit.view'], services: ['audit'] });

    app.get('/documents/:id/versions/:n/verify', { onRequest: canVerify, schema: idParams(versionParam) },
        async (req) => service.verifyVersion(req.params.id, req.params.n));

    // ------------------------------------------------------------------ amendments

    /**
     * Apply an APPROVED amendment. Only the bpm service calls this, at the end of the
     * "document-amendment" process (requested by one person, approved by another). Users request
     * changes through bpm: POST /api/processes/document-amendment/instances.
     */
    const person = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' } } };
    app.post('/documents/:id/amendments', {
        onRequest: app.requireService('bpm'),
        schema: {
            ...idParams(),
            body: {
                type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion', 'actor', 'approvedBy'],
                properties: {
                    reason: { type: 'string' },
                    expectedVersion: { type: 'integer', minimum: 1 },
                    changes: { type: 'array', items: { type: 'object', required: ['k', 'v'], properties: { k: { type: 'string' }, v: { type: 'string' } } } },
                    recordMetadata: { type: 'object' },
                    actor: person,
                    approvedBy: person
                }
            }
        }
    }, async (req, reply) => {
        const { reason, expectedVersion, changes, recordMetadata, actor, approvedBy } = req.body;
        if (actor.id === approvedBy.id) throw new ForbiddenError('The approver must be a different person from the requester');
        const result = await service.amendDocument({ id: req.params.id, reason, expectedVersion, changes, recordMetadata, actor, approvedBy });
        return reply.status(201).send(result);
    });
}
