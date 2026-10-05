const idParams = (extra = {}) => ({
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' }, ...extra } }
});
const versionParam = { n: { type: 'integer', minimum: 1 } };
const revision = { type: 'integer', minimum: 1 };
const uuid = { type: 'string', format: 'uuid' };
const actorOf = (req) => ({ id: req.user.sub, name: req.user.name });

export async function recordsRoutes(app, { service }) {
    const canView = app.requirePerm('record.view');

    app.get('/records/catalogue', { onRequest: app.authenticate }, async () => service.catalogue());

    app.get('/records', {
        onRequest: canView,
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: {
                    q: { type: 'string', maxLength: 200 },
                    status: { type: 'string', enum: ['draft', 'committed', 'in_review', 'needs_review'] },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    offset: { type: 'integer', minimum: 0, default: 0 }
                }
            }
        }
    }, async (req) => service.listRecords(req.query));

    // Filed documents for land records (edrms search, marking those already in a record)
    app.get('/records/document-search', {
        onRequest: canView,
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    q: { type: 'string', maxLength: 200 },
                    docType: { type: 'string', maxLength: 50 },
                    recordId: { type: 'string', format: 'uuid' },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
                },
                patternProperties: { '^field\\.[A-Za-z0-9_]+$': { type: 'string', maxLength: 200 } },
                additionalProperties: false
            }
        }
    }, async (req) => {
        const { q, docType, recordId, limit, ...rest } = req.query;
        const fields = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k.slice('field.'.length), v]));
        return service.searchDocuments({ q, docType, recordId, fields, limit });
    });

    // ------------------------------------------------ creating and editing (API-646)

    app.post('/records', {
        onRequest: app.requirePerm('record.create'),
        schema: {
            body: {
                type: 'object', additionalProperties: false,
                properties: { parcel: { type: 'object' }, attributes: { type: 'object' }, edrmsDocumentId: uuid },
                anyOf: [{ required: ['parcel'] }, { required: ['edrmsDocumentId'] }]
            }
        }
    }, async (req, reply) => reply.code(201).send(await service.createRecord(req.body, actorOf(req))));

    app.patch('/records/:id/draft', {
        onRequest: app.requireAnyPerm('record.create', 'record.link'),
        schema: {
            ...idParams(),
            body: {
                type: 'object', additionalProperties: false, required: ['revision'],
                properties: {
                    revision,
                    changes: { type: 'object' },
                    accept: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['owners', 'extent', 'encumbrances'] } },
                    reason: { type: 'string', minLength: 1, maxLength: 1000 }
                }
            }
        }
    }, async (req) => service.updateDraft(req.params.id, req.body, actorOf(req)));

    app.post('/records/:id/draft/documents', {
        onRequest: app.requirePerm('record.link'),
        schema: { ...idParams(), body: { type: 'object', additionalProperties: false, required: ['revision', 'edrmsDocumentId'], properties: { revision, edrmsDocumentId: uuid } } }
    }, async (req) => service.addDocument(req.params.id, req.body, actorOf(req)));

    app.delete('/records/:id/draft/documents/:edrmsDocumentId', {
        onRequest: app.requirePerm('record.unlink'),
        schema: {
            ...idParams({ edrmsDocumentId: uuid }),
            querystring: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision } }
        }
    }, async (req) => service.removeDocument(req.params.id, req.params.edrmsDocumentId, req.query, actorOf(req)));

    app.get('/records/:id/comments', { onRequest: canView, schema: idParams() }, async (req) => service.listComments(req.params.id));
    app.post('/records/:id/comments', {
        onRequest: app.requirePerm('record.comment'),
        schema: { ...idParams(), body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 4000 } } } }
    }, async (req, reply) => reply.code(201).send(await service.addComment(req.params.id, req.body, actorOf(req))));

    // ------------------------------------------------ review and commit (API-647)

    app.post('/records/:id/draft/submit', {
        onRequest: app.requirePerm('record.link'),
        schema: { ...idParams(), body: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision } } }
    }, async (req) => service.submit(req.params.id, req.body, actorOf(req)));

    app.post('/records/:id/draft/withdraw', { onRequest: app.requirePerm('record.link'), schema: idParams() },
        async (req) => service.withdraw(req.params.id, actorOf(req)));

    app.get('/records/:id/review', { onRequest: canView, schema: idParams() }, async (req) => service.review(req.params.id));

    // Decisions of the bpm "land-record-review" process (approval task done by a second person)
    const decision = {
        ...idParams(versionParam),
        body: {
            type: 'object', additionalProperties: false, required: ['by'],
            properties: {
                by: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' } } },
                comment: { type: 'string', maxLength: 4000 }
            }
        }
    };
    app.post('/records/:id/versions/:n/commit', { onRequest: app.requireService('bpm'), schema: decision },
        async (req) => service.commitFromReview(req.params.id, req.params.n, req.body, req.user.sub));
    app.post('/records/:id/versions/:n/reject', { onRequest: app.requireService('bpm'), schema: decision },
        async (req) => service.rejectFromReview(req.params.id, req.params.n, req.body, req.user.sub));

    // ------------------------------------------------ reading

    app.get('/records/:id', { onRequest: canView, schema: idParams() }, async (req) => service.getRecord(req.params.id));
    app.get('/records/:id/suggestions', { onRequest: canView, schema: idParams() }, async (req) => service.suggestions(req.params.id));
    app.get('/records/:id/versions', { onRequest: canView, schema: idParams() }, async (req) => service.listVersions(req.params.id));
    app.get('/records/:id/versions/:n', { onRequest: canView, schema: idParams(versionParam) }, async (req) => service.getVersion(req.params.id, req.params.n));
    app.get('/records/:id/verify', { onRequest: canView, schema: idParams() }, async (req) => service.verify(req.params.id));
}
