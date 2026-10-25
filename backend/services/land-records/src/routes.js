import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
  describeGuard,
} from '@lrfe/common';

const idParams = (extra = {}) => ({
  params: {
    type: 'object',
    required: ['id'],
    properties: {id: {type: 'string', format: 'uuid'}, ...extra},
  },
});
const versionParam = {n: {type: 'integer', minimum: 1}};
const revision = {type: 'integer', minimum: 1};
const uuid = {type: 'string', format: 'uuid'};
const actorOf = req => ({id: req.user.sub, name: req.user.name});
/** Whether the user may read intake's documents, so a search may show those still in intake (API-803). */
const readsIntake = req =>
  ['capture.view', 'verify.view'].some(p => (req.user.perms ?? []).includes(p));

/** The land-records HTTP routes. */
export async function recordsRoutes(app, {service}) {
  const canView = app.requirePerm('record.view');
  /** Users who may view records, and the services named. */
  function canViewOrService(...services) {
    async function guard(req, reply) {
      try {
        await req.jwtVerify();
      } catch {
        throw new UnauthorizedError('Invalid or expired token');
      }
      if (req.user.typ === 'service') {
        if (!services.includes(req.user.sub)) {
          throw new ForbiddenError('Not permitted', {service: req.user.sub});
        }
        return;
      }
      return canView(req, reply);
    }
    return describeGuard(guard, {
      kind: 'user-or-service',
      allOf: ['record.view'],
      services,
    });
  }
  // the audit service: verifying a proof (API-658), reading a version's approver and documents for
  // a sign-off or finding (API-659), the evidence pack (API-660), the Audit screen's list (API-661)
  const canViewOrAudit = canViewOrService('audit');
  // also the extracts service: the current version's owners, before an extract is issued (API-692),
  // and when the version after an extract's was committed, for its public check (API-693)
  const canViewOrAuditOrExtracts = canViewOrService('audit', 'extracts');

  app.get('/records/catalogue', {onRequest: app.authenticate}, async () =>
    service.catalogue(),
  );

  // also for the audit service: the land records list of the Audit screen (API-661)
  app.get(
    '/records',
    {
      onRequest: canViewOrAudit,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: {type: 'string', maxLength: 200},
            status: {
              type: 'string',
              enum: [
                'draft',
                'committed',
                'in_review',
                'needs_review',
                'new_document',
                'in_bin',
              ],
            },
            match: {type: 'string', enum: ['all', 'parcel'], default: 'all'},
            limit: {type: 'integer', minimum: 1, maximum: 200, default: 50},
            offset: {type: 'integer', minimum: 0, default: 0},
          },
        },
      },
    },
    async req => service.listRecords(req.query),
  );

  // Filed documents for land records (edrms search, marking those already in a record)
  app.get(
    '/records/document-search',
    {
      onRequest: canView,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: {type: 'string', maxLength: 200},
            docType: {type: 'string', maxLength: 50},
            recordId: {type: 'string', format: 'uuid'},
            limit: {type: 'integer', minimum: 1, maximum: 200, default: 50},
          },
          patternProperties: {
            '^field\\.[A-Za-z0-9_]+$': {type: 'string', maxLength: 200},
          },
          additionalProperties: false,
        },
      },
    },
    async req => {
      const {q, docType, recordId, limit, ...rest} = req.query;
      const fields = Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k.slice('field.'.length), v]),
      );
      return service.searchDocuments({
        q,
        docType,
        recordId,
        fields,
        limit,
        intake: readsIntake(req),
      });
    },
  );

  // One filed document's metadata, for its Details popover (API-765)
  app.get(
    '/records/document-details/:edrmsDocumentId',
    {
      onRequest: canView,
      schema: {
        params: {
          type: 'object',
          required: ['edrmsDocumentId'],
          properties: {edrmsDocumentId: uuid},
        },
      },
    },
    async req => service.documentDetails(req.params.edrmsDocumentId),
  );

  // ------------------------------------------------ creating and editing (API-646)

  // Before creating: the parcel read from a document, the documents about it, an existing record (API-765)
  app.post(
    '/records/preview',
    {
      onRequest: app.requirePerm('record.create'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {parcel: {type: 'object'}, edrmsDocumentId: uuid},
          anyOf: [{required: ['parcel']}, {required: ['edrmsDocumentId']}],
        },
      },
    },
    async req => service.createPreview(req.body),
  );

  app.post(
    '/records',
    {
      onRequest: app.requirePerm('record.create'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            parcel: {type: 'object'},
            attributes: {type: 'object'},
            edrmsDocumentId: uuid,
          },
          anyOf: [{required: ['parcel']}, {required: ['edrmsDocumentId']}],
        },
      },
    },
    async (req, reply) =>
      reply.code(201).send(await service.createRecord(req.body, actorOf(req))),
  );

  app.patch(
    '/records/:id/draft',
    {
      onRequest: app.requireAnyPerm('record.create', 'record.link'),
      schema: {
        ...idParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['revision'],
          properties: {
            revision,
            changes: {type: 'object'},
            accept: {
              type: 'array',
              uniqueItems: true,
              items: {
                type: 'string',
                enum: ['owners', 'extent', 'encumbrances'],
              },
            },
            reason: {type: 'string', minLength: 1, maxLength: 1000},
          },
        },
      },
    },
    async req => service.updateDraft(req.params.id, req.body, actorOf(req)),
  );

  app.post(
    '/records/:id/draft/documents',
    {
      onRequest: app.requirePerm('record.link'),
      schema: {
        ...idParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'edrmsDocumentId'],
          properties: {revision, edrmsDocumentId: uuid},
        },
      },
    },
    async req => service.addDocument(req.params.id, req.body, actorOf(req)),
  );

  app.delete(
    '/records/:id/draft/documents/:edrmsDocumentId',
    {
      onRequest: app.requirePerm('record.unlink'),
      schema: {
        ...idParams({edrmsDocumentId: uuid}),
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['revision'],
          properties: {revision},
        },
      },
    },
    async req =>
      service.removeDocument(
        req.params.id,
        req.params.edrmsDocumentId,
        req.query,
        actorOf(req),
      ),
  );

  // ------------------------------------------------ changes after a commit (API-648)

  app.post(
    '/records/:id/draft',
    {
      onRequest: app.requireAnyPerm('record.create', 'record.link'),
      schema: idParams(),
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(await service.openDraft(req.params.id, actorOf(req))),
  );

  app.post(
    '/records/:id/draft/documents/:edrmsDocumentId/refresh',
    {
      onRequest: app.requirePerm('record.link'),
      schema: {
        ...idParams({edrmsDocumentId: uuid}),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['revision'],
          properties: {revision},
        },
      },
    },
    async req =>
      service.refreshDocument(
        req.params.id,
        req.params.edrmsDocumentId,
        req.body,
        actorOf(req),
      ),
  );

  app.get(
    '/records/:id/history',
    {onRequest: canView, schema: idParams()},
    async req => service.history(req.params.id),
  );

  app.get(
    '/records/:id/comments',
    {onRequest: canView, schema: idParams()},
    async req => service.listComments(req.params.id),
  );
  app.post(
    '/records/:id/comments',
    {
      onRequest: app.requirePerm('record.comment'),
      schema: {
        ...idParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['body'],
          properties: {body: {type: 'string', minLength: 1, maxLength: 4000}},
        },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(await service.addComment(req.params.id, req.body, actorOf(req))),
  );

  // ------------------------------------------------ review and commit (API-647)

  app.post(
    '/records/:id/draft/submit',
    {
      onRequest: app.requirePerm('record.link'),
      schema: {
        ...idParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['revision'],
          properties: {revision},
        },
      },
    },
    async req => service.submit(req.params.id, req.body, actorOf(req)),
  );

  app.post(
    '/records/:id/draft/withdraw',
    {onRequest: app.requirePerm('record.link'), schema: idParams()},
    async req => service.withdraw(req.params.id, actorOf(req)),
  );

  // the bin (API-767): a record never approved moved there and back, an abandoned change discarded
  const withReason = {
    ...idParams(),
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: {reason: {type: 'string', minLength: 1, maxLength: 1000}},
    },
  };
  app.post(
    '/records/:id/bin',
    {onRequest: app.requirePerm('record.create'), schema: withReason},
    async req => service.moveToBin(req.params.id, req.body, actorOf(req)),
  );
  app.post(
    '/records/:id/restore',
    {onRequest: app.requirePerm('record.create'), schema: idParams()},
    async req => service.restoreFromBin(req.params.id, actorOf(req)),
  );
  app.post(
    '/records/:id/draft/discard',
    {onRequest: app.requirePerm('record.create'), schema: withReason},
    async req => service.discardDraft(req.params.id, req.body, actorOf(req)),
  );

  // a "new document" flag dismissed, with the reason (API-766)
  app.post(
    '/records/:id/flags/dismiss',
    {
      onRequest: app.requirePerm('record.link'),
      schema: {
        ...idParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['edrmsDocumentId', 'reason'],
          properties: {
            edrmsDocumentId: uuid,
            reason: {type: 'string', minLength: 1, maxLength: 1000},
          },
        },
      },
    },
    async req => service.dismissFlag(req.params.id, req.body, actorOf(req)),
  );

  app.get(
    '/records/:id/review',
    {onRequest: canView, schema: idParams()},
    async req => service.review(req.params.id),
  );

  // Decisions of the bpm "land-record-review" process (approval task done by a second person)
  const decision = {
    ...idParams(versionParam),
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['by'],
      properties: {
        by: {
          type: 'object',
          required: ['id'],
          properties: {
            id: {type: 'string', minLength: 1},
            name: {type: 'string'},
          },
        },
        comment: {type: 'string', maxLength: 4000},
      },
    },
  };
  app.post(
    '/records/:id/versions/:n/commit',
    {onRequest: app.requireService('bpm'), schema: decision},
    async req =>
      service.commitFromReview(
        req.params.id,
        req.params.n,
        req.body,
        req.user.sub,
      ),
  );
  app.post(
    '/records/:id/versions/:n/reject',
    {onRequest: app.requireService('bpm'), schema: decision},
    async req =>
      service.rejectFromReview(
        req.params.id,
        req.params.n,
        req.body,
        req.user.sub,
      ),
  );

  // ------------------------------------------------ reading

  // land record labels, the documents each committed version is made of, and the committed versions
  // that pin given documents, for the audit service's Anchorings screens (API-696, API-697)
  app.post(
    '/records/lookup',
    {
      onRequest: app.requireService('audit'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recordIds: {
              type: 'array',
              maxItems: 1000,
              items: {type: 'string', format: 'uuid'},
            },
            pinning: {
              type: 'array',
              maxItems: 100,
              items: {type: 'string', format: 'uuid'},
            },
            versions: {
              type: 'array',
              maxItems: 1000,
              items: {
                type: 'object',
                required: ['recordId', 'versionNumber'],
                additionalProperties: false,
                properties: {
                  recordId: {type: 'string', format: 'uuid'},
                  versionNumber: {type: 'integer', minimum: 1},
                },
              },
            },
          },
        },
      },
    },
    async req => service.lookup(req.body),
  );

  // every committed version's seal, oldest first, for the audit service's backfill (API-669)
  app.get(
    '/records/seals',
    {
      onRequest: app.requireService('audit'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            after: {type: 'string', maxLength: 300},
            limit: {type: 'integer', minimum: 1, maximum: 1000, default: 500},
          },
        },
      },
    },
    async req => {
      // `after`/`next`: an opaque cursor, the position of the last seal read (base64url JSON)
      let after = null;
      if (req.query.after) {
        try {
          after = JSON.parse(
            Buffer.from(req.query.after, 'base64url').toString(),
          );
        } catch {
          after = null;
        }
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (
          !after ||
          Number.isNaN(Date.parse(after.at)) ||
          !uuid.test(after.id ?? '') ||
          !Number.isInteger(after.version)
        ) {
          throw new BadRequestError('Not a cursor from this list');
        }
      }
      const items = await service.listSeals({after, limit: req.query.limit});
      const last = items.at(-1);
      return {
        items,
        next:
          items.length === req.query.limit
            ? Buffer.from(
                JSON.stringify({
                  at: last.at,
                  id: last.recordId,
                  version: last.version,
                }),
              ).toString('base64url')
            : null,
      };
    },
  );

  app.get(
    '/records/:id',
    {onRequest: canViewOrAuditOrExtracts, schema: idParams()},
    async req => service.getRecord(req.params.id),
  );
  app.get(
    '/records/:id/suggestions',
    {onRequest: canView, schema: idParams()},
    async req => service.suggestions(req.params.id, {intake: readsIntake(req)}),
  );
  app.get(
    '/records/:id/versions',
    {onRequest: canViewOrAudit, schema: idParams()},
    async req => service.listVersions(req.params.id),
  );
  app.get(
    '/records/:id/versions/:n',
    {onRequest: canViewOrAuditOrExtracts, schema: idParams(versionParam)},
    async req => service.getVersion(req.params.id, req.params.n),
  );
  app.get(
    '/records/:id/verify',
    {onRequest: canViewOrAudit, schema: idParams()},
    async req => service.verify(req.params.id),
  );
}
