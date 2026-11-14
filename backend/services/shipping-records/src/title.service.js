import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  sha256Hex,
  signJws,
} from '@lrfe/common';
import {billOfLadingHash} from '@lrfe/domain-shipping/bill-of-lading';
import {
  TitleRefusal,
  allowedCommands,
  applyTitleCommand,
  kindOf,
} from '@lrfe/domain-shipping/title';

import {TITLE_ENTRY_TYP, entryHashOf} from './chain.js';

/**
 * The title commands the API offers (CB-34), each with the permission it needs: the carrier's
 * staff hold `bl.issue`, the holder's `bl.endorse`. The amendment and the split come with CB-35.
 * @type {!ReadonlyMap<string, string>}
 */
export const OFFERED_COMMANDS = new Map([
  ['issue', 'bl.issue'],
  ['void', 'bl.issue'],
  ['release', 'bl.issue'],
  ['deliver', 'bl.issue'],
  ['endorse', 'bl.endorse'],
  ['transfer', 'bl.endorse'],
  ['surrender', 'bl.endorse'],
  ['switch-to-paper', 'bl.endorse'],
]);

/** The engine's commands the API does not offer yet (CB-35). */
export const LATER_COMMANDS = new Set([
  'surrender-for-amendment',
  'amend',
  'split',
]);

/** The refusals answered 403: the organisation may not run the command. */
const FORBIDDEN_REFUSALS = new Set([
  'no-organisation',
  'not-carrier',
  'not-holder',
]);

/** The refusals answered 400: the command or its arguments are wrong, whatever the title. */
const BAD_REQUEST_REFUSALS = new Set([
  'unknown-command',
  'unknown-kind',
  'missing-shipper',
  'missing-recipient',
  'invalid-argument',
  'too-few-children',
]);

/**
 * The answer to a refused command: 403 for the wrong organisation, 400 for a wrong command or
 * argument, 409 for every other refusal (the module, the kind or the state). The reason is the
 * engine's, its code in `details`.
 * @param {!TitleRefusal} refusal
 * @return {!Error}
 */
function errorOf(refusal) {
  const details = {code: refusal.code};
  if (FORBIDDEN_REFUSALS.has(refusal.code)) {
    return new ForbiddenError(refusal.message, details);
  }
  if (BAD_REQUEST_REFUSALS.has(refusal.code)) {
    return new BadRequestError(refusal.message, details);
  }
  return new ConflictError(refusal.message, details);
}

/**
 * The 409 for a title another command changed since it was read.
 * @return {!ConflictError}
 */
function changedMeanwhile() {
  return new ConflictError('This B/L changed meanwhile: read it again', {
    code: 'changed-meanwhile',
  });
}

/**
 * The 503 while the platform cannot sign chain entries (production without a signing key): title
 * commands are refused, never run unsigned. Shown to users, so no settings named.
 * @return {!AppError}
 */
function notSetUp() {
  return new AppError(
    503,
    'Title commands are not available yet: the platform signature is not set up. Tell the administrator.',
    {code: 'not-set-up'},
  );
}

/** The format of a title proof bundle (docs/chain-of-title.md of the shipping pack). */
export const TITLE_PROOF_FORMAT = 'lrfe-title-proof/1';

/** The type of the event a chain entry is published as, before its command. */
const TITLE_EVENT_PREFIX = 'records.title.';

/**
 * The id of the event a chain entry is published as: a uuid made from the B/L and the entry's seq
 * (SHA-256, RFC 9562 version 8), so the service finds the entry's event on the audit trail again
 * without storing it, and a replayed event is the same event.
 * @param {string} recordId
 * @param {number} seq
 * @return {string}
 */
export function titleEventIdOf(recordId, seq) {
  const hex = sha256Hex(`${TITLE_EVENT_PREFIX}${recordId}:${seq}`);
  // RFC 9562 variant: the top two bits of the 17th hex digit are 10.
  const variantBits = parseInt(hex[16], 16) & 0x3;
  const variant = (variantBits | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The 503 while the proof on the blockchain cannot be read (the audit service down or failing):
 * never answered as "pending", which would not be true. Shown to users, so no service named.
 * @param {!Error} cause
 * @return {!AppError}
 */
function proofUnavailable(cause) {
  const error = new AppError(
    503,
    'The proof on the blockchain cannot be read now: try again later.',
    {code: 'proof-unavailable'},
  );
  error.cause = cause;
  return error;
}

/**
 * The 422 for an organisation a B/L cannot go to: not registered on the platform, or not active.
 * @param {string} message
 * @return {!AppError}
 */
function unregistered(message) {
  return new AppError(422, message, {code: 'unregistered-organisation'});
}

/**
 * The 503 while the organisations cannot be checked (identity down or failing). Shown to users,
 * so no service named.
 * @param {!Error} cause
 * @return {!AppError}
 */
function organisationsUnavailable(cause) {
  const error = new AppError(
    503,
    'The organisations cannot be checked now: try again later.',
    {code: 'organisations-unavailable'},
  );
  error.cause = cause;
  return error;
}

/**
 * The 404 of a B/L the caller does not see, the same as the record service's.
 * @return {!NotFoundError}
 */
function notFound() {
  return new NotFoundError('B/L not found');
}

/**
 * The engine's title of a stored title, or null before issue.
 * @param {?object} stored
 * @return {?object} the engine's Title (@lrfe/domain-shipping/title)
 */
function titleOf(stored) {
  if (stored === null) {
    return null;
  }
  return {
    kind: stored.kind,
    state: stored.state,
    carrier: stored.carrier,
    holder: stored.holder ?? null,
    endorsement: stored.endorsement,
    consignee: stored.consignee ?? null,
    returnTo: stored.returnTo ?? null,
  };
}

/**
 * The engine's actor: the organisation of the person running a command.
 * @param {{id: string, name?: string, org?: string}} actor
 * @return {{organisation: (string|undefined)}}
 */
function engineActor(actor) {
  return {organisation: actor?.org};
}

/**
 * Whether an organisation sees a B/L's title: before issue the record's owner; after it the
 * carrier, the current holder, a past holder (any organisation the chain of title moved the B/L
 * from or to) or the consignee.
 * @param {{organisationId: string}} record
 * @param {?object} stored the stored title, null before issue
 * @param {!Array<{from: ?string, to: ?string}>} chain the B/L's chain of title
 * @param {(string|undefined)} organisation the caller's organisation
 * @return {boolean}
 */
function canSee(record, stored, chain, organisation) {
  if (typeof organisation !== 'string' || organisation === '') {
    return false;
  }
  if (stored === null) {
    return record.organisationId === organisation;
  }
  const parties = [stored.carrier, stored.holder, stored.consignee];
  if (parties.includes(organisation)) {
    return true;
  }
  return chain.some(
    entry => entry.from === organisation || entry.to === organisation,
  );
}

/**
 * The organisations a command hands the B/L to, which must be registered and active: the
 * shipper, first holder, on issue; `to` on endorse and transfer. The consignee is not checked
 * (README.md, "The title").
 * @param {!Object} command the engine's command
 * @return {!Array<{organisation: string, message: string}>}
 */
function recipientsOf(command) {
  if (command.name === 'issue' && command.shipper) {
    return [
      {
        organisation: command.shipper,
        message:
          "The shipper's organisation is not registered on this platform, or not active: the B/L cannot be issued to it",
      },
    ];
  }
  if (
    (command.name === 'endorse' || command.name === 'transfer') &&
    command.to
  ) {
    return [
      {
        organisation: command.to,
        message:
          'That organisation is not registered on this platform, or not active: the B/L cannot go to it',
      },
    ];
  }
  return [];
}

/**
 * The title engine's service (CB-31, README.md "The title"): the holder ledger of the B/Ls. A
 * title changes only through the state machine of `@lrfe/domain-shipping/title`, and only if
 * nobody changed it since it was read, so of two commands at the same moment exactly one wins.
 */
export class TitleService {
  /**
   * @param {{
   *   repo: object,
   *   events: ?object,
   *   modules: !ReadonlyArray<string>,
   *   clock?: function(): Date,
   *   signer: ?object,
   *   audit?: ?{entryProof: function(string): !Promise<object>},
   *   organisations: {standingOf: function(string): !Promise<string>},
   * }} options `modules`: the title modules on in this install (modulesFromSettings); `signer`:
   *     the platform signer of the chain entries (signerFromEnv of @lrfe/common), null when there
   *     is none (title commands are then refused with 503); `audit`: the client of the audit
   *     service giving the trail-entry proof of an event (./audit-client.js), null when there is
   *     none (title proofs are then refused with 503); `organisations`: the client of identity
   *     saying whether an organisation is registered and active (./identity-client.js); required
   */
  constructor({
    repo,
    events,
    modules,
    clock = () => new Date(),
    signer,
    audit = null,
    organisations,
  }) {
    if (typeof organisations?.standingOf !== 'function') {
      throw new Error(
        'TitleService needs its organisations client (identity), to check where a B/L goes',
      );
    }
    this.repo = repo;
    this.events = events;
    this.modules = modules;
    this.clock = clock;
    this.signer = signer ?? null;
    this.audit = audit;
    this.organisations = organisations;
  }

  /**
   * Run `fn` so its writes and the events it publishes are committed together.
   * @param {function(): Promise<*>} fn
   * @return {Promise<*>}
   */
  atomic(fn) {
    return this.events?.atomic ? this.events.atomic(fn) : fn();
  }

  /**
   * A B/L's record, its stored title and its chain of title, when the caller sees them; 404
   * otherwise, never saying that the B/L exists.
   * @param {string} recordId
   * @param {{org?: string}} actor
   * @return {!Promise<{record: object, stored: ?object, chain: !Array<object>}>}
   */
  async requireVisible(recordId, actor) {
    const record = await this.repo.getRecord(recordId);
    if (!record) {
      throw notFound();
    }
    const stored = await this.repo.getTitle(recordId);
    const chain = await this.repo.listTitleEntries(recordId);
    if (!canSee(record, stored, chain, actor?.org)) {
      throw notFound();
    }
    return {record, stored, chain};
  }

  /**
   * Checks that a B/L can be issued now: 409 when it has no committed version, or while a new
   * version is in review.
   * @param {{currentVersion: ?number, draftState: ?string}} record
   */
  requireIssuable(record) {
    if (!record.currentVersion) {
      throw new ConflictError(
        'This B/L has no committed version yet: it can be issued once a version is committed',
        {code: 'not-committed'},
      );
    }
    if (record.draftState === 'in_review') {
      throw new ConflictError(
        'A new version of this B/L is in review: it can be issued once the review is decided',
        {code: 'in-review'},
      );
    }
  }

  /**
   * What issuing a B/L issues: its current committed version, the hash of its B/L, and the issue
   * command built from it (the kind from the document; the shipper, first holder of a negotiable
   * B/L, and the consignee from the organisations its parties are linked to). 409 when the B/L
   * has no committed version, or while a new version is in review.
   * @param {object} record
   * @return {!Promise<{issuedVersion: number, documentHash: string, command: object}>}
   */
  async issueOf(record) {
    this.requireIssuable(record);
    const version = await this.repo.getVersion(
      record.id,
      record.currentVersion,
    );
    const links = version.data.partyOrganisations ?? {};
    return {
      issuedVersion: version.versionNumber,
      documentHash: billOfLadingHash(version.data),
      command: {
        name: 'issue',
        kind: kindOf(version.data.document),
        shipper: links.shipper ?? null,
        consignee: links.consignee ?? null,
      },
    };
  }

  /**
   * Runs the state machine; a refusal becomes its HTTP answer.
   * @param {?object} title the engine's title, null before issue
   * @param {!Object} command
   * @param {{org?: string}} actor
   * @return {{title: !Object, children: (!Array<!Object>|undefined)}}
   */
  run(title, command, actor) {
    try {
      return applyTitleCommand(title, command, engineActor(actor), {
        modules: this.modules,
      });
    } catch (error) {
      if (error instanceof TitleRefusal) {
        throw errorOf(error);
      }
      throw error;
    }
  }

  /**
   * Checks that the organisations a command hands the B/L to are registered and active (the
   * shipper on issue, `to` on endorse and transfer): 422 when one is not, 503 while identity
   * cannot answer.
   * @param {!Object} command the engine's command
   * @return {!Promise<void>}
   */
  async requireRegistered(command) {
    for (const {organisation, message} of recipientsOf(command)) {
      let standing;
      try {
        standing = await this.organisations.standingOf(organisation);
      } catch (error) {
        throw organisationsUnavailable(error);
      }
      if (standing !== 'active') {
        throw unregistered(message);
      }
    }
  }

  /**
   * Checks, inside the transaction that writes the first title, that the B/L is still issuable
   * with the version read: the record's row is locked until the transaction ends, so a commit or
   * a submission waits for the issue, and one that landed since the version was read makes the
   * issue fail (409) rather than bind an older version.
   * @param {string} recordId
   * @param {number} issuedVersion the version the issue binds
   * @return {!Promise<void>}
   */
  async requireStillIssuable(recordId, issuedVersion) {
    const current = await this.repo.lockRecord(recordId);
    this.requireIssuable(current);
    if (current.currentVersion !== issuedVersion) {
      throw changedMeanwhile();
    }
  }

  /**
   * Runs a command on a B/L's title (README.md "The title"): `{name, ...arguments}`, e.g.
   * `{name: 'endorse', to: 'org-b', inBlank: false}`. An organisation that does not see the B/L
   * gets 404 before any other refusal. The organisations the B/L goes to must be registered and
   * active. The new title is written only if the title is still the one read; a command that
   * lost the race gets 409 "This B/L changed meanwhile". Each applied command adds one signed
   * entry to the B/L's chain of title (CB-32), signed before anything is written (a failed
   * signature changes nothing) and stored in the same transaction as the title, with its event
   * `records.title.<command>` (CB-33): nothing is published for a refusal, a lost race or a
   * failed transaction.
   * @param {string} recordId
   * @param {{name: string}} command the command and its arguments
   * @param {{id: string, name?: string, org?: string}} actor the person, with their organisation
   * @param {{withChain?: boolean}} [options] `withChain`: the answer carries the chain of title
   *     (the API's answer)
   * @return {!Promise<object>} the title as `read` answers it
   */
  async apply(recordId, command, actor, {withChain = false} = {}) {
    const {record, stored, chain} = await this.requireVisible(recordId, actor);
    if (this.signer === null) {
      throw notSetUp();
    }
    let engineCommand = command ?? {};
    let issued = null;
    if (stored === null && engineCommand.name === 'issue') {
      issued = await this.issueOf(record);
      engineCommand = issued.command;
    }
    const result = this.run(titleOf(stored), engineCommand, actor);
    if (result.children) {
      // CB-35: a split creates its child records and their first titles here.
      throw new ConflictError('Splitting a B/L is not available yet', {
        code: 'not-available',
      });
    }
    await this.requireRegistered(engineCommand);
    const now = this.clock();
    const entry = await this.signedEntry({
      recordId,
      stored,
      command: engineCommand.name,
      actor,
      title: result.title,
      documentHash: issued?.documentHash ?? stored?.documentHash,
      at: now,
    });
    let saved;
    let appended;
    // the title, its chain entry and its event are committed together
    await this.atomic(async () => {
      if (issued) {
        await this.requireStillIssuable(recordId, issued.issuedVersion);
        saved = await this.repo.createTitle({
          recordId,
          ...result.title,
          issuedVersion: issued.issuedVersion,
          documentHash: issued.documentHash,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        saved = await this.repo.updateTitle(
          recordId,
          {...result.title, revision: stored.revision + 1, updatedAt: now},
          stored.revision,
        );
      }
      if (!saved) {
        throw changedMeanwhile();
      }
      appended = await this.repo.appendTitleEntry(entry);
      await this.publishEntry(record, appended, actor);
    });
    // the write succeeded at the revision read, so the chain read with it was the whole chain
    const after = withChain ? [...chain, appended] : null;
    return this.viewOf(record, saved, actor, after);
  }

  /**
   * Publishes a chain entry as its event `records.title.<command>` (docs/chain-of-title.md of the
   * shipping pack): the record's id and number, the seq and the full signed entry, never the
   * document. The audit service puts it on the B/L's trail and anchors it with the trail.
   * @param {{id: string, recordNo: string}} record
   * @param {!Object} entry the stored entry
   * @param {{id: string, name?: string, org?: string}} actor
   * @return {!Promise<void>}
   */
  async publishEntry(record, entry, actor) {
    await this.events?.publish(
      `${TITLE_EVENT_PREFIX}${entry.command}`,
      {recordId: record.id, recordNo: record.recordNo, seq: entry.seq, entry},
      {
        actor: {id: actor.id, name: actor.name, org: actor.org},
        id: titleEventIdOf(record.id, entry.seq),
      },
    );
  }

  /**
   * A B/L's title proof bundle, `lrfe-title-proof/1` (docs/chain-of-title.md of the shipping
   * pack): its chain of title up to entry `seq` (by default the last), the platform's public keys,
   * and the audit's trail-entry proof of that entry's event once anchored (`{pending: true}`
   * before, and while the event is not on the trail yet). `latest` says whether the entry is the
   * B/L's last; `latestSeq` names the last. 404 for a B/L the caller does not see or not issued
   * yet, and for a seq beyond the chain; 503 while the audit service cannot answer.
   * @param {string} recordId
   * @param {{org?: string}} actor
   * @param {{seq?: number}} [options]
   * @return {!Promise<object>}
   */
  async proof(recordId, actor, {seq} = {}) {
    const {record, stored} = await this.requireVisible(recordId, actor);
    if (stored === null) {
      throw notFound();
    }
    if (this.signer === null || this.audit === null) {
      throw notSetUp();
    }
    const chain = await this.repo.listTitleEntries(recordId);
    const latestSeq = chain.length;
    const selected = seq ?? latestSeq;
    if (selected > latestSeq) {
      throw new NotFoundError(
        `This B/L's chain of title has no entry ${selected}`,
      );
    }
    const jwks = await this.keys();
    const anchor = await this.anchorOf(titleEventIdOf(recordId, selected));
    return {
      format: TITLE_PROOF_FORMAT,
      recordId,
      recordNo: record.recordNo,
      entries: chain.slice(0, selected),
      jwks,
      anchor,
      latest: selected === latestSeq,
      latestSeq,
    };
  }

  /**
   * The audit's trail-entry proof of an entry's event once anchored, `{pending: true}` while it
   * waits for the next anchoring or is not on the trail yet; 503 when the audit service cannot
   * answer.
   * @param {string} eventId
   * @return {!Promise<object>}
   */
  async anchorOf(eventId) {
    let proof;
    try {
      proof = await this.audit.entryProof(eventId);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) {
        return {pending: true};
      }
      throw proofUnavailable(error);
    }
    if (proof?.status === 'waiting') {
      return {pending: true};
    }
    return proof;
  }

  /**
   * The chain-of-title entry of a command about to be applied (docs/chain-of-title.md of the
   * shipping pack): the next seq, linked to the B/L's last entry, hashed and signed. The title's
   * revision counts its entries, so a chain that moved on since the title was read is the race
   * `apply` loses anyway: 409.
   * @param {{
   *   recordId: string,
   *   stored: ?object,
   *   command: string,
   *   actor: {id: string, name?: string, org?: string},
   *   title: !Object,
   *   documentHash: string,
   *   at: !Date,
   * }} change the stored title before the command (null before issue) and the engine's after it
   * @return {!Promise<object>} the entry, with its entryHash and signature
   */
  async signedEntry({
    recordId,
    stored,
    command,
    actor,
    title,
    documentHash,
    at,
  }) {
    const chain = await this.repo.listTitleEntries(recordId);
    const revision = stored?.revision ?? 0;
    if (chain.length !== revision) {
      throw changedMeanwhile();
    }
    const content = {
      recordId,
      seq: revision + 1,
      command,
      actor: {id: actor.id, name: actor.name ?? null, org: actor.org ?? null},
      from: stored?.holder ?? null,
      to: title.holder ?? null,
      endorsement: title.endorsement,
      documentHash,
      at: at.toISOString(),
      previousHash: chain.at(-1)?.entryHash ?? null,
      kid: await this.signer.currentKid(),
    };
    const signature = await signJws(content, this.signer, {
      typ: TITLE_ENTRY_TYP,
      kid: content.kid,
    });
    return {...content, entryHash: entryHashOf(content), signature};
  }

  /**
   * The platform's public keys of the chain entries' signatures (a JWK set of every key
   * version), for anyone to verify a chain with; 503 while there is no signer.
   * @return {!Promise<{keys: !Array<!Object>}>}
   */
  async keys() {
    if (this.signer === null) {
      throw notSetUp();
    }
    return this.signer.jwks();
  }

  /**
   * A B/L's title for the caller, with the commands they may run on it now; 404 when they do not
   * see it.
   * @param {string} recordId
   * @param {{id: string, name?: string, org?: string}} actor
   * @param {{withChain?: boolean}} [options] `withChain`: the answer carries the chain of title
   *     (the API's answer)
   * @return {!Promise<object>}
   */
  async read(recordId, actor, {withChain = false} = {}) {
    const {record, stored, chain} = await this.requireVisible(recordId, actor);
    return this.viewOf(record, stored, actor, withChain ? chain : null);
  }

  /**
   * A title as `read` answers it: `title` null before issue, `allowedCommands` for the caller
   * (before issue: `issue` when the B/L can be issued now; only the commands the API offers),
   * and `chain`, the chain of title, when given.
   * @param {object} record
   * @param {?object} stored
   * @param {{org?: string}} actor
   * @param {?Array<object>} [chain] the chain of title to answer with, null for none
   * @return {!Promise<{
   *   recordId: string,
   *   title: ?object,
   *   allowedCommands: !Array<string>,
   *   chain: (!Array<object>|undefined),
   * }>}
   */
  async viewOf(record, stored, actor, chain = null) {
    const view = {
      recordId: record.id,
      title: null,
      allowedCommands: [],
    };
    if (stored === null) {
      view.allowedCommands = await this.issueAllowed(record, actor);
    } else {
      view.title = {
        ...titleOf(stored),
        issuedVersion: stored.issuedVersion,
        documentHash: stored.documentHash,
        revision: stored.revision,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      };
      const allowed = allowedCommands(titleOf(stored), engineActor(actor), {
        modules: this.modules,
      });
      view.allowedCommands = allowed.filter(name => OFFERED_COMMANDS.has(name));
    }
    if (chain !== null) {
      view.chain = chain;
    }
    return view;
  }

  /**
   * `['issue']` when the caller may issue the B/L now, else none.
   * @param {object} record
   * @param {{org?: string}} actor
   * @return {!Promise<!Array<string>>}
   */
  async issueAllowed(record, actor) {
    try {
      const {command} = await this.issueOf(record);
      this.run(null, command, actor);
      return ['issue'];
    } catch (error) {
      if (error instanceof AppError) {
        return [];
      }
      throw error;
    }
  }
}
