import { actorOf, BadRequestError, NotFoundError } from '@lrfe/common';
import { DOC_TYPES } from './doc-types.js';

const READ = ['capture.view', 'verify.view'];
const uuid = { type: 'string', format: 'uuid' };
const idParams = (extra = {}) => ({ params: { type: 'object', required: ['id'], properties: { id: uuid, ...extra } } });

/**
 * Intake HTTP API; the gateway exposes it under /api/intake (e.g. GET /api/intake/documents).
 * Capture needs capture.scan; review needs verify.edit; filing and rejecting need verify.file.
 */
export async function intakeRoutes(app, { service, links, fileLinkBase, linkTtlSeconds }) {
    const readGuard = { onRequest: app.requireAnyPerm(...READ) };

    app.get('/catalogue', { onRequest: app.authenticate }, async () => ({
        docTypes: DOC_TYPES.map(({ id, label, refField, fields }) => ({ id, label, refField, fields: fields.map(({ k, label, type, required }) => ({ k, label, type, required })) }))
    }));

    // ------------------------------------------------------------------ batches & capture

    app.get('/batches', readGuard, async () => ({ batches: await service.listBatches() }));

    app.post('/batches', {
        onRequest: app.requirePerm('capture.scan'),
        schema: { body: { type: 'object', additionalProperties: false, properties: { source: { type: 'string', maxLength: 200 } } } }
    }, async (req, reply) => reply.status(201).send(await service.createBatch(req.body || {}, actorOf(req))));

    /** multipart/form-data with one `file` (PDF, PNG or JPEG). */
    app.post('/batches/:batchId/documents', {
        onRequest: app.requirePerm('capture.scan'),
        schema: { params: { type: 'object', properties: { batchId: { type: 'string', maxLength: 40 } } } }
    }, async (req, reply) => {
        if (!req.isMultipart()) throw new BadRequestError('Send the file as multipart/form-data in a field named "file"');
        const part = await req.file();
        if (!part || part.fieldname !== 'file') throw new BadRequestError('Send the file in a field named "file"');
        const doc = await service.captureDocument({ batchId: req.params.batchId, file: { stream: part.file, fileName: part.filename, mimeType: part.mimetype } }, actorOf(req));
        return reply.status(201).send(doc);
    });

    // ------------------------------------------------------------------ documents

    app.get('/documents', {
        ...readGuard,
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: {
                    batchId: { type: 'string' }, q: { type: 'string', maxLength: 200 },
                    status: { type: 'string', pattern: '^(queued|extracting|ready|failed|filed|rejected)(,(queued|extracting|ready|failed|filed|rejected))*$' },
                    limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 }, offset: { type: 'integer', minimum: 0, default: 0 }
                }
            }
        }
    }, async (req) => service.listDocuments({ ...req.query, status: req.query.status?.split(',') }));

    app.get('/documents/:id', { ...readGuard, schema: idParams() }, async (req) => service.getDocument(req.params.id));
    app.get('/documents/:id/events', { ...readGuard, schema: idParams() }, async (req) => ({ events: await service.listEvents(req.params.id) }));

    /** A short-lived link for the viewer (the browser cannot add an Authorization header to <iframe>/<img>). */
    app.get('/documents/:id/file-link', { ...readGuard, schema: idParams() }, async (req) => {
        await service.requireDocument(req.params.id);
        const { exp, sig } = links.sign(req.params.id, linkTtlSeconds);
        return { url: `${fileLinkBase}/${req.params.id}?exp=${exp}&sig=${sig}`, expiresIn: linkTtlSeconds };
    });

    app.get('/files/:id', {
        schema: { ...idParams(), querystring: { type: 'object', required: ['exp', 'sig'], properties: { exp: { type: 'integer' }, sig: { type: 'string' } } } }
    }, async (req, reply) => {
        if (!links.verify(req.params.id, req.query.exp, req.query.sig)) throw new NotFoundError('Link expired or invalid');
        const f = await service.openFile(req.params.id);
        reply.header('content-type', f.mimeType);
        reply.header('content-disposition', `inline; filename="${f.fileName}"`);
        reply.header('cache-control', 'private, max-age=300');
        return reply.send(f.stream);
    });

    // ------------------------------------------------------------------ review

    const edit = { onRequest: app.requirePerm('verify.edit') };
    app.post('/documents/:id/claim', { ...edit, schema: idParams() }, async (req) => service.summary(await service.claim(req.params.id, actorOf(req))));
    app.post('/documents/:id/release', { ...edit, schema: idParams() }, async (req) => service.release(req.params.id, actorOf(req)));

    app.put('/documents/:id/fields/:k', {
        ...edit,
        schema: {
            ...idParams({ k: { type: 'string', pattern: '^[A-Za-z0-9]+$' } }),
            body: { type: 'object', additionalProperties: false, properties: { value: { type: 'string', maxLength: 2000 }, status: { type: 'string', enum: ['accepted', 'pending'] } } }
        }
    }, async (req) => service.updateField(req.params.id, req.params.k, req.body || {}, actorOf(req)));

    app.post('/documents/:id/accept-clean', { ...edit, schema: idParams() }, async (req) => service.acceptClean(req.params.id, actorOf(req)));

    app.post('/documents/:id/extract', {
        ...edit,
        schema: { ...idParams(), body: { type: 'object', additionalProperties: false, properties: { escalate: { type: 'boolean' } } } }
    }, async (req) => service.requestExtraction(req.params.id, req.body || {}, actorOf(req)));

    // ------------------------------------------------------------------ outcome

    app.post('/documents/:id/file', { onRequest: app.requirePerm('verify.file'), schema: idParams() },
        async (req) => service.fileDocument(req.params.id, actorOf(req)));

    app.post('/documents/:id/reject', {
        onRequest: app.requirePerm('verify.file'),
        schema: { ...idParams(), body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } } } }
    }, async (req) => service.rejectDocument(req.params.id, req.body.reason, actorOf(req)));

    // ------------------------------------------------------------------ cost

    app.get('/usage', {
        onRequest: app.requireAnyPerm('admin.policies', 'audit.view'),
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } } } }
    }, async (req) => service.usage(req.query));
}
