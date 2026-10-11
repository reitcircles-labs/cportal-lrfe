import { KINDS } from './proof.service.js';
import { CLOSE_OUTCOMES } from './signoff.service.js';
import { LIST_FILTERS } from './audit-list.service.js';
import { ANCHOR_FILTERS } from './anchorings.service.js';

export async function auditRoutes(app, { service, proofs, signoffs, evidence, auditList, anchorings, lookup }) {
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

    // ------------------------------------------------ anchorings (API-671): every signed-in user
    const canSeeAnchorings = app.requirePerm('anchors.view');

    // every batch put on the blockchain, newest first, with the counts of each filter and the next batch
    app.get('/audit/anchors', {
        onRequest: canSeeAnchorings,
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: {
                    status: { type: 'string', enum: ANCHOR_FILTERS, default: 'all' },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
                    offset: { type: 'integer', minimum: 0, default: 0 }
                }
            }
        }
    }, async (req) => anchorings.list(req.query));

    // "Is it on the blockchain?": a land record or document by number, Erf or deed number, with its batches (API-697)
    app.get('/audit/anchors/lookup', {
        onRequest: canSeeAnchorings,
        schema: { querystring: { type: 'object', required: ['q'], additionalProperties: false, properties: { q: { type: 'string', minLength: 1, maxLength: 100 } } } }
    }, async (req) => lookup.search(req.query.q, req.user.sub));

    // one batch: what is on the blockchain, its steps, and for a failed one why and what replaced it
    app.get('/audit/anchors/:batch', {
        onRequest: canSeeAnchorings,
        schema: { params: { type: 'object', required: ['batch'], properties: { batch: { type: 'integer', minimum: 1 } } } }
    }, async (req) => anchorings.detail(req.params.batch));

    // what one batch covers: counts by kind, and its land record versions with what they are made of (API-696)
    app.get('/audit/anchors/:batch/coverage', {
        onRequest: canSeeAnchorings,
        schema: {
            params: { type: 'object', required: ['batch'], properties: { batch: { type: 'integer', minimum: 1 } } },
            querystring: {
                type: 'object', additionalProperties: false,
                properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, offset: { type: 'integer', minimum: 0, default: 0 } }
            }
        }
    }, async (req) => anchorings.coverage(req.params.batch, req.query));

    // the document versions one batch put on the blockchain, with the land record versions made of them (API-696)
    app.get('/audit/anchors/:batch/documents', {
        onRequest: canSeeAnchorings,
        schema: {
            params: { type: 'object', required: ['batch'], properties: { batch: { type: 'integer', minimum: 1 } } },
            querystring: {
                type: 'object', additionalProperties: false,
                properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, offset: { type: 'integer', minimum: 0, default: 0 } }
            }
        }
    }, async (req) => anchorings.documents(req.params.batch, req.query));

    // ------------------------------------------------ sign-off and findings (README.md section 5)
    const canSignOff = app.requirePerm('audit.signoff');
    const actorOf = (req) => ({ id: req.user.sub, name: req.user.name, perms: req.user.perms || [] });
    const uuid = { type: 'string', format: 'uuid' };
    const target = { recordId: uuid, version: { type: 'integer', minimum: 1 }, documentId: uuid };
    const filter = { type: 'object', additionalProperties: false, properties: { recordId: uuid, documentId: uuid } };

    // the land records list of the Audit screen: filters, counts and a summary per record (API-661)
    app.get('/audit/records', {
        onRequest: canView,
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: {
                    q: { type: 'string', maxLength: 200 },
                    filter: { type: 'string', enum: LIST_FILTERS, default: 'changed' },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
                    offset: { type: 'integer', minimum: 0, default: 0 }
                }
            }
        }
    }, async (req) => auditList.list(req.query));

    // the open checkpoint of a land record: what the next audit sign-off covers, checked against the
    // blockchain, and whether the user asking may sign it off now (API-680)
    app.get('/audit/records/:id/check', {
        onRequest: canView,
        schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } }
    }, async (req) => signoffs.checkpoint(req.params.id, actorOf(req)));

    // one audit sign-off for every version committed since the last one (API-680)
    app.post('/audit/signoffs', {
        onRequest: canSignOff,
        schema: { body: { type: 'object', required: ['recordId'], additionalProperties: false, properties: { recordId: uuid, comment: { type: 'string', maxLength: 4000 } } } }
    }, async (req, reply) => reply.status(201).send(await signoffs.signOff(req.body, actorOf(req))));

    app.get('/audit/signoffs', { onRequest: canView, schema: { querystring: filter } }, async (req) => ({ items: await signoffs.listSignoffs(req.query) }));

    // a finding on a land record version or a document version: the records desk is notified
    app.post('/audit/findings', {
        onRequest: canSignOff,
        schema: { body: { type: 'object', required: ['version', 'description'], additionalProperties: false, properties: { ...target, description: { type: 'string', maxLength: 4000 } } } }
    }, async (req, reply) => reply.status(201).send(await signoffs.raiseFinding(req.body, actorOf(req))));

    // findings are seen by auditors and by the records desk (records officers, registrars)
    const canSeeFindings = app.requireAnyPerm('audit.view', 'record.view');
    app.get('/audit/findings', {
        onRequest: canSeeFindings,
        schema: { querystring: { ...filter, properties: { ...filter.properties, status: { type: 'string', enum: ['open', 'resolved', 'closed'] } } } }
    }, async (req) => ({ items: await signoffs.listFindings(req.query) }));

    app.get('/audit/findings/:id', { onRequest: canSeeFindings, schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } },
        async (req) => signoffs.getFinding(req.params.id));

    // only auditors answer and close a finding: any auditor, not only the one who raised it (API-680)
    app.post('/audit/findings/:id/answers', {
        onRequest: canSignOff,
        schema: {
            params: { type: 'object', required: ['id'], properties: { id: uuid } },
            body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 4000 } } }
        }
    }, async (req, reply) => reply.status(201).send(await signoffs.answerFinding(req.params.id, req.body, actorOf(req))));

    // closing answers the finding: resolved by agreement outside the portal, or raised by mistake
    app.post('/audit/findings/:id/close', {
        onRequest: canSignOff,
        schema: {
            params: { type: 'object', required: ['id'], properties: { id: uuid } },
            body: {
                type: 'object', additionalProperties: false,
                anyOf: [{ required: ['answer'] }, { required: ['reason'] }],
                properties: { outcome: { type: 'string', enum: CLOSE_OUTCOMES }, answer: { type: 'string', maxLength: 4000 }, reason: { type: 'string', maxLength: 2000 } }
            }
        }
    }, async (req) => signoffs.closeFinding(req.params.id, req.body, actorOf(req)));

    // ------------------------------------------------ evidence pack (README.md section 6)
    app.get('/audit/records/:id/evidence', {
        onRequest: app.requirePerm('audit.export'),
        schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } }
    }, async (req, reply) => {
        const pack = await evidence.build(req.params.id, actorOf(req));
        reply.header('content-type', 'application/zip');
        reply.header('content-disposition', `attachment; filename="${pack.fileName}"`);
        reply.header('x-manifest-sha256', pack.manifestSha256);
        reply.header('cache-control', 'no-store');
        return reply.send(pack.zip);
    });
}
