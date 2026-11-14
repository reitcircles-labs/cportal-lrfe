/**
 * The words of the title engine (CB-30): every reason a command is refused, in one place. Product
 * wording, generic: no country, no legal convention, no tool name.
 */

/** How a reason names each kind of B/L, at the start of a sentence. */
const KIND_NAMES = {
  negotiable: 'A negotiable B/L',
  straight: 'A straight B/L',
  waybill: 'A sea waybill',
};

/** How a reason names each state, after "while it is". */
const STATE_NAMES = {
  issued: 'issued and still with its first holder',
  'with-holder': 'with its holder',
  surrendered: 'surrendered to the carrier',
  'amendment-requested': 'held by the carrier for an amendment',
};

/** How a reason names each end state, after "This B/L is". */
const END_STATE_NAMES = {
  accomplished: 'accomplished',
  void: 'void',
  'switched-to-paper': 'switched to paper',
  split: 'split into new B/Ls',
  delivered: 'delivered',
};

/** How a reason names each module that can be off, before "is not enabled on this platform". */
const MODULE_NAMES = {
  negotiable: 'Negotiable B/Ls are',
  'blank-endorsement': 'Endorsing in blank is',
  amendment: 'Amending a B/L is',
  split: 'Splitting a B/L is',
};

/**
 * Each command as a reason names it: `verb` after "may", `done` after "cannot be".
 */
const COMMAND_NAMES = {
  issue: {verb: 'issue', done: 'issued'},
  void: {verb: 'void', done: 'voided'},
  endorse: {verb: 'endorse', done: 'endorsed'},
  transfer: {verb: 'transfer', done: 'transferred'},
  surrender: {verb: 'surrender', done: 'surrendered'},
  release: {verb: 'release', done: 'released'},
  deliver: {verb: 'deliver', done: 'delivered'},
  'surrender-for-amendment': {
    verb: 'surrender for amendment',
    done: 'surrendered for amendment',
  },
  amend: {verb: 'amend', done: 'amended'},
  split: {verb: 'split', done: 'split'},
  'switch-to-paper': {verb: 'switch to paper', done: 'switched to paper'},
};

/**
 * The value a table holds for a key of its own, never one inherited from `Object.prototype`.
 *
 * @param {!Object} table one of the name tables above
 * @param {*} key a name from outside (a command, a kind, a state)
 * @return {*} the value, or undefined
 */
function ownValue(table, key) {
  if (typeof key !== 'string' || !Object.hasOwn(table, key)) {
    return undefined;
  }
  return table[key];
}

/**
 * The verb of a command, or its name when it has none.
 *
 * @param {string} command a command's name
 * @return {string}
 */
function verbOf(command) {
  return ownValue(COMMAND_NAMES, command)?.verb ?? command;
}

/**
 * The past participle of a command, or its name when it has none.
 *
 * @param {string} command a command's name
 * @return {string}
 */
function doneOf(command) {
  return ownValue(COMMAND_NAMES, command)?.done ?? command;
}

/** The reasons, each a text or a function of the command and title that builds the text. */
export const TITLE_WORDING = Object.freeze({
  /**
   * @param {string} command the unknown name
   * @return {string}
   */
  unknownCommand: command => `Unknown command: ${String(command)}`,

  /**
   * A command of a module that is off in this install.
   *
   * @param {string} module the module that is off
   * @return {string}
   */
  moduleOff: module => {
    const subject = ownValue(MODULE_NAMES, module) ?? `The ${module} module is`;
    return `${subject} not enabled on this platform`;
  },

  notIssued: 'This B/L has not been issued yet: it can only be issued',

  alreadyIssued: 'This B/L is already issued',

  noOrganisation: 'The command needs the organisation that runs it',

  /**
   * @param {*} kind the unknown kind
   * @return {string}
   */
  unknownKind: kind =>
    `Unknown kind of B/L: ${kind} (negotiable, straight or waybill)`,

  missingShipper:
    'A negotiable B/L needs the organisation of its shipper, its first holder',

  /**
   * A command the kind of B/L has no use for.
   *
   * @param {string} kind the title's kind
   * @param {string} command the command's name
   * @return {string}
   */
  wrongKind: (kind, command) => {
    const done = doneOf(command);
    if (kind === 'negotiable') {
      return (
        `${KIND_NAMES.negotiable} cannot be ${done} directly: ` +
        'its holder surrenders it and the carrier releases it'
      );
    }
    const subject = ownValue(KIND_NAMES, kind) ?? 'This B/L';
    return `${subject} has no holder: it cannot be ${done}`;
  },

  /**
   * @param {string} state an end state
   * @return {string}
   */
  closed: state => {
    const name = ownValue(END_STATE_NAMES, state) ?? state;
    return `This B/L is ${name}: nothing more can be done with it`;
  },

  /**
   * @param {string} command the command's name
   * @param {string} state the title's state, not an end state
   * @return {string}
   */
  wrongState: (command, state) => {
    const name = ownValue(STATE_NAMES, state) ?? state;
    return `This B/L cannot be ${doneOf(command)} while it is ${name}`;
  },

  /**
   * @param {string} command the command's name
   * @return {string}
   */
  notCarrier: command =>
    `Only the carrier that issued this B/L may ${verbOf(command)} it`,

  /**
   * @param {string} command the command's name
   * @return {string}
   */
  notHolder: command =>
    `Only the current holder may ${verbOf(command)} this B/L`,

  /**
   * A transfer of a B/L that is not endorsed in blank.
   *
   * @param {string} endorsement the title's endorsement, 'none' or 'named'
   * @return {string}
   */
  notEndorsedInBlank: endorsement => {
    if (endorsement === 'named') {
      return (
        'A B/L endorsed to a named organisation moves only by endorsement, ' +
        'not by transfer'
      );
    }
    return 'A B/L not endorsed yet moves only by endorsement, not by transfer';
  },

  missingRecipient: 'Name the organisation that is to receive the B/L',

  sameHolder: 'This B/L is already held by that organisation',

  inBlankUnstated:
    'Say whether the B/L is endorsed in blank or to the named organisation',

  tooFewChildren: 'A split needs at least two new B/Ls',

  partialRelease:
    'A B/L is released whole: to release part of its cargo, split it into new B/Ls first',

  draftOpen:
    'A new version of this B/L is being drafted or in review: ' +
    'finish or discard that draft before amending or splitting the B/L',

  missingDocument: 'Send the new document of the B/L with its format',

  differentReference:
    'The new document must keep the carrier code and the transport document reference of this B/L',

  kindChanged:
    'The new document must stay a negotiable B/L (a B/L to order): its kind cannot change',

  /**
   * A new B/L of a split whose reference is the parent's or another new B/L's.
   *
   * @param {string} reference the reference given twice
   * @return {string}
   */
  childReference: reference =>
    `Each new B/L needs its own transport document reference: ${String(reference)} is used twice`,

  /**
   * A new B/L of a split whose reference the carrier already has.
   *
   * @param {string} reference
   * @return {string}
   */
  childReferenceTaken: reference =>
    `The carrier already has a B/L with the reference ${String(reference)}`,

  /**
   * A split whose new B/Ls do not carry exactly the B/L's cargo.
   *
   * @param {!Array<string>} problems the reasons, one per container
   * @return {string}
   */
  cargoMismatch: problems => {
    const more =
      problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    return `The cargo of the new B/Ls must add up to the B/L's: ${problems[0]}${more}`;
  },

  bearerUnconfirmed:
    'Switching a blank-endorsed B/L to paper makes it a bearer document: ' +
    'confirm it to go on',
});
