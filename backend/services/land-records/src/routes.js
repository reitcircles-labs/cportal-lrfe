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

    app.get('/records/:id', { onRequest: canView, schema: idParams() }, async (req) => service.getRecord(req.params.id));
    app.get('/records/:id/versions', { onRequest: canView, schema: idParams() }, async (req) => service.listVersions(req.params.id));
    app.get('/records/:id/versions/:n', { onRequest: canView, schema: idParams(versionParam) }, async (req) => service.getVersion(req.params.id, req.params.n));
    app.get('/records/:id/verify', { onRequest: canView, schema: idParams() }, async (req) => service.verify(req.params.id));
}
