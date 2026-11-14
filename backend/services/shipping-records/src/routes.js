import {
  actorOf,
  AppError,
  BadRequestError,
  ForbiddenError,
  OFFSET_SCHEMA,
  SERVICE_TOKEN_TYPE,
  UnauthorizedError,
  describeGuard,
  organisationOf,
} from '@lrfe/common';
import {CARGO_PART_ARGUMENTS} from '@lrfe/domain-shipping/title';

import {LIST_STATUSES} from './records.service.js';
import {OFFERED_COMMANDS} from './title.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = {type: 'string', format: 'uuid'};
const versionParam = {n: {type: 'integer', minimum: 1}};

/**
 * The path parameters of a record route.
 * @param {object} [extra] more parameters, e.g. the version number
 * @return {object}
 */
function idParams(extra = {}) {
  return {
    params: {
      type: 'object',
      required: ['id'],
      properties: {id: uuid, ...extra},
    },
  };
}

/** A B/L sent by a user: its format, the document in that format, its parties' organisations. */
const billOfLadingBody = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'document'],
  properties: {
    format: {type: 'string', minLength: 1, maxLength: 50},
    document: {type: 'object'},
    partyOrganisations: {type: 'object'},
  },
};

/** A review decision reported by bpm. */
const decisionBody = {
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
};

/** A new document of a B/L in a title command: its format, the document, its parties' links. */
const titleDocument = {
  type: 'object',
  required: ['format', 'document'],
  properties: {
    format: {type: 'string', minLength: 1, maxLength: 50},
    document: {type: 'object'},
    partyOrganisations: {type: 'object'},
  },
};

/**
 * The arguments of a title command (docs/title-states.md of the shipping pack): `to`, `inBlank`
 * and `confirmBearer` for endorse, transfer and switch-to-paper; an amendment's new document
 * (`format`, `document`, `partyOrganisations`); a split's `children`, one new document each
 * (CB-35). Anything else in the body (an organisation, an actor, a kind) is ignored: the
 * organisation is the session's, and an issue reads the kind and its parties from the B/L. A
 * release naming part of the cargo is refused (CB-35).
 */
const titleCommandBody = {
  type: 'object',
  properties: {
    to: {type: 'string', minLength: 1, maxLength: 100},
    inBlank: {type: 'boolean'},
    confirmBearer: {type: 'boolean'},
    format: {type: 'string', minLength: 1, maxLength: 50},
    document: {type: 'object'},
    partyOrganisations: {type: 'object'},
    children: {type: 'array', maxItems: 100, items: titleDocument},
  },
};

/**
 * The names of a title command's arguments: those titleCommandBody lists, and the ones naming
 * part of a cargo, which a release refuses.
 */
const TITLE_COMMAND_ARGUMENTS = [
  'to',
  'inBlank',
  'confirmBearer',
  'format',
  'document',
  'partyOrganisations',
  'children',
  ...CARGO_PART_ARGUMENTS,
];

/**
 * The engine's command of a title call: its name and only the arguments a command takes.
 * @param {string} name
 * @param {?Object} body
 * @return {{name: string}}
 */
function titleCommandOf(name, body) {
  const command = {name};
  for (const key of TITLE_COMMAND_ARGUMENTS) {
    if (body && Object.hasOwn(body, key)) {
      command[key] = body[key];
    }
  }
  return command;
}

/**
 * The permission a title command needs; 400 for a command the API does not know. The name comes
 * from the request, so it is only looked up in a Map.
 * @param {string} name
 * @return {string}
 */
function permissionOfCommand(name) {
  const permission = OFFERED_COMMANDS.get(name);
  if (permission !== undefined) {
    return permission;
  }
  throw new BadRequestError(`Unknown command: ${name}`, {
    code: 'unknown-command',
  });
}

/**
 * A title answer with only the commands the user's permissions allow: the title service lists
 * those of their organisation's role (carrier, holder), each command needing its permission too.
 * @param {{allowedCommands: !Array<string>}} view
 * @param {object} request
 * @return {!Object}
 */
function forUser(view, request) {
  const perms = request.user.perms ?? [];
  const allowed = view.allowedCommands.filter(name =>
    perms.includes(OFFERED_COMMANDS.get(name)),
  );
  return {...view, allowedCommands: allowed};
}

/**
 * The title service on the app; 503 when there is none.
 * @param {import('fastify').FastifyInstance} app
 * @return {import('./title.service.js').TitleService}
 */
function titlesOf(app) {
  if (!app.titles) {
    throw new AppError(503, 'The chain of title is not available');
  }
  return app.titles;
}

/**
 * The user's organisation, which owns the B/Ls they create and is the only one whose B/Ls they
 * see; 403 for a user who belongs to none.
 * @param {object} request
 * @return {string}
 */
function ownerOf(request) {
  const organisationId = organisationOf(request);
  if (!organisationId) {
    throw new ForbiddenError(
      'Your account belongs to no organisation, so it has no B/Ls',
    );
  }
  return organisationId;
}

/**
 * The organisation whose records the caller sees: the user's own, or null for a service (every
 * organisation's).
 * @param {object} request
 * @return {?string}
 */
function scopeOf(request) {
  if (request.user.typ === SERVICE_TOKEN_TYPE) {
    return null;
  }
  return ownerOf(request);
}

/**
 * Whether a cursor read back from the seals list is one it gave.
 * @param {*} after
 * @return {boolean}
 */
function isCursor(after) {
  if (!after || typeof after !== 'object') {
    return false;
  }
  const at = !Number.isNaN(Date.parse(after.at));
  return at && UUID.test(after.id ?? '') && Number.isInteger(after.version);
}

/**
 * The position `after` of the seals list, from its opaque cursor (base64url JSON); 400 for text
 * that is not a cursor of this list.
 * @param {string} [text]
 * @return {?{at: string, id: string, version: number}}
 */
function cursorFrom(text) {
  if (!text) {
    return null;
  }
  let after;
  try {
    after = JSON.parse(Buffer.from(text, 'base64url').toString());
  } catch {
    after = null;
  }
  if (!isCursor(after)) {
    throw new BadRequestError('Not a cursor from this list');
  }
  return after;
}

/**
 * The cursor to the page after these seals, or null on the last page.
 * @param {!Array<{recordId: string, version: number, at: (Date|string)}>} items
 * @param {number} limit
 * @return {?string}
 */
function nextCursor(items, limit) {
  if (items.length !== limit) {
    return null;
  }
  const last = items.at(-1);
  const position = {at: last.at, id: last.recordId, version: last.version};
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

/**
 * The shipping-records HTTP routes.
 * @param {import('fastify').FastifyInstance} app
 * @param {{service: import('./records.service.js').ShippingRecordsService}} options
 */
export async function recordsRoutes(app, {service}) {
  const canRead = app.requirePerm('bl.read');
  const canDraft = app.requirePerm('bl.draft');

  /**
   * Users who may read B/Ls (their organisation's), and the services named (every record).
   * @param {...string} services
   * @return {function(object, object): Promise<void>}
   */
  function canReadOrService(...services) {
    /**
     * Lets the services named through, and users who may read B/Ls.
     * @param {object} req
     * @param {object} reply
     * @return {!Promise<void>}
     */
    async function guard(req, reply) {
      try {
        await req.jwtVerify();
      } catch {
        throw new UnauthorizedError('Invalid or expired token');
      }
      if (req.user.typ === SERVICE_TOKEN_TYPE) {
        if (!services.includes(req.user.sub)) {
          throw new ForbiddenError('Not permitted', {service: req.user.sub});
        }
        return;
      }
      await canRead(req, reply);
    }
    return describeGuard(guard, {
      kind: 'user-or-service',
      allOf: ['bl.read'],
      services,
    });
  }
  // the callers of the record contract, as land-records allows them: audit reads, extracts reads
  // a record and a version
  const canReadOrAudit = canReadOrService('audit');
  const canReadOrAuditOrExtracts = canReadOrService('audit', 'extracts');

  // ------------------------------------------------ drafts (users of an organisation)

  app.post(
    '/records',
    {onRequest: canDraft, schema: {body: billOfLadingBody}},
    async (req, reply) => {
      const organisationId = ownerOf(req);
      const record = await service.createRecord(
        req.body,
        actorOf(req),
        organisationId,
      );
      return reply.code(201).send(record);
    },
  );

  app.put(
    '/records/:id/draft',
    {onRequest: canDraft, schema: {...idParams(), body: billOfLadingBody}},
    async req =>
      service.saveDraft(req.params.id, req.body, actorOf(req), ownerOf(req)),
  );

  app.post(
    '/records/:id/versions/:n/submit',
    {onRequest: canDraft, schema: idParams(versionParam)},
    async req =>
      service.submit(req.params.id, req.params.n, actorOf(req), ownerOf(req)),
  );

  // ------------------------------------------------ review decisions (bpm)

  app.post(
    '/records/:id/versions/:n/commit',
    {
      onRequest: app.requireService('bpm'),
      schema: {...idParams(versionParam), body: decisionBody},
    },
    async req =>
      service.commit(req.params.id, req.params.n, req.body, req.user.sub),
  );
  app.post(
    '/records/:id/versions/:n/reject',
    {
      onRequest: app.requireService('bpm'),
      schema: {...idParams(versionParam), body: decisionBody},
    },
    async req =>
      service.reject(req.params.id, req.params.n, req.body, req.user.sub),
  );

  // ------------------------------------------------ reading

  app.get(
    '/records',
    {
      onRequest: canReadOrAudit,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: {type: 'string', maxLength: 200},
            status: {type: 'string', enum: [...LIST_STATUSES]},
            limit: {type: 'integer', minimum: 1, maximum: 200, default: 50},
            offset: OFFSET_SCHEMA,
          },
        },
      },
    },
    async req => service.listRecords(req.query, scopeOf(req)),
  );

  // record labels and committed versions, for the audit service's Anchorings screens
  app.post(
    '/records/lookup',
    {
      onRequest: app.requireService('audit'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recordIds: {type: 'array', maxItems: 1000, items: uuid},
            // documents a version pins: a B/L version pins none
            pinning: {type: 'array', maxItems: 100, items: uuid},
            versions: {
              type: 'array',
              maxItems: 1000,
              items: {
                type: 'object',
                required: ['recordId', 'versionNumber'],
                additionalProperties: false,
                properties: {
                  recordId: uuid,
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

  // ------------------------------------------------ the chain of title (public)

  // the platform's public keys of the chain-of-title signatures, every key version: anyone may
  // check a chain with them, offline (CB-32)
  app.get('/records/title/keys', async () => titlesOf(app).keys());

  // ------------------------------------------------ the title (CB-34)

  // a B/L's title, the commands the caller may run on it now and its chain of title, for the
  // carrier, the current and past holders and the consignee
  app.get(
    '/records/:id/title',
    {onRequest: canRead, schema: idParams()},
    async req => {
      ownerOf(req);
      const view = await titlesOf(app).read(req.params.id, actorOf(req), {
        withChain: true,
      });
      return forUser(view, req);
    },
  );

  // a title command, run as the session's organisation: issue, void, release, deliver, amend and
  // split need bl.issue, endorse, transfer, surrender, surrender-for-amendment and switch-to-paper
  // bl.endorse
  app.post(
    '/records/:id/title/:command',
    {
      onRequest: app.requireAnyPerm('bl.issue', 'bl.endorse'),
      schema: {
        params: {
          type: 'object',
          required: ['id', 'command'],
          properties: {id: uuid, command: {type: 'string', maxLength: 50}},
        },
        body: titleCommandBody,
      },
    },
    async req => {
      const name = req.params.command;
      const permission = permissionOfCommand(name);
      if (!(req.user.perms ?? []).includes(permission)) {
        throw new ForbiddenError('Not permitted', {perm: permission});
      }
      ownerOf(req);
      const view = await titlesOf(app).apply(
        req.params.id,
        titleCommandOf(name, req.body),
        actorOf(req),
        {withChain: true},
      );
      return forUser(view, req);
    },
  );

  // a B/L's title proof (lrfe-title-proof/1, CB-33): its chain of title, the platform's keys and
  // the proof of the last entry (or entry `seq`) on the blockchain, for the parties who see the
  // title: the carrier, the current and past holders, the consignee
  app.get(
    '/records/:id/title/proof',
    {
      onRequest: canRead,
      schema: {
        ...idParams(),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {seq: {type: 'integer', minimum: 1}},
        },
      },
    },
    async req => {
      return titlesOf(app).proof(req.params.id, actorOf(req), {
        seq: req.query.seq,
      });
    },
  );

  // every committed version's seal, oldest first, for the audit service's backfill
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
      // `after`/`next`: an opaque cursor, the position of the last seal read
      const after = cursorFrom(req.query.after);
      const items = await service.listSeals({after, limit: req.query.limit});
      return {items, next: nextCursor(items, req.query.limit)};
    },
  );

  app.get(
    '/records/:id',
    {onRequest: canReadOrAuditOrExtracts, schema: idParams()},
    async req => service.getRecord(req.params.id, scopeOf(req)),
  );
  app.get(
    '/records/:id/versions',
    {onRequest: canReadOrAudit, schema: idParams()},
    async req => service.listVersions(req.params.id, scopeOf(req)),
  );
  app.get(
    '/records/:id/versions/:n',
    {onRequest: canReadOrAuditOrExtracts, schema: idParams(versionParam)},
    async req => service.getVersion(req.params.id, req.params.n, scopeOf(req)),
  );
  app.get(
    '/records/:id/verify',
    {onRequest: app.requireService('audit'), schema: idParams()},
    async req => service.verify(req.params.id),
  );
}
