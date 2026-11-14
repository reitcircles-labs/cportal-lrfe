import {ALL_MODULES, moduleOff} from './modules.js';
import {END_STATES, KINDS, TITLE_COMMANDS} from './table.js';
import {TITLE_WORDING} from './wording.js';

/**
 * The title engine (CB-30): who may run which command on a B/L's title, and the title it leads
 * to. Pure: it stores nothing and checks no registration (the service's business, CB-34).
 *
 * A title is
 *
 *     {kind, state, carrier, holder, endorsement, consignee, returnTo}
 *
 * - `carrier`: the organisation that issued the B/L;
 * - `holder`: the organisation holding a negotiable B/L, or null (never one for the other kinds);
 * - `endorsement`: `none`, `named` or `blank`;
 * - `consignee`: the organisation of a non-negotiable B/L's consignee, or null;
 * - `returnTo`: while the carrier holds the B/L for an amendment, the holder it goes back to.
 *
 * Both functions take the modules on in the install (CB-38, `modules.js`; all by default): a
 * command of a module that is off is refused before any other rule, and nothing else changes.
 */

/**
 * A B/L's title.
 *
 * @typedef {object} Title
 * @property {string} kind one of `KINDS`
 * @property {string} state one of the kind's `STATES`
 * @property {string} carrier the organisation id of the issuer
 * @property {?string} holder the organisation id of the holder
 * @property {string} endorsement `none`, `named` or `blank`
 * @property {?string} consignee the organisation id of the consignee (non-negotiable kinds)
 * @property {?string} returnTo the organisation id the B/L goes back to after an amendment
 */

/** A command refused: `code` is stable, `message` the reason for people. */
export class TitleRefusal extends Error {
  /**
   * @param {string} code the stable code of the reason
   * @param {string} message the reason
   */
  constructor(code, message) {
    super(message);
    this.name = 'TitleRefusal';
    /** @const {string} */
    this.code = code;
  }
}

/**
 * Whether a value names an organisation.
 *
 * @param {*} value
 * @return {boolean}
 */
function isOrganisation(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * The options of the engine's functions.
 *
 * @typedef {object} TitleOptions
 * @property {!ReadonlyArray<string>=} modules the names of the modules on (`modulesFromSettings`);
 *     all by default
 */

/**
 * The module a command's case belongs to: by the kind of B/L for issue and void (the title's, or
 * the one issued), in blank or to a name for endorse.
 *
 * @param {!TitleCommandRule} rule the command's rule
 * @param {?Title} title the title, null before issue
 * @param {!Object} command the command and its arguments
 * @return {string} the module's name
 */
function moduleOf(rule, title, command) {
  if (rule.moduleOfKind) {
    const kind = title?.kind ?? command.kind;
    if (typeof kind === 'string' && Object.hasOwn(rule.moduleOfKind, kind)) {
      return rule.moduleOfKind[kind];
    }
  }
  if (rule.moduleInBlank && command.inBlank === true) {
    return rule.moduleInBlank;
  }
  return rule.module;
}

/**
 * Throws the refusal of a command that its rule does not allow: its module, the kind, the state,
 * the actor or the endorsement (its arguments are checked by its effect). The first rule broken is
 * the reason.
 *
 * @param {?Title} title the title, null before issue
 * @param {!Object} command the command's name and its arguments
 * @param {{organisation: string}} actor the organisation running it
 * @param {!ReadonlyArray<string>} modules the modules on
 * @return {void}
 * @throws {TitleRefusal}
 */
function checkRule(title, command, actor, modules) {
  const name = command.name;
  if (typeof name !== 'string' || !Object.hasOwn(TITLE_COMMANDS, name)) {
    throw new TitleRefusal(
      'unknown-command',
      TITLE_WORDING.unknownCommand(name),
    );
  }
  const rule = TITLE_COMMANDS[name];
  const off = moduleOff(moduleOf(rule, title, command), modules);
  if (off !== null) {
    throw new TitleRefusal('module-off', TITLE_WORDING.moduleOff(off));
  }
  if (title === null && name !== 'issue') {
    throw new TitleRefusal('not-issued', TITLE_WORDING.notIssued);
  }
  if (title !== null && name === 'issue') {
    throw new TitleRefusal('already-issued', TITLE_WORDING.alreadyIssued);
  }
  if (!isOrganisation(actor?.organisation)) {
    throw new TitleRefusal('no-organisation', TITLE_WORDING.noOrganisation);
  }
  if (title === null) {
    return;
  }
  if (!rule.kinds.includes(title.kind)) {
    throw new TitleRefusal(
      'wrong-kind',
      TITLE_WORDING.wrongKind(title.kind, name),
    );
  }
  if (END_STATES.includes(title.state)) {
    throw new TitleRefusal('closed', TITLE_WORDING.closed(title.state));
  }
  if (!rule.from.includes(title.state)) {
    throw new TitleRefusal(
      'wrong-state',
      TITLE_WORDING.wrongState(name, title.state),
    );
  }
  if (rule.who === 'carrier' && actor.organisation !== title.carrier) {
    throw new TitleRefusal('not-carrier', TITLE_WORDING.notCarrier(name));
  }
  if (rule.who === 'holder' && actor.organisation !== title.holder) {
    throw new TitleRefusal('not-holder', TITLE_WORDING.notHolder(name));
  }
  if (rule.endorsements && !rule.endorsements.includes(title.endorsement)) {
    throw new TitleRefusal(
      'not-endorsed-in-blank',
      TITLE_WORDING.notEndorsedInBlank(title.endorsement),
    );
  }
}

/**
 * Checks the organisation a B/L moves to: named, and not its holder already.
 *
 * @param {!Title} title the title
 * @param {*} to the organisation named by the command
 * @return {void}
 * @throws {TitleRefusal}
 */
function checkRecipient(title, to) {
  if (!isOrganisation(to)) {
    throw new TitleRefusal('missing-recipient', TITLE_WORDING.missingRecipient);
  }
  if (to === title.holder) {
    throw new TitleRefusal('same-holder', TITLE_WORDING.sameHolder);
  }
}

/**
 * The title of a B/L just issued.
 *
 * @param {{shipper: ?string, consignee: ?string, kind: string}} command the command
 * @param {{organisation: string}} actor the carrier
 * @return {{title: !Title}}
 * @throws {TitleRefusal}
 */
function issue(command, actor) {
  const kinds = Object.values(KINDS);
  if (!kinds.includes(command.kind)) {
    throw new TitleRefusal(
      'unknown-kind',
      TITLE_WORDING.unknownKind(command.kind),
    );
  }
  if (command.kind === KINDS.NEGOTIABLE) {
    if (!isOrganisation(command.shipper)) {
      throw new TitleRefusal('missing-shipper', TITLE_WORDING.missingShipper);
    }
    return {
      title: {
        kind: command.kind,
        state: 'issued',
        carrier: actor.organisation,
        holder: command.shipper,
        endorsement: 'none',
        consignee: null,
        returnTo: null,
      },
    };
  }
  return {
    title: {
      kind: command.kind,
      state: 'issued',
      carrier: actor.organisation,
      holder: null,
      endorsement: 'none',
      consignee: command.consignee ?? null,
      returnTo: null,
    },
  };
}

/**
 * What each command does to a title its rule allows, given its arguments.
 *
 * @type {!Object<string, function(!Title, !Object): {title: !Title}>}
 */
const EFFECTS = {
  /**
   * @param {!Title} title
   * @return {{title: !Title}}
   */
  void: title => ({title: {...title, state: 'void', holder: null}}),

  /**
   * @param {!Title} title
   * @param {{to: string, inBlank: boolean}} command
   * @return {{title: !Title}}
   */
  endorse: (title, command) => {
    checkRecipient(title, command.to);
    if (typeof command.inBlank !== 'boolean') {
      throw new TitleRefusal('invalid-argument', TITLE_WORDING.inBlankUnstated);
    }
    let endorsement = 'named';
    if (command.inBlank) {
      endorsement = 'blank';
    }
    return {
      title: {...title, state: 'with-holder', holder: command.to, endorsement},
    };
  },

  /**
   * @param {!Title} title
   * @param {{to: string}} command
   * @return {{title: !Title}}
   */
  transfer: (title, command) => {
    checkRecipient(title, command.to);
    return {title: {...title, state: 'with-holder', holder: command.to}};
  },

  /**
   * @param {!Title} title
   * @return {{title: !Title}}
   */
  surrender: title => ({
    title: {...title, state: 'surrendered', holder: title.carrier},
  }),

  /**
   * @param {!Title} title
   * @return {{title: !Title}}
   */
  release: title => ({
    title: {...title, state: 'accomplished', holder: null},
  }),

  /**
   * @param {!Title} title
   * @return {{title: !Title}}
   */
  deliver: title => ({title: {...title, state: 'delivered'}}),

  /**
   * @param {!Title} title
   * @return {{title: !Title}}
   */
  'surrender-for-amendment': title => ({
    title: {
      ...title,
      state: 'amendment-requested',
      holder: title.carrier,
      returnTo: title.holder,
    },
  }),

  /**
   * @param {!Title} title
   * @return {{title: !Title}}
   */
  amend: title => ({
    title: {
      ...title,
      state: 'with-holder',
      holder: title.returnTo,
      returnTo: null,
    },
  }),

  /**
   * The parent closes; each child is a negotiable B/L of the same carrier held by the organisation
   * the parent was to go back to, endorsed as the parent was.
   *
   * @param {!Title} title
   * @param {{children: number}} command
   * @return {{title: !Title, children: !Array<!Title>}}
   */
  split: (title, command) => {
    if (!Number.isInteger(command.children) || command.children < 2) {
      throw new TitleRefusal('too-few-children', TITLE_WORDING.tooFewChildren);
    }
    const children = [];
    for (let i = 0; i < command.children; i++) {
      children.push({
        kind: KINDS.NEGOTIABLE,
        state: 'with-holder',
        carrier: title.carrier,
        holder: title.returnTo,
        endorsement: title.endorsement,
        consignee: null,
        returnTo: null,
      });
    }
    return {
      title: {...title, state: 'split', holder: null, returnTo: null},
      children,
    };
  },

  /**
   * @param {!Title} title
   * @param {{confirmBearer: (boolean|undefined)}} command
   * @return {{title: !Title}}
   */
  'switch-to-paper': (title, command) => {
    if (title.endorsement === 'blank' && command.confirmBearer !== true) {
      throw new TitleRefusal(
        'bearer-unconfirmed',
        TITLE_WORDING.bearerUnconfirmed,
      );
    }
    return {title: {...title, state: 'switched-to-paper', holder: null}};
  },
};

/**
 * Runs a command on a B/L's title.
 *
 * @param {?Title} title the title, null before the B/L is issued
 * @param {{name: string}} command the command's name and its arguments
 * @param {{organisation: string}} actor the organisation running it
 * @param {!TitleOptions=} options the modules on
 * @return {{title: !Title, children: (!Array<!Title>|undefined)}} the next title (a split also
 *     gives its children's first titles); the title given is not changed
 * @throws {TitleRefusal} when the command is not allowed, with the reason
 */
export function applyTitleCommand(
  title,
  command,
  actor,
  {modules = ALL_MODULES} = {},
) {
  const name = command?.name;
  checkRule(title, command ?? {}, actor, modules);
  if (name === 'issue') {
    return issue(command, actor);
  }
  return EFFECTS[name](title, command);
}

/**
 * The commands an organisation may run on a B/L's title now (their arguments aside: endorse is
 * listed when it may endorse to a name).
 *
 * @param {?Title} title the title, null before the B/L is issued
 * @param {{organisation: string}} actor the organisation
 * @param {!TitleOptions=} options the modules on
 * @return {!Array<string>} the command names, in the table's order
 */
export function allowedCommands(title, actor, {modules = ALL_MODULES} = {}) {
  const allowed = [];
  for (const name of Object.keys(TITLE_COMMANDS)) {
    try {
      checkRule(title, {name}, actor, modules);
      allowed.push(name);
    } catch (error) {
      if (!(error instanceof TitleRefusal)) {
        throw error;
      }
    }
  }
  return allowed;
}
