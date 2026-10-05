const idParams = (extra = {}) => ({
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' }, ...extra } }
});
const versionParam = { n: { type: 'integer', minimum: 1 } };

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

    app.get('/records/:id', { onRequest: canView, schema: idParams() }, async (req) => service.getRecord(req.params.id));
    app.get('/records/:id/suggestions', { onRequest: canView, schema: idParams() }, async (req) => service.suggestions(req.params.id));
    app.get('/records/:id/versions', { onRequest: canView, schema: idParams() }, async (req) => service.listVersions(req.params.id));
    app.get('/records/:id/versions/:n', { onRequest: canView, schema: idParams(versionParam) }, async (req) => service.getVersion(req.params.id, req.params.n));
    app.get('/records/:id/verify', { onRequest: canView, schema: idParams() }, async (req) => service.verify(req.params.id));
}
