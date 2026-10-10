export async function auditRoutes(app, { service }) {
    const canView = app.requirePerm('audit.view');

    // trail entries: of a land record (with its documents' steps), a document, a user, a process
    app.get('/audit/trail', {
        onRequest: canView,
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: {
                    subject: { type: 'string', maxLength: 200 },
                    type: { type: 'string', maxLength: 100 },
                    from: { type: 'string', maxLength: 40 },
                    to: { type: 'string', maxLength: 40 },
                    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
                    offset: { type: 'integer', minimum: 0, default: 0 }
                }
            }
        }
    }, async (req) => service.list(req.query));

    // recompute the whole chain
    app.get('/audit/trail/verify', { onRequest: canView }, async () => service.verify());
}
