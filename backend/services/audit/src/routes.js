import { KINDS } from './proof.service.js';

export async function auditRoutes(app, { service, proofs }) {
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

    const item = {
        kind: { type: 'string', enum: KINDS },
        id: { type: 'string', maxLength: 64 },
        version: { type: 'integer', minimum: 1 }
    };

    // the proof of a land record version, a document version or a trail entry (README.md section 4)
    app.get('/audit/proofs/:kind/:id', {
        onRequest: canView,
        schema: {
            params: { type: 'object', required: ['kind', 'id'], properties: { kind: item.kind, id: item.id } },
            querystring: { type: 'object', additionalProperties: false, properties: { version: item.version } }
        }
    }, async (req) => proofs.proof(req.params.kind, req.params.id, req.query.version));

    // check an item now: its seal from the current data, the path, the root on the chain
    app.post('/audit/verify', {
        onRequest: canView,
        schema: { body: { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: item } }
    }, async (req) => proofs.verify(req.body.kind, req.body.id, req.body.version));

    // the anchoring status of versions, for land-records and edrms to show next to them
    app.post('/audit/anchoring', {
        onRequest: app.requireService('land-records', 'edrms'),
        schema: {
            body: {
                type: 'object', required: ['keys'], additionalProperties: false,
                properties: { keys: { type: 'array', maxItems: 500, items: { type: 'string', pattern: '^(record|document)-version:[0-9a-fA-F-]{36}:[1-9][0-9]{0,8}$' } } }
            }
        }
    }, async (req) => ({ items: await proofs.statusOf(req.body.keys) }));
}
