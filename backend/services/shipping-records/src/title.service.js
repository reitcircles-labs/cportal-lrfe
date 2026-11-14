import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
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
 * carrier, the current holder or the consignee.
 * @param {{organisationId: string}} record
 * @param {?object} stored the stored title, null before issue
 * @param {(string|undefined)} organisation the caller's organisation
 * @return {boolean}
 */
function canSee(record, stored, organisation) {
  if (typeof organisation !== 'string' || organisation === '') {
    return false;
  }
  if (stored === null) {
    return record.organisationId === organisation;
  }
  // CB-34: past holders see it too, from the chain of title.
  const parties = [stored.carrier, stored.holder, stored.consignee];
  return parties.includes(organisation);
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
   * }} options `modules`: the title modules on in this install (modulesFromSettings); `signer`:
   *     the platform signer of the chain entries (signerFromEnv of @lrfe/common), null when there
   *     is none (title commands are then refused with 503)
   */
  constructor({repo, events, modules, clock = () => new Date(), signer}) {
    this.repo = repo;
    this.events = events;
    this.modules = modules;
    this.clock = clock;
    this.signer = signer ?? null;
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
   * A B/L's record and its stored title, when the caller sees them; 404 otherwise, never saying
   * that the B/L exists.
   * @param {string} recordId
   * @param {{org?: string}} actor
   * @return {!Promise<{record: object, stored: ?object}>}
   */
  async requireVisible(recordId, actor) {
    const record = await this.repo.getRecord(recordId);
    if (!record) {
      throw notFound();
    }
    const stored = await this.repo.getTitle(recordId);
    if (!canSee(record, stored, actor?.org)) {
      throw notFound();
    }
    return {record, stored};
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
    const version = await this.repo.getVersion(
      record.id,
      record.currentVersion,
    );
    const links = version.data.partyOrganisations ?? {};
    // CB-34: identity checks that the shipper and consignee are registered, active organisations.
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
   * Runs a command on a B/L's title (README.md "The title"): `{name, ...arguments}`, e.g.
   * `{name: 'endorse', to: 'org-b', inBlank: false}`. The new title is written only if the title
   * is still the one read; a command that lost the race gets 409 "This B/L changed meanwhile".
   * Each applied command adds one signed entry to the B/L's chain of title (CB-32), signed before
   * anything is written (a failed signature changes nothing) and stored in the same transaction
   * as the title.
   * @param {string} recordId
   * @param {{name: string}} command the command and its arguments
   * @param {{id: string, name?: string, org?: string}} actor the person, with their organisation
   * @return {!Promise<object>} the title as `read` answers it
   */
  async apply(recordId, command, actor) {
    const {record, stored} = await this.requireVisible(recordId, actor);
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
    // the title, its chain entry and its event are committed together
    await this.atomic(async () => {
      if (issued) {
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
      await this.repo.appendTitleEntry(entry);
      // CB-33: its event `records.title.<command>` is published here, in this transaction.
    });
    return this.viewOf(record, saved, actor);
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
   * @return {!Promise<object>}
   */
  async read(recordId, actor) {
    const {record, stored} = await this.requireVisible(recordId, actor);
    return this.viewOf(record, stored, actor);
  }

  /**
   * A title as `read` answers it: `title` null before issue, and `allowedCommands` for the
   * caller (before issue: `issue` when the B/L can be issued now).
   * @param {object} record
   * @param {?object} stored
   * @param {{org?: string}} actor
   * @return {!Promise<{recordId: string, title: ?object, allowedCommands: !Array<string>}>}
   */
  async viewOf(record, stored, actor) {
    if (stored === null) {
      return {
        recordId: record.id,
        title: null,
        allowedCommands: await this.issueAllowed(record, actor),
      };
    }
    return {
      recordId: record.id,
      title: {
        ...titleOf(stored),
        issuedVersion: stored.issuedVersion,
        documentHash: stored.documentHash,
        revision: stored.revision,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      },
      allowedCommands: allowedCommands(titleOf(stored), engineActor(actor), {
        modules: this.modules,
      }),
    };
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
