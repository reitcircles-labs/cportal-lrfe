import {expect} from 'chai';

import {
  END_STATES,
  KINDS,
  STATES,
  TITLE_COMMANDS,
  TITLE_WORDING,
  TitleRefusal,
  allowedCommands,
  applyTitleCommand,
  kindOf,
} from '../src/title/index.js';

const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';
const OTHER = 'org-other';
const CONSIGNEE = 'org-consignee';

const carrier = {organisation: CARRIER};
const shipper = {organisation: SHIPPER};
const bank = {organisation: BANK};
const buyer = {organisation: BUYER};
const other = {organisation: OTHER};

/**
 * The refusal a call throws.
 *
 * @param {function(): *} call
 * @return {!TitleRefusal}
 */
function refusalOf(call) {
  try {
    call();
  } catch (error) {
    expect(error).to.be.instanceOf(TitleRefusal);
    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.be.a('string').and.not.equal('');
    return error;
  }
  throw new Error('The command was not refused');
}

/**
 * A title of a kind in a state, as the engine leaves it there.
 *
 * @param {string} kind
 * @param {string} state
 * @return {!Object}
 */
function titleIn(kind, state) {
  const base = {
    kind,
    state,
    carrier: CARRIER,
    holder: null,
    endorsement: 'none',
    consignee: null,
    returnTo: null,
  };
  if (kind !== KINDS.NEGOTIABLE) {
    return {...base, consignee: CONSIGNEE};
  }
  if (state === 'issued') {
    return {...base, holder: SHIPPER};
  }
  if (state === 'with-holder') {
    return {...base, holder: BANK, endorsement: 'blank'};
  }
  if (state === 'surrendered') {
    return {...base, holder: CARRIER, endorsement: 'blank'};
  }
  if (state === 'amendment-requested') {
    return {...base, holder: CARRIER, endorsement: 'named', returnTo: BANK};
  }
  return {...base, endorsement: 'blank'};
}

/**
 * Arguments that a command accepts when it is allowed.
 *
 * @param {string} name
 * @param {string} kind
 * @return {!Object}
 */
function commandFor(name, kind) {
  const args = {
    issue: {shipper: SHIPPER, consignee: CONSIGNEE, kind},
    endorse: {to: BUYER, inBlank: false},
    transfer: {to: BUYER},
    split: {children: 2},
    'switch-to-paper': {confirmBearer: true},
  };
  return {name, ...(args[name] ?? {})};
}

/**
 * The cells that are allowed, written out by hand from the design: `kind state actor command`.
 * Before issue the state is `none` and anyone may issue.
 */
const ALLOWED = new Set([
  'negotiable none anyone issue',
  'straight none anyone issue',
  'waybill none anyone issue',
  'negotiable issued carrier void',
  'negotiable issued holder endorse',
  'negotiable issued holder surrender',
  'negotiable issued holder surrender-for-amendment',
  'negotiable issued holder switch-to-paper',
  'negotiable with-holder holder endorse',
  'negotiable with-holder holder transfer',
  'negotiable with-holder holder surrender',
  'negotiable with-holder holder surrender-for-amendment',
  'negotiable with-holder holder switch-to-paper',
  'negotiable surrendered carrier release',
  'negotiable amendment-requested carrier amend',
  'negotiable amendment-requested carrier split',
  'straight issued carrier void',
  'straight issued carrier deliver',
  'waybill issued carrier void',
  'waybill issued carrier deliver',
]);

/** The commands that only a negotiable B/L has. */
const NEGOTIABLE_ONLY = [
  'endorse',
  'transfer',
  'surrender',
  'release',
  'surrender-for-amendment',
  'amend',
  'split',
  'switch-to-paper',
];

/** The commands only the holder runs; the others (but issue) are the carrier's. */
const HOLDER_COMMANDS = [
  'endorse',
  'transfer',
  'surrender',
  'surrender-for-amendment',
  'switch-to-paper',
];

/** The states each command runs from, written out by hand from the design. */
const FROM = {
  void: ['issued'],
  endorse: ['issued', 'with-holder'],
  transfer: ['issued', 'with-holder'],
  surrender: ['issued', 'with-holder'],
  release: ['surrendered'],
  deliver: ['issued'],
  'surrender-for-amendment': ['issued', 'with-holder'],
  amend: ['amendment-requested'],
  split: ['amendment-requested'],
  'switch-to-paper': ['issued', 'with-holder'],
};

/**
 * The code a refused cell must give, in the engine's order: kind, closed, state, organisation,
 * endorsement.
 *
 * @param {string} kind
 * @param {string} state
 * @param {string} role `carrier`, `holder` or `other`
 * @param {string} name
 * @return {string}
 */
function expectedCode(kind, state, role, name) {
  const negotiableOnly = NEGOTIABLE_ONLY.includes(name);
  if (negotiableOnly !== (kind === KINDS.NEGOTIABLE) && name !== 'void') {
    return 'wrong-kind';
  }
  if (END_STATES.includes(state)) {
    return 'closed';
  }
  if (!FROM[name].includes(state)) {
    return 'wrong-state';
  }
  if (HOLDER_COMMANDS.includes(name)) {
    if (role !== 'holder') {
      return 'not-holder';
    }
    return 'not-endorsed-in-blank';
  }
  return 'not-carrier';
}

/**
 * The actors of a title by role: the carrier, the holder when it is another organisation, and an
 * organisation with no part in it.
 *
 * @param {!Object} title
 * @return {!Array<!Array>} pairs of role and actor
 */
function actorsOf(title) {
  const actors = [
    ['carrier', carrier],
    ['other', other],
  ];
  if (title.holder !== null && title.holder !== title.carrier) {
    actors.push(['holder', {organisation: title.holder}]);
  }
  return actors;
}

describe('title engine (CB-30)', () => {
  describe('kinds', () => {
    it('reads the kind of a DCSA document', () => {
      expect(
        kindOf({transportDocumentTypeCode: 'BOL', isToOrder: true}),
      ).to.equal('negotiable');
      expect(
        kindOf({transportDocumentTypeCode: 'BOL', isToOrder: false}),
      ).to.equal('straight');
      expect(
        kindOf({transportDocumentTypeCode: 'SWB', isToOrder: false}),
      ).to.equal('waybill');
    });

    it('gives each command of the table a rule over known kinds and states', () => {
      for (const [name, rule] of Object.entries(TITLE_COMMANDS)) {
        expect(rule.who, name).to.be.oneOf(['carrier', 'holder', 'anyone']);
        for (const kind of rule.kinds) {
          expect(Object.values(KINDS), name).to.include(kind);
        }
        for (const state of rule.from) {
          if (state !== null) {
            expect(STATES.negotiable.concat(STATES.waybill)).to.include(state);
          }
        }
      }
    });
  });

  describe('every command, state, kind and organisation', () => {
    for (const kind of Object.values(KINDS)) {
      for (const name of Object.keys(TITLE_COMMANDS)) {
        const allowed = ALLOWED.has(`${kind} none anyone ${name}`);
        it(`${kind}, before issue, ${name}: ${allowed ? 'runs' : 'refused'}`, () => {
          const command = commandFor(name, kind);
          for (const actor of [carrier, other]) {
            if (allowed) {
              const {title} = applyTitleCommand(null, command, actor);
              expect(title.state).to.equal('issued');
              expect(title.carrier).to.equal(actor.organisation);
            } else {
              const refusal = refusalOf(() =>
                applyTitleCommand(null, command, actor),
              );
              expect(refusal.code).to.equal('not-issued');
            }
          }
          expect(allowedCommands(null, carrier)).to.deep.equal(['issue']);
        });
      }

      for (const state of STATES[kind]) {
        const title = titleIn(kind, state);
        for (const [role, actor] of actorsOf(title)) {
          for (const name of Object.keys(TITLE_COMMANDS)) {
            const cell = `${kind} ${state} ${role} ${name}`;
            const allowed = ALLOWED.has(cell);
            it(`${cell}: ${allowed ? 'runs' : 'refused'}`, () => {
              const before = structuredClone(title);
              const call = () =>
                applyTitleCommand(title, commandFor(name, kind), actor);
              if (name === 'issue') {
                expect(refusalOf(call).code).to.equal('already-issued');
              } else if (allowed) {
                const {title: next} = call();
                expect(next.state).to.equal(TITLE_COMMANDS[name].to);
                expect(allowedCommands(title, actor)).to.include(name);
              } else {
                const refusal = refusalOf(call);
                expect(refusal.code).to.equal(
                  expectedCode(kind, state, role, name),
                );
                expect(allowedCommands(title, actor)).not.to.include(name);
              }
              expect(title).to.deep.equal(before);
            });
          }
        }
      }
    }
  });

  describe('refusals', () => {
    const issued = titleIn('negotiable', 'issued');
    const waybill = titleIn('waybill', 'issued');

    it('gives clear reasons', () => {
      const cases = [
        [
          () =>
            applyTitleCommand(
              issued,
              {name: 'endorse', to: BANK, inBlank: true},
              other,
            ),
          'Only the current holder may endorse this B/L',
        ],
        [
          () =>
            applyTitleCommand(
              titleIn('negotiable', 'surrendered'),
              {name: 'release'},
              other,
            ),
          'Only the carrier that issued this B/L may release it',
        ],
        [
          () =>
            applyTitleCommand(
              waybill,
              {name: 'endorse', to: BANK, inBlank: true},
              carrier,
            ),
          'A sea waybill has no holder: it cannot be endorsed',
        ],
        [
          () =>
            applyTitleCommand(
              {...issued, state: 'with-holder', endorsement: 'named'},
              {name: 'transfer', to: BANK},
              shipper,
            ),
          'A B/L endorsed to a named organisation moves only by endorsement, not by transfer',
        ],
        [
          () =>
            applyTitleCommand(
              titleIn('negotiable', 'accomplished'),
              {name: 'surrender'},
              carrier,
            ),
          'This B/L is accomplished: nothing more can be done with it',
        ],
        [
          () =>
            applyTitleCommand(
              {...issued, state: 'with-holder', endorsement: 'blank'},
              {name: 'switch-to-paper'},
              shipper,
            ),
          'Switching a blank-endorsed B/L to paper makes it a bearer document: confirm it to go on',
        ],
      ];
      for (const [call, reason] of cases) {
        expect(refusalOf(call).message).to.equal(reason);
      }
    });

    it('keeps every reason in the wording object', () => {
      expect(TITLE_WORDING.notHolder('endorse')).to.equal(
        'Only the current holder may endorse this B/L',
      );
      expect(Object.isFrozen(TITLE_WORDING)).to.equal(true);
    });

    it('refuses to split or endorse a sea waybill: it has no holder', () => {
      expect(
        refusalOf(() =>
          applyTitleCommand(waybill, {name: 'split', children: 2}, carrier),
        ).message,
      ).to.equal('A sea waybill has no holder: it cannot be split');
      expect(waybill.holder).to.equal(null);
    });

    it('refuses an unknown command, a missing organisation and an unknown kind', () => {
      expect(
        refusalOf(() => applyTitleCommand(issued, {name: 'burn'}, carrier))
          .code,
      ).to.equal('unknown-command');
      expect(
        refusalOf(() => applyTitleCommand(issued, {name: 'void'}, {})).code,
      ).to.equal('no-organisation');
      expect(
        refusalOf(() =>
          applyTitleCommand(null, {name: 'issue', kind: 'cheque'}, carrier),
        ).code,
      ).to.equal('unknown-kind');
      expect(allowedCommands(issued, {})).to.deep.equal([]);
    });

    it('refuses names Object.prototype has as unknown commands', () => {
      for (const name of ['toString', 'constructor', '__proto__']) {
        for (const title of [null, issued, waybill]) {
          const refusal = refusalOf(() =>
            applyTitleCommand(title, {name}, carrier),
          );
          expect(refusal.code, name).to.equal('unknown-command');
          expect(refusal.message).to.equal(`Unknown command: ${name}`);
        }
      }
    });

    it('refuses names Object.prototype has as unknown kinds', () => {
      for (const kind of ['toString', 'constructor', '__proto__']) {
        expect(
          refusalOf(() =>
            applyTitleCommand(null, {name: 'issue', kind}, carrier),
          ).code,
        ).to.equal('unknown-kind');
      }
    });

    it('keeps the table of rules unchangeable', () => {
      const rule = TITLE_COMMANDS.transfer;
      expect(Object.isFrozen(TITLE_COMMANDS)).to.equal(true);
      expect(Object.isFrozen(rule)).to.equal(true);
      expect(Object.isFrozen(rule.from)).to.equal(true);
      expect(Object.isFrozen(rule.kinds)).to.equal(true);
      expect(Object.isFrozen(rule.endorsements)).to.equal(true);
      expect(() => {
        rule.who = 'anyone';
      }).to.throw(TypeError);
      expect(() => rule.from.push('surrendered')).to.throw(TypeError);
      expect(() => rule.endorsements.push('named')).to.throw(TypeError);
      expect(() => {
        TITLE_COMMANDS.issue = {};
      }).to.throw(TypeError);
      expect(rule.who).to.equal('holder');
      expect(rule.endorsements).to.deep.equal(['blank']);
    });

    it('refuses a negotiable issue without a shipper', () => {
      expect(
        refusalOf(() =>
          applyTitleCommand(null, {name: 'issue', kind: 'negotiable'}, carrier),
        ).code,
      ).to.equal('missing-shipper');
    });

    it('refuses an endorsement or transfer to nobody or to the holder', () => {
      const cases = [
        [{name: 'endorse', inBlank: true}, 'missing-recipient'],
        [{name: 'endorse', to: SHIPPER, inBlank: true}, 'same-holder'],
        [{name: 'endorse', to: BANK}, 'invalid-argument'],
        [{name: 'transfer'}, 'missing-recipient'],
        [{name: 'transfer', to: SHIPPER}, 'same-holder'],
      ];
      const blank = {...issued, state: 'with-holder', holder: SHIPPER};
      blank.endorsement = 'blank';
      for (const [command, code] of cases) {
        expect(
          refusalOf(() => applyTitleCommand(blank, command, shipper)).code,
        ).to.equal(code);
      }
    });

    it('refuses a transfer of a B/L not endorsed yet', () => {
      const refusal = refusalOf(() =>
        applyTitleCommand(issued, {name: 'transfer', to: BANK}, shipper),
      );
      expect(refusal.code).to.equal('not-endorsed-in-blank');
      expect(allowedCommands(issued, shipper)).not.to.include('transfer');
    });

    it('refuses a split into fewer than two', () => {
      const held = titleIn('negotiable', 'amendment-requested');
      for (const children of [undefined, 1, 2.5]) {
        expect(
          refusalOf(() =>
            applyTitleCommand(held, {name: 'split', children}, carrier),
          ).code,
        ).to.equal('too-few-children');
      }
    });
  });

  describe('journeys', () => {
    it('negotiable: issue, blank to the bank, transfer, named to the buyer, surrender, release', () => {
      let {title} = applyTitleCommand(
        null,
        {name: 'issue', kind: 'negotiable', shipper: SHIPPER},
        carrier,
      );
      expect(title).to.deep.equal({
        kind: 'negotiable',
        state: 'issued',
        carrier: CARRIER,
        holder: SHIPPER,
        endorsement: 'none',
        consignee: null,
        returnTo: null,
      });
      ({title} = applyTitleCommand(
        title,
        {name: 'endorse', to: BANK, inBlank: true},
        shipper,
      ));
      expect(title).to.include({
        state: 'with-holder',
        holder: BANK,
        endorsement: 'blank',
      });
      ({title} = applyTitleCommand(title, {name: 'transfer', to: OTHER}, bank));
      expect(title).to.include({holder: OTHER, endorsement: 'blank'});
      ({title} = applyTitleCommand(
        title,
        {name: 'endorse', to: BUYER, inBlank: false},
        other,
      ));
      expect(title).to.include({holder: BUYER, endorsement: 'named'});
      expect(
        refusalOf(() =>
          applyTitleCommand(title, {name: 'transfer', to: BANK}, buyer),
        ).code,
      ).to.equal('not-endorsed-in-blank');
      expect(allowedCommands(title, buyer)).to.deep.equal([
        'endorse',
        'surrender',
        'surrender-for-amendment',
        'switch-to-paper',
      ]);
      ({title} = applyTitleCommand(title, {name: 'surrender'}, buyer));
      expect(title).to.include({state: 'surrendered', holder: CARRIER});
      expect(allowedCommands(title, carrier)).to.deep.equal(['release']);
      ({title} = applyTitleCommand(title, {name: 'release'}, carrier));
      expect(title).to.include({state: 'accomplished', holder: null});
      expect(allowedCommands(title, carrier)).to.deep.equal([]);
    });

    it('amendment round trip: the B/L goes back to the holder', () => {
      let title = titleIn('negotiable', 'with-holder');
      ({title} = applyTitleCommand(
        title,
        {name: 'surrender-for-amendment'},
        bank,
      ));
      expect(title).to.include({
        state: 'amendment-requested',
        holder: CARRIER,
        returnTo: BANK,
      });
      expect(allowedCommands(title, carrier)).to.deep.equal(['amend', 'split']);
      expect(allowedCommands(title, bank)).to.deep.equal([]);
      ({title} = applyTitleCommand(title, {name: 'amend'}, carrier));
      expect(title).to.include({
        state: 'with-holder',
        holder: BANK,
        returnTo: null,
        endorsement: 'blank',
      });
    });

    it('split: the parent closes, the children are held by the holder', () => {
      for (const endorsement of ['named', 'blank']) {
        let title = {...titleIn('negotiable', 'with-holder'), endorsement};
        ({title} = applyTitleCommand(
          title,
          {name: 'surrender-for-amendment'},
          bank,
        ));
        const result = applyTitleCommand(
          title,
          {name: 'split', children: 3},
          carrier,
        );
        expect(result.title).to.include({state: 'split', holder: null});
        expect(result.children).to.have.length(3);
        for (const child of result.children) {
          expect(child).to.deep.equal({
            kind: 'negotiable',
            state: 'with-holder',
            carrier: CARRIER,
            holder: BANK,
            endorsement,
            consignee: null,
            returnTo: null,
          });
        }
      }
    });

    it('switch to paper: a named B/L goes; a blank one only when confirmed', () => {
      const named = {...titleIn('negotiable', 'with-holder')};
      named.endorsement = 'named';
      expect(
        applyTitleCommand(named, {name: 'switch-to-paper'}, bank).title,
      ).to.include({state: 'switched-to-paper', holder: null});

      const blank = titleIn('negotiable', 'with-holder');
      const refusal = refusalOf(() =>
        applyTitleCommand(blank, {name: 'switch-to-paper'}, bank),
      );
      expect(refusal.code).to.equal('bearer-unconfirmed');
      expect(refusal.message).to.contain('bearer document');
      expect(
        applyTitleCommand(
          blank,
          {name: 'switch-to-paper', confirmBearer: true},
          bank,
        ).title,
      ).to.include({state: 'switched-to-paper', holder: null});
    });

    for (const kind of ['waybill', 'straight']) {
      it(`${kind}: issue, then deliver; it never has a holder`, () => {
        let {title} = applyTitleCommand(
          null,
          {name: 'issue', kind, shipper: SHIPPER, consignee: CONSIGNEE},
          carrier,
        );
        expect(title).to.deep.equal({
          kind,
          state: 'issued',
          carrier: CARRIER,
          holder: null,
          endorsement: 'none',
          consignee: CONSIGNEE,
          returnTo: null,
        });
        expect(allowedCommands(title, carrier)).to.deep.equal([
          'void',
          'deliver',
        ]);
        expect(allowedCommands(title, shipper)).to.deep.equal([]);
        ({title} = applyTitleCommand(title, {name: 'deliver'}, carrier));
        expect(title).to.include({state: 'delivered', holder: null});
      });
    }

    it('void: before a transfer, not after', () => {
      const {title} = applyTitleCommand(
        null,
        {name: 'issue', kind: 'negotiable', shipper: SHIPPER},
        carrier,
      );
      expect(
        applyTitleCommand(title, {name: 'void'}, carrier).title,
      ).to.include({state: 'void', holder: null});

      const moved = applyTitleCommand(
        title,
        {name: 'endorse', to: BANK, inBlank: true},
        shipper,
      ).title;
      const refusal = refusalOf(() =>
        applyTitleCommand(moved, {name: 'void'}, carrier),
      );
      expect(refusal.code).to.equal('wrong-state');
    });
  });
});
