/**
 * The B/L state machine in table form (CB-30, docs/title-states.md): the kinds, the states and,
 * for each command, the states it runs from, the kinds it applies to and who may run it. Both
 * `applyTitleCommand` and `allowedCommands` work from this table, so the rules live here only.
 */

/** The kinds of B/L. */
export const KINDS = Object.freeze({
  /** A B/L to order (`BOL`, `isToOrder` true): it has a holder and moves by endorsement. */
  NEGOTIABLE: 'negotiable',
  /** A B/L to a named consignee (`BOL`, `isToOrder` false): like a sea waybill, no holder. */
  STRAIGHT: 'straight',
  /** A sea waybill (`SWB`): no holder. */
  WAYBILL: 'waybill',
});

/** Every kind, in the table's order. */
const ALL_KINDS = Object.freeze(Object.values(KINDS));

/** The states each kind of B/L can be in. */
export const STATES = Object.freeze({
  negotiable: Object.freeze([
    'issued',
    'with-holder',
    'surrendered',
    'amendment-requested',
    'accomplished',
    'void',
    'switched-to-paper',
    'split',
  ]),
  straight: Object.freeze(['issued', 'delivered', 'void']),
  waybill: Object.freeze(['issued', 'delivered', 'void']),
});

/** The states nothing more happens in. */
export const END_STATES = Object.freeze([
  'accomplished',
  'void',
  'switched-to-paper',
  'split',
  'delivered',
]);

/** The negotiable states a holder may act from. */
const HELD = Object.freeze(['issued', 'with-holder']);

/**
 * A command's rules.
 *
 * @typedef {object} TitleCommandRule
 * @property {!Array<?string>} from the states it runs from (null: before the B/L is issued)
 * @property {!Array<string>} kinds the kinds of B/L it applies to
 * @property {string} who `carrier` (the issuer), `holder` (the current holder) or `anyone`
 * @property {?string} to the state it leads to (null: it depends on the command's arguments)
 * @property {!Array<string>=} endorsements the endorsements it needs, when it needs one
 */

/**
 * Freezes a value and everything in it, so no other code can change it.
 *
 * @param {T} value an object, array or plain value
 * @return {T} the same value, frozen
 * @template T
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The commands, each with its rules, frozen to the last list.
 *
 * @type {!Readonly<!Object<string, !TitleCommandRule>>}
 */
export const TITLE_COMMANDS = deepFreeze({
  issue: {from: [null], kinds: ALL_KINDS, who: 'anyone', to: 'issued'},
  void: {from: ['issued'], kinds: ALL_KINDS, who: 'carrier', to: 'void'},
  endorse: {
    from: HELD,
    kinds: [KINDS.NEGOTIABLE],
    who: 'holder',
    to: 'with-holder',
  },
  transfer: {
    from: HELD,
    kinds: [KINDS.NEGOTIABLE],
    who: 'holder',
    to: 'with-holder',
    endorsements: ['blank'],
  },
  surrender: {
    from: HELD,
    kinds: [KINDS.NEGOTIABLE],
    who: 'holder',
    to: 'surrendered',
  },
  release: {
    from: ['surrendered'],
    kinds: [KINDS.NEGOTIABLE],
    who: 'carrier',
    to: 'accomplished',
  },
  deliver: {
    from: ['issued'],
    kinds: [KINDS.STRAIGHT, KINDS.WAYBILL],
    who: 'carrier',
    to: 'delivered',
  },
  'surrender-for-amendment': {
    from: HELD,
    kinds: [KINDS.NEGOTIABLE],
    who: 'holder',
    to: 'amendment-requested',
  },
  amend: {
    from: ['amendment-requested'],
    kinds: [KINDS.NEGOTIABLE],
    who: 'carrier',
    to: 'with-holder',
  },
  split: {
    from: ['amendment-requested'],
    kinds: [KINDS.NEGOTIABLE],
    who: 'carrier',
    to: 'split',
  },
  'switch-to-paper': {
    from: HELD,
    kinds: [KINDS.NEGOTIABLE],
    who: 'holder',
    to: 'switched-to-paper',
  },
});

/**
 * The kind of a B/L's document: `SWB` is a sea waybill, `BOL` to order negotiable, `BOL` not to
 * order straight.
 *
 * @param {{transportDocumentTypeCode: string, isToOrder: boolean}} document a DCSA document
 * @return {string} one of `KINDS`
 */
export function kindOf(document) {
  if (document.transportDocumentTypeCode === 'SWB') {
    return KINDS.WAYBILL;
  }
  if (document.isToOrder === true) {
    return KINDS.NEGOTIABLE;
  }
  return KINDS.STRAIGHT;
}
