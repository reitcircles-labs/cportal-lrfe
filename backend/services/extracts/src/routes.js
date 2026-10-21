const uuid = {type: 'string', format: 'uuid'};
const actorOf = req => ({id: req.user.sub, name: req.user.name});

/** The extracts HTTP routes: issuing, listing, downloading again and revoking ownership extracts (staff). */
export async function extractsRoutes(app, {service}) {
  const canIssue = app.requirePerm('extract.issue');

  // an extract of the record's current version, for one of its owners, checked against their
  // identity document
  app.post(
    '/extracts',
    {
      onRequest: canIssue,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'recordId',
            'versionNumber',
            'ownerIndex',
            'idNo',
            'documentSeen',
          ],
          properties: {
            recordId: uuid,
            versionNumber: {type: 'integer', minimum: 1},
            ownerIndex: {type: 'integer', minimum: 0},
            idNo: {type: 'string', minLength: 1, maxLength: 40},
            documentSeen: {type: 'boolean'},
          },
        },
      },
    },
    async (req, reply) =>
      reply.code(201).send(await service.issue(req.body, actorOf(req))),
  );

  app.get(
    '/extracts',
    {
      onRequest: canIssue,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['recordId'],
          properties: {recordId: uuid},
        },
      },
    },
    async req => service.listForRecord(req.query.recordId),
  );

  // "Download again": the sealed PDF as issued, the same bytes
  app.get(
    '/extracts/:id/pdf',
    {
      onRequest: canIssue,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {id: uuid},
        },
      },
    },
    async (req, reply) => {
      const {extract, pdf} = await service.pdf(req.params.id);
      return reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `attachment; filename="extract-${extract.recordNo}-v${extract.versionNumber}.pdf"`,
        )
        .header('cache-control', 'no-store')
        .send(pdf);
    },
  );

  app.post(
    '/extracts/:id/revoke',
    {
      onRequest: canIssue,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {id: uuid},
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {reason: {type: 'string', minLength: 1, maxLength: 1000}},
        },
      },
    },
    async req => service.revoke(req.params.id, req.body, actorOf(req)),
  );
}

/**
 * The public check of an extract (API-693), from its QR code: no sign-in, through the gateway's
 * rate-limited /api/public prefix. Every check is logged with its state and the extract's id only.
 */
export async function publicRoutes(app, {check}) {
  app.get(
    '/public/extracts/:token',
    {
      schema: {
        params: {
          type: 'object',
          required: ['token'],
          properties: {token: {type: 'string'}},
        },
      },
    },
    async (req, reply) => {
      const {answer, reason} = await check.check(req.params.token);
      req.log.info(
        {extractId: answer.extractId, state: answer.state, reason},
        'extract checked',
      );
      reply.header('cache-control', 'no-store');
      return answer;
    },
  );
}
