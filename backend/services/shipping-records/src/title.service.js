import {randomUUID} from 'node:crypto';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  sha256Hex,
  signJws,
} from '@lrfe/common';
import {
  billOfLadingHash,
  formatsFromSettings,
  splitCargoProblems,
} from '@lrfe/domain-shipping/bill-of-lading';
import {
  DEFAULT_MAX_SPLIT_CHILDREN,
  TITLE_WORDING,
  TitleRefusal,
  allowedCommands,
  applyTitleCommand,
  kindOf,
} from '@lrfe/domain-shipping/title';
import {portProblems} from '@lrfe/domain-shipping/ports';

import {TITLE_ENTRY_TYP, entryHashOf} from './chain.js';
import {summaryOf} from './records.service.js';
import {
  checkedDocument,
  committedEventOf,
  convertedDocument,
  engineCommittedVersion,
} from './engine-versions.js';

/**
 * The title commands the API offers (CB-34, CB-35), each with the permission it needs: the
 * carrier's staff hold `bl.issue`, the holder's `bl.endorse`.
 * @type {!ReadonlyMap<string, string>}
 */
export const OFFERED_COMMANDS = new Map([
  ['issue', 'bl.issue'],
  ['void', 'bl.issue'],
  ['release', 'bl.issue'],
  ['deliver', 'bl.issue'],
  ['amend', 'bl.issue'],
  ['split', 'bl.issue'],
  ['endorse', 'bl.endorse'],
  ['transfer', 'bl.endorse'],
  ['surrender', 'bl.endorse'],
  ['surrender-for-amendment', 'bl.endorse'],
  ['switch-to-paper', 'bl.endorse'],
]);

/**
 * The command of the first entry of a B/L made by a split (CB-35): its chain starts from the
 * parent's `split` entry. Nobody runs it: the split writes it.
 */
export const ISSUE_FROM_SPLIT = 'issue-from-split';

/** How many parents deep a title proof follows splits of splits. */
const MAX_SPLIT_DEPTH = 50;

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
  'partial-release',
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
  return inChainOf(chain, organisation);
}

/**
 * The roles of an organisation on a B/L it sees (CB-42): `carrier` (before issue, the record's
 * owner), `holder`, `consignee`, and `past-holder` for an organisation the chain of title moved
 * the B/L from or to that has no other role now. The carrier holding a surrendered B/L is carrier
 * and holder; it is never its own past holder.
 * @param {{organisationId: string}} record
 * @param {?object} stored the stored title, null before issue
 * @param {boolean} inChain whether the chain of title names the organisation as `from` or `to`
 * @param {string} organisation
 * @return {!Array<string>}
 */
function rolesOf(record, stored, inChain, organisation) {
  if (stored === null) {
    if (record.organisationId === organisation) {
      return ['carrier'];
    }
    return [];
  }
  const roles = [];
  if (stored.carrier === organisation) {
    roles.push('carrier');
  }
  if (stored.holder === organisation) {
    roles.push('holder');
  }
  if (stored.consignee === organisation) {
    roles.push('consignee');
  }
  if (roles.length === 0 && inChain) {
    roles.push('past-holder');
  }
  return roles;
}

/**
 * Whether a chain of title names an organisation as a holder before or after a step.
 * @param {!Array<{from: ?string, to: ?string}>} chain
 * @param {(string|undefined)} organisation
 * @return {boolean}
 */
function inChainOf(chain, organisation) {
  return chain.some(
    entry => entry.from === organisation || entry.to === organisation,
  );
}

/**
 * What a title answer says of the B/L's record (CB-42): its reference and where its drafting is,
 * for the parties that cannot read the record itself.
 * @param {object} record a stored record
 * @return {{
 *   recordNo: string,
 *   carrierCode: string,
 *   label: string,
 *   status: string,
 *   draftState: ?string,
 * }}
 */
function recordOf(record) {
  return {
    recordNo: record.recordNo,
    carrierCode: record.carrierCode,
    label: record.label,
    status: record.status,
    draftState: record.draftState ?? null,
  };
}

/**
 * The B/L number a lookup asks for (CB-47), without the spaces around it; undefined when none is
 * asked for. 400 for a blank one.
 * @param {(string|undefined)} number as typed
 * @return {(string|undefined)}
 */
function numberOf(number) {
  if (number === undefined) {
    return undefined;
  }
  const trimmed = number.trim();
  if (trimmed === '') {
    throw new BadRequestError('Give the number of the B/L to look for', {
      code: 'no-number',
    });
  }
  return trimmed;
}

/**
 * The organisations a stored title names (CB-42): carrier, holder, consignee, and the holder an
 * amended B/L goes back to; none before issue.
 * @param {?object} stored
 * @return {!Array<?string>}
 */
function partiesOf(stored) {
  if (stored === null) {
    return [];
  }
  return [stored.carrier, stored.holder, stored.consignee, stored.returnTo];
}

/**
 * Latest ports, shipper, consignee and kind for a row of the B/L list (CB-72).
 * @param {?object} version the latest committed or draft version
 * @param {?object} title the stored title, null before issue
 * @return {{
 *   portOfLoading: ?string,
 *   portOfDischarge: ?string,
 *   shipper: ?string,
 *   shipperName: ?string,
 *   consignee: ?string,
 *   consigneeName: ?string,
 *   draftKind: ?string,
 * }}
 */
function listMetaOf(version, title) {
  const doc = version?.data?.document ?? null;
  const parties = version?.data?.partyOrganisations ?? {};
  const draftKind = title?.kind ?? (doc ? kindOf(doc) : null);
  const negotiable = draftKind === 'negotiable' || doc?.isToOrder === true;
  return {
    portOfLoading: doc?.transports?.portOfLoading?.UNLocationCode ?? null,
    portOfDischarge: doc?.transports?.portOfDischarge?.UNLocationCode ?? null,
    shipper: parties.shipper ?? null,
    shipperName: doc?.documentParties?.shipper?.partyName ?? null,
    consignee: negotiable
      ? null
      : (parties.consignee ?? title?.consignee ?? null),
    consigneeName: negotiable
      ? null
      : (doc?.documentParties?.consignee?.partyName ?? null),
    draftKind,
  };
}

/**
 * A stored title as the list of a party's B/Ls gives it (CB-42), or null before issue.
 * @param {?object} stored
 * @return {?object}
 */
function titleSummaryOf(stored) {
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
    updatedAt: stored.updatedAt,
  };
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
 * The actor of a chain entry: the person and their organisation.
 * @param {{id: string, name?: string, org?: string}} actor
 * @return {{id: string, name: ?string, org: ?string}}
 */
function entryActor(actor) {
  return {id: actor.id, name: actor.name ?? null, org: actor.org ?? null};
}

/**
 * How many B/Ls a split's command asks for, as the engine counts them: 0 when `children` is not
 * a list.
 * @param {*} command the API's command
 * @return {number}
 */
function childCountOf(command) {
  if (!Array.isArray(command?.children)) {
    return 0;
  }
  return command.children.length;
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
   *   organisations: {
   *     standingOf: function(string): !Promise<string>,
   *     nameOf?: function(string): !Promise<?string>,
   *   },
   *   formats?: !ReadonlyArray<object>,
   *   maxSplitChildren?: number,
   * }} options `modules`: the title modules on in this install (modulesFromSettings); `formats`:
   *     the B/L formats on (formatsFromSettings), which an amendment's and a split's documents
   *     come in (the default format when not given); `signer`:
   *     the platform signer of the chain entries (signerFromEnv of @lrfe/common), null when there
   *     is none (title commands are then refused with 503); `audit`: the client of the audit
   *     service giving the trail-entry proof of an event (./audit-client.js), null when there is
   *     none (title proofs are then refused with 503); `organisations`: the client of identity
   *     saying whether an organisation is registered and active (./identity-client.js); required;
   *     `maxSplitChildren`: maximum new B/Ls per split (LRFE_BL_SPLIT_MAX, default 10)
   */
  constructor({
    repo,
    events,
    modules,
    clock = () => new Date(),
    signer,
    audit = null,
    organisations,
    formats = formatsFromSettings({}),
    ports = null,
    maxSplitChildren = DEFAULT_MAX_SPLIT_CHILDREN,
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
    this.formats = formats;
    this.ports = ports;
    this.maxSplitChildren = maxSplitChildren;
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
   * @param {{status?: string, currentVersion: ?number, draftState: ?string}} record
   */
  requireIssuable(record) {
    if (record.status === 'archived') {
      throw new ConflictError(
        'This B/L is archived and can no longer be changed',
        {code: 'draft-archived'},
      );
    }
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
   * shipper on issue, `to` on endorse and transfer), and none is the platform operator's own
   * (CB-48): 422 when one is, 503 while identity cannot answer.
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
      if (standing === 'operator') {
        throw unregistered(
          "That is the platform operator's own organisation, which takes no part in a B/L: the B/L cannot go to it",
        );
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
   * failed transaction. An amendment (`{name: 'amend', format, document, partyOrganisations?}`)
   * commits the new version in the same transaction; a split (`{name: 'split', children:
   * [{format, document, partyOrganisations?}, ...]}`) closes the B/L and makes its children, all
   * or nothing (CB-35).
   * @param {string} recordId
   * @param {{name: string}} command the command and its arguments
   * @param {{id: string, name?: string, org?: string}} actor the person, with their organisation
   * @param {{withChain?: boolean}} [options] `withChain`: the answer carries the chain of title
   *     (the API's answer)
   * @return {!Promise<object>} the title as `read` answers it; a split's also names its children
   *     (`children: [{recordId, recordNo}]`, in the order given)
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
    if (engineCommand.name === 'split') {
      const count = childCountOf(command);
      if (count > this.maxSplitChildren) {
        throw new BadRequestError(
          `A B/L can be split into at most ${this.maxSplitChildren} new B/Ls`,
          {code: 'too-many-children'},
        );
      }
      engineCommand = {name: 'split', children: count};
    }
    const result = this.run(titleOf(stored), engineCommand, actor);
    if (engineCommand.name === 'split') {
      return this.split(record, stored, chain, command, result, actor, {
        withChain,
      });
    }
    let amendment = null;
    if (engineCommand.name === 'amend') {
      amendment = await this.amendmentOf(record, command, actor);
    }
    await this.requireRegistered(engineCommand);
    const now = this.clock();
    const entry = await this.signedEntry({
      recordId,
      stored,
      command: engineCommand.name,
      actor,
      title: result.title,
      documentHash:
        amendment?.version.documentHash ??
        issued?.documentHash ??
        stored?.documentHash,
      at: now,
    });
    let saved;
    let appended;
    // the title, its chain entry and its event (and an amendment's version) are committed together
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
        if (amendment) {
          await this.requireStillAmendable(recordId, amendment.basedOn);
        }
        saved = await this.repo.updateTitle(
          recordId,
          {
            ...result.title,
            ...amendment?.titlePatch,
            revision: stored.revision + 1,
            updatedAt: now,
          },
          stored.revision,
        );
      }
      if (!saved) {
        throw changedMeanwhile();
      }
      if (amendment) {
        await this.commitAmendment(record, amendment, actor);
      }
      appended = await this.repo.appendTitleEntry(entry);
      await this.publishEntry(record, appended, actor);
    });
    // the write succeeded at the revision read, so the chain read with it was the whole chain
    const after = [...chain, appended];
    return this.viewOf(record, saved, actor, after, {withChain});
  }

  /**
   * Checks that no version of the B/L is being drafted or in review: an amendment would leave
   * that draft after a version it never saw, a split would close the B/L under it (CB-35). 409
   * `draft-open`; the carrier finishes or discards the draft first.
   * @param {{draftVersion: ?number}} record
   * @return {void}
   */
  requireNoDraft(record) {
    if (record.draftVersion) {
      throw new ConflictError(TITLE_WORDING.draftOpen, {code: 'draft-open'});
    }
  }

  /**
   * What an amendment commits (CB-35): the new version of the B/L after its current one, from
   * the command's `{format, document, partyOrganisations?}`, converted and checked like any
   * document (same carrier code and reference, still to order), keeping the current version's
   * organisation links when it gives none. 409 while a version is being drafted or in review.
   * @param {object} record
   * @param {!Object} command the API's command
   * @param {{id: string, name?: string}} actor
   * @return {!Promise<{basedOn: number, version: !Object, titlePatch: !Object}>}
   */
  async amendmentOf(record, command, actor) {
    this.requireNoDraft(record);
    const current = await this.repo.getVersion(
      record.id,
      record.currentVersion,
    );
    const data = checkedDocument(
      convertedDocument(this.formats, command, current.data.partyOrganisations),
      {carrierCode: record.carrierCode, reference: record.recordNo},
    );
    // a changed port must be on the port list (CB-63)
    const problems = portProblems(
      data.document,
      current.data.document,
      this.ports,
    );
    if (problems.length > 0) {
      throw new BadRequestError(
        `This B/L is not valid: ${problems[0].message}`,
        {
          code: 'unknown-port',
          problems,
        },
      );
    }
    const version = engineCommittedVersion({
      record,
      versionNumber: current.versionNumber + 1,
      data,
      previous: current,
      actor,
      action: 'amend',
      at: this.clock(),
    });
    return {
      basedOn: current.versionNumber,
      version,
      titlePatch: {
        issuedVersion: version.versionNumber,
        documentHash: version.documentHash,
      },
    };
  }

  /**
   * Checks, inside the transaction of an amendment, that the B/L's current version is still the
   * one amended and no draft was opened since (the record's row is locked until it ends): 409
   * otherwise.
   * @param {string} recordId
   * @param {number} basedOn the current version the amendment follows
   * @return {!Promise<void>}
   */
  async requireStillAmendable(recordId, basedOn) {
    const current = await this.repo.lockRecord(recordId);
    this.requireNoDraft(current);
    if (current.currentVersion !== basedOn) {
      throw changedMeanwhile();
    }
  }

  /**
   * Writes an amendment's version as the record's current one, with its event
   * `records.record.committed`, in the caller's transaction.
   * @param {object} record
   * @param {{version: !Object}} amendment
   * @param {{id: string, name?: string, org?: string}} actor
   * @return {!Promise<void>}
   */
  async commitAmendment(record, {version}, actor) {
    await this.repo.addVersion(version);
    await this.repo.updateRecord(record.id, {
      status: 'committed',
      currentVersion: version.versionNumber,
      updatedAt: version.committedAt,
    });
    await this.events?.publish(
      'records.record.committed',
      committedEventOf(record, version, actor),
      {actor: {id: actor.id, name: actor.name ?? null}},
    );
  }

  /**
   * The B/Ls a split makes (CB-35), checked before anything is written: each child of the
   * command's `children` converted and checked like any document (the parent's carrier code,
   * still to order, valid), with its own reference (not the parent's nor another child's: 400;
   * not one the carrier has: 409), and the children's cargo adding up to the parent's (400
   * `cargo-mismatch`). Without `partyOrganisations` a child keeps the parent's links.
   * @param {object} record the parent
   * @param {!Object} command the API's command
   * @param {{id: string, name?: string}} actor
   * @param {!Date} at
   * @return {!Promise<!Array<{record: !Object, version: !Object}>>} in the order given
   */
  async childrenOf(record, command, actor, at) {
    const current = await this.repo.getVersion(
      record.id,
      record.currentVersion,
    );
    const documents = [];
    const references = new Set([record.recordNo]);
    for (const child of command.children) {
      const data = checkedDocument(
        convertedDocument(this.formats, child, current.data.partyOrganisations),
        {carrierCode: record.carrierCode},
      );
      const reference = data.document.transportDocumentReference;
      if (references.has(reference)) {
        throw new BadRequestError(TITLE_WORDING.childReference(reference), {
          code: 'child-reference',
        });
      }
      references.add(reference);
      documents.push(data);
    }
    const problems = splitCargoProblems(
      current.data.document,
      documents.map(data => data.document),
    );
    if (problems.length > 0) {
      throw new BadRequestError(TITLE_WORDING.cargoMismatch(problems), {
        code: 'cargo-mismatch',
        problems,
      });
    }
    const children = [];
    for (const data of documents) {
      const recordNo = data.document.transportDocumentReference;
      const taken = await this.repo.findRecord({
        organisationId: record.organisationId,
        carrierCode: record.carrierCode,
        recordNo,
      });
      if (taken) {
        throw new ConflictError(TITLE_WORDING.childReferenceTaken(recordNo), {
          code: 'reference-taken',
        });
      }
      const child = {
        id: randomUUID(),
        recordNo,
        carrierCode: record.carrierCode,
        label: `B/L ${recordNo} (${record.carrierCode})`,
        organisationId: record.organisationId,
        status: 'committed',
        currentVersion: 1,
        draftVersion: null,
        draftState: null,
        createdAt: at,
        createdById: actor.id,
        createdByName: actor.name ?? null,
        updatedAt: at,
      };
      const version = engineCommittedVersion({
        record: child,
        versionNumber: 1,
        data,
        previous: null,
        actor,
        action: 'split',
        at,
      });
      children.push({record: child, version});
    }
    return children;
  }

  /**
   * Splits a B/L into new B/Ls (CB-35, after the engine allowed it): the parent's title closes
   * (`split`) with its entry; each child is a record of the carrier with its version 1 committed,
   * its first title (the engine's) and its first entry `issue-from-split`, whose previousHash is
   * the parent's `split` entry's hash. 409 `draft-open` while a version of the parent is being
   * drafted or in review. Everything is checked and signed first (every child and its reference
   * before any write), then written in one transaction with its events: all or nothing.
   * @param {object} record the parent
   * @param {!Object} stored the parent's stored title
   * @param {!Array<object>} chain the parent's chain of title, as read with it
   * @param {!Object} command the API's command
   * @param {{title: !Object, children: !Array<!Object>}} result the engine's titles
   * @param {{id: string, name?: string, org?: string}} actor
   * @param {{withChain: boolean}} options
   * @return {!Promise<object>} the parent's title as `read` answers it, with `children`
   */
  async split(record, stored, chain, command, result, actor, {withChain}) {
    this.requireNoDraft(record);
    const now = this.clock();
    const children = await this.childrenOf(record, command, actor, now);
    const splitEntry = await this.signedEntry({
      recordId: record.id,
      stored,
      command: 'split',
      actor,
      title: result.title,
      documentHash: stored.documentHash,
      at: now,
    });
    const firsts = [];
    for (const [i, child] of children.entries()) {
      const title = result.children[i];
      firsts.push(
        await this.signed({
          recordId: child.record.id,
          seq: 1,
          command: ISSUE_FROM_SPLIT,
          actor: entryActor(actor),
          from: null,
          to: title.holder ?? null,
          endorsement: title.endorsement,
          documentHash: child.version.documentHash,
          at: now.toISOString(),
          previousHash: splitEntry.entryHash,
          kid: await this.signer.currentKid(),
        }),
      );
    }
    let saved;
    let appended;
    // the parent closed, the children made: one transaction, all or nothing
    await this.atomic(async () => {
      this.requireNoDraft(await this.repo.lockRecord(record.id));
      saved = await this.repo.updateTitle(
        record.id,
        {...result.title, revision: stored.revision + 1, updatedAt: now},
        stored.revision,
      );
      if (!saved) {
        throw changedMeanwhile();
      }
      appended = await this.repo.appendTitleEntry(splitEntry);
      await this.publishEntry(record, appended, actor);
      for (const [i, child] of children.entries()) {
        await this.issueChild(child, result.children[i], firsts[i], actor, now);
      }
    });
    const after = [...chain, appended];
    const view = await this.viewOf(record, saved, actor, after, {withChain});
    view.children = children.map(child => ({
      recordId: child.record.id,
      recordNo: child.record.recordNo,
    }));
    return view;
  }

  /**
   * Writes a child of a split, in the split's transaction: its record with version 1 and its
   * event `records.record.committed`, its first title and its first entry with its event.
   * @param {{record: !Object, version: !Object}} child
   * @param {!Object} title the engine's first title of the child
   * @param {!Object} entry its signed first entry
   * @param {{id: string, name?: string, org?: string}} actor
   * @param {!Date} at
   * @return {!Promise<void>}
   */
  async issueChild(child, title, entry, actor, at) {
    await this.repo.createRecord(child);
    await this.events?.publish(
      'records.record.committed',
      committedEventOf(child.record, child.version, actor),
      {actor: {id: actor.id, name: actor.name ?? null}},
    );
    const created = await this.repo.createTitle({
      recordId: child.record.id,
      ...title,
      issuedVersion: 1,
      documentHash: child.version.documentHash,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
    if (!created) {
      throw changedMeanwhile();
    }
    const appended = await this.repo.appendTitleEntry(entry);
    await this.publishEntry(child.record, appended, actor);
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
    const bundle = {
      format: TITLE_PROOF_FORMAT,
      recordId,
      recordNo: record.recordNo,
      entries: chain.slice(0, selected),
      jwks,
      anchor,
      latest: selected === latestSeq,
      latestSeq,
    };
    const parent = await this.parentOf(chain, MAX_SPLIT_DEPTH);
    if (parent !== null) {
      bundle.parent = parent;
    }
    return bundle;
  }

  /**
   * The B/L a B/L was split from, for its title proof (CB-35): `{recordId, recordNo, entries}`,
   * its whole chain of title, whose last entry (the `split`) the B/L's first entry links to; with
   * its own `parent` when it was itself split from another. Null for a B/L of its own. The parent
   * is found by the link itself: the entry whose hash is the first entry's previousHash.
   * @param {!Array<object>} chain the B/L's chain of title
   * @param {number} depth how many more parents to follow
   * @return {!Promise<?{recordId: string, recordNo: string, entries: !Array<object>}>}
   */
  async parentOf(chain, depth) {
    const first = chain[0];
    if (depth <= 0 || first?.command !== ISSUE_FROM_SPLIT) {
      return null;
    }
    const split = await this.repo.findTitleEntryByHash(first.previousHash);
    if (split === null) {
      return null;
    }
    const record = await this.repo.getRecord(split.recordId);
    const entries = await this.repo.listTitleEntries(split.recordId);
    const parent = {
      recordId: split.recordId,
      recordNo: record.recordNo,
      entries: entries.filter(entry => entry.seq <= split.seq),
    };
    const grandparent = await this.parentOf(entries, depth - 1);
    if (grandparent !== null) {
      parent.parent = grandparent;
    }
    return parent;
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
    return this.signed({
      recordId,
      seq: revision + 1,
      command,
      actor: entryActor(actor),
      from: stored?.holder ?? null,
      to: title.holder ?? null,
      endorsement: title.endorsement,
      documentHash,
      at: at.toISOString(),
      previousHash: chain.at(-1)?.entryHash ?? null,
      kid: await this.signer.currentKid(),
    });
  }

  /**
   * An entry's content with its hash and the platform's signature.
   * @param {!Object} content the entry without entryHash and signature
   * @return {!Promise<object>}
   */
  async signed(content) {
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
    return this.viewOf(record, stored, actor, chain, {withChain});
  }

  /**
   * A title as `read` answers it: `record`, the B/L's reference and drafting state (CB-42),
   * `title` null before issue, `allowedCommands` for the caller (before issue: `issue` when the
   * B/L can be issued now; only the commands the API offers), `roles`, the caller's
   * organisation's roles on the B/L (CB-42), `chain`, the chain of title, when asked for,
   * `splitFrom` and `splitInto`, the B/Ls it is linked to by a split, when it is (CB-50), and
   * `organisationNames`, the names of the organisations the title and its chain name (CB-42).
   * @param {object} record
   * @param {?object} stored
   * @param {{org?: string}} actor
   * @param {!Array<object>} chain the B/L's whole chain of title
   * @param {{withChain?: boolean}} [options] `withChain`: the answer carries the chain
   * @return {!Promise<{
   *   recordId: string,
   *   record: !Object,
   *   title: ?object,
   *   allowedCommands: !Array<string>,
   *   roles: !Array<string>,
   *   maxSplitChildren: (number|undefined),
   *   chain: (!Array<object>|undefined),
   *   splitFrom: (!Object|undefined),
   *   splitInto: (!Array<!Object>|undefined),
   *   organisationNames: !Object<string, string>,
   * }>}
   */
  async viewOf(record, stored, actor, chain, {withChain = false} = {}) {
    const view = {
      recordId: record.id,
      record: recordOf(record),
      title: null,
      allowedCommands: [],
      roles: rolesOf(record, stored, inChainOf(chain, actor?.org), actor?.org),
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
      if (view.allowedCommands.includes('split')) {
        view.maxSplitChildren = this.maxSplitChildren;
      }
    }
    if (withChain) {
      view.chain = chain;
    }
    Object.assign(view, await this.splitLinksOf(stored, chain));
    const named = [record.organisationId, ...partiesOf(stored)];
    for (const entry of chain) {
      named.push(entry.from, entry.to, entry.actor?.org);
    }
    view.organisationNames = await this.namesOf(named);
    return view;
  }

  /**
   * The B/Ls a B/L is linked to by a split (CB-50), for its page: `splitFrom`, the B/L a child was
   * split from, and `splitInto`, the B/Ls a split parent was split into, by number; each
   * `{recordId, recordNo}`, and only the links that apply. Numbers only, never a document: whoever
   * sees the B/L sees the numbers of the B/Ls it is linked to, as its title proof shows them.
   * @param {?object} stored the stored title, null before issue
   * @param {!Array<object>} chain the B/L's chain of title
   * @return {!Promise<{
   *   splitFrom: ({recordId: string, recordNo: string}|undefined),
   *   splitInto: (!Array<{recordId: string, recordNo: string}>|undefined),
   * }>}
   */
  async splitLinksOf(stored, chain) {
    const links = {};
    const first = chain[0];
    if (first?.command === ISSUE_FROM_SPLIT) {
      const parentEntry = await this.repo.findTitleEntryByHash(
        first.previousHash,
      );
      if (parentEntry !== null) {
        links.splitFrom = await this.linkOf(parentEntry.recordId);
      }
    }
    const split = chain.findLast(entry => entry.command === 'split');
    if (stored?.state === 'split' && split !== undefined) {
      const firsts = await this.repo.listSplitChildEntries(split.entryHash);
      const children = [];
      for (const entry of firsts) {
        children.push(await this.linkOf(entry.recordId));
      }
      links.splitInto = children.sort((a, b) =>
        a.recordNo.localeCompare(b.recordNo),
      );
    }
    return links;
  }

  /**
   * A B/L as a link names it: its id and number.
   * @param {string} recordId
   * @return {!Promise<{recordId: string, recordNo: string}>}
   */
  async linkOf(recordId) {
    const record = await this.repo.getRecord(recordId);
    return {recordId, recordNo: record.recordNo};
  }

  /**
   * A page of the B/Ls the caller's organisation is party to (CB-42), newest first: those it sees
   * with `read` (before issue the ones it owns, after it those of which it is the carrier, the
   * holder, a past holder or the consignee), each with its title (null before issue) and the
   * organisation's roles on it, and the names of the organisations the items name
   * (`organisationNames`). Never another organisation's B/L. With `number`, only the B/Ls of that
   * number (CB-47): the whole transport document reference, whatever its case and the spaces
   * around it; another organisation's B/L of that number is never found, so the answer is the
   * same as for a number nobody uses. A blank number is refused (400).
   * @param {{org?: string}} actor
   * @param {{limit?: number, offset?: number, number?: string}} [page]
   * @return {!Promise<{
   *   items: !Array<object>,
   *   total: number,
   *   organisationNames: !Object<string, string>,
   *   ports: !Object<string, !Object>,
   * }>}
   */
  async listForParty(actor, {limit = 50, offset = 0, number} = {}) {
    const organisation = actor?.org;
    if (typeof organisation !== 'string' || organisation === '') {
      throw new ForbiddenError(
        'Your account belongs to no organisation, so it has no B/Ls',
        {code: 'no-organisation'},
      );
    }
    const page = await this.repo.listPartyRecords({
      organisationId: organisation,
      limit,
      offset,
      number: numberOf(number),
    });
    const items = page.items.map(({record, title, inChain, version}) => ({
      ...summaryOf(record),
      ...listMetaOf(version, title),
      title: titleSummaryOf(title),
      roles: rolesOf(record, title, inChain, organisation),
    }));
    const named = [];
    const ports = {};
    for (const [i, {record, title}] of page.items.entries()) {
      const item = items[i];
      named.push(
        record.organisationId,
        ...partiesOf(title),
        item.shipper,
        item.consignee,
      );
      for (const code of [item.portOfLoading, item.portOfDischarge]) {
        if (code && !Object.hasOwn(ports, code)) {
          const port = this.ports?.get(code);
          if (port) {
            ports[code] = port;
          }
        }
      }
    }
    const organisationNames = await this.namesOf(named);
    return {items, total: page.total, organisationNames, ports};
  }

  /**
   * The organisations registered and active on the platform (CB-44), `{id, code, name}` each, as
   * identity lists them: whom a carrier's new B/L may name as its shipper or consignee. 503 while
   * identity cannot answer.
   * @return {!Promise<!Array<{id: string, code: string, name: string}>>}
   */
  async activeOrganisations() {
    try {
      return await this.organisations.activeOrganisations();
    } catch (cause) {
      const error = new AppError(
        503,
        'The organisations cannot be listed now: try again later.',
        {code: 'organisations-unavailable'},
      );
      error.cause = cause;
      throw error;
    }
  }

  /**
   * The names of organisations (CB-42), `{id: name}`, each asked of identity once. An
   * organisation identity gives no name for, or every one while identity cannot answer, is left
   * out: the screens then show its id, and a list or a title never fails for a name.
   * @param {!Array<?string>} ids the organisations, repeated or null ones ignored
   * @return {!Promise<!Object<string, string>>}
   */
  async namesOf(ids) {
    const names = new Map();
    if (typeof this.organisations.nameOf !== 'function') {
      return {};
    }
    const unique = new Set(ids.filter(id => typeof id === 'string' && id));
    await Promise.all(
      [...unique].map(async id => {
        try {
          const name = await this.organisations.nameOf(id);
          if (typeof name === 'string' && name !== '') {
            names.set(id, name);
          }
        } catch {
          // identity cannot answer now: the organisation is shown by its id
        }
      }),
    );
    return Object.fromEntries(names);
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
