import {expect} from 'chai';

import {
  MODULES,
  MODULES_SETTING,
  TITLE_COMMANDS,
  TitleRefusal,
  allowedCommands,
  applyTitleCommand,
  modulesFromSettings,
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
const other = {organisation: OTHER};

/** Every module's name, written out by hand from the design. */
const ALL = [
  'waybill',
  'negotiable',
  'blank-endorsement',
  'amendment',
  'split',
];

/** The modules a module takes off with it (itself and those that need it), by hand. */
const OFF_WITH = {
  negotiable: ['negotiable', 'blank-endorsement', 'amendment', 'split'],
  'blank-endorsement': ['blank-endorsement'],
  amendment: ['amendment', 'split'],
  split: ['split'],
};

/** The reason of each module that is off, by hand. */
const REASONS = {
  negotiable: 'Negotiable B/Ls are not enabled on this platform',
  'blank-endorsement': 'Endorsing in blank is not enabled on this platform',
  amendment: 'Amending a B/L is not enabled on this platform',
  split: 'Splitting a B/L is not enabled on this platform',
};

/**
 * A negotiable title in a state, as the engine leaves it there.
 *
 * @param {string} state
 * @param {!Object=} changes
 * @return {!Object}
 */
function negotiable(state, changes = {}) {
  return {
    kind: 'negotiable',
    state,
    carrier: CARRIER,
    holder: SHIPPER,
    endorsement: 'none',
    consignee: null,
    returnTo: null,
    ...changes,
  };
}

/**
 * A straight B/L or sea waybill just issued.
 *
 * @param {string} kind
 * @return {!Object}
 */
function nonNegotiable(kind) {
  return {
    kind,
    state: 'issued',
    carrier: CARRIER,
    holder: null,
    endorsement: 'none',
    consignee: CONSIGNEE,
    returnTo: null,
  };
}

/**
 * Every case of a command, with the module it belongs to and a title and actor it runs for when
 * every module is on: written out by hand from the design.
 */
const CASES = [
  {
    module: 'waybill',
    label: 'issue of a sea waybill',
    title: null,
    command: {name: 'issue', kind: 'waybill', consignee: CONSIGNEE},
    actor: carrier,
  },
  {
    module: 'waybill',
    label: 'issue of a straight B/L',
    title: null,
    command: {name: 'issue', kind: 'straight', consignee: CONSIGNEE},
    actor: carrier,
  },
  {
    module: 'waybill',
    label: 'void of a sea waybill',
    title: nonNegotiable('waybill'),
    command: {name: 'void'},
    actor: carrier,
  },
  {
    module: 'waybill',
    label: 'void of a straight B/L',
    title: nonNegotiable('straight'),
    command: {name: 'void'},
    actor: carrier,
  },
  {
    module: 'waybill',
    label: 'deliver',
    title: nonNegotiable('waybill'),
    command: {name: 'deliver'},
    actor: carrier,
  },
  {
    module: 'negotiable',
    label: 'issue of a B/L to order',
    title: null,
    command: {name: 'issue', kind: 'negotiable', shipper: SHIPPER},
    actor: carrier,
  },
  {
    module: 'negotiable',
    label: 'void of a negotiable B/L',
    title: negotiable('issued'),
    command: {name: 'void'},
    actor: carrier,
  },
  {
    module: 'negotiable',
    label: 'endorse to a name',
    title: negotiable('issued'),
    command: {name: 'endorse', to: BANK, inBlank: false},
    actor: shipper,
  },
  {
    module: 'negotiable',
    label: 'surrender',
    title: negotiable('issued'),
    command: {name: 'surrender'},
    actor: shipper,
  },
  {
    module: 'negotiable',
    label: 'release',
    title: negotiable('surrendered', {holder: CARRIER}),
    command: {name: 'release'},
    actor: carrier,
  },
  {
    module: 'negotiable',
    label: 'switch to paper',
    title: negotiable('issued'),
    command: {name: 'switch-to-paper'},
    actor: shipper,
  },
  {
    module: 'blank-endorsement',
    label: 'endorse in blank',
    title: negotiable('issued'),
    command: {name: 'endorse', to: BANK, inBlank: true},
    actor: shipper,
  },
  {
    module: 'blank-endorsement',
    label: 'transfer',
    title: negotiable('with-holder', {holder: BANK, endorsement: 'blank'}),
    command: {name: 'transfer', to: BUYER},
    actor: bank,
  },
  {
    module: 'amendment',
    label: 'surrender for amendment',
    title: negotiable('issued'),
    command: {name: 'surrender-for-amendment'},
    actor: shipper,
  },
  {
    module: 'amendment',
    label: 'amend',
    title: negotiable('amendment-requested', {holder: CARRIER, returnTo: BANK}),
    command: {name: 'amend'},
    actor: carrier,
  },
  {
    module: 'split',
    label: 'split',
    title: negotiable('amendment-requested', {holder: CARRIER, returnTo: BANK}),
    command: {name: 'split', children: 2},
    actor: carrier,
  },
];

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
    return error;
  }
  throw new Error('The command was not refused');
}

/**
 * Whether a command is still allowed, by another case of it, when some modules are off: issue
 * (a sea waybill can always be issued) and endorse to a name while only blank endorsement is off.
 *
 * @param {!Object} testCase
 * @param {!Array<string>} off the modules off
 * @return {boolean}
 */
function stillListed(testCase, off) {
  if (testCase.command.name === 'issue') {
    return true;
  }
  return testCase.command.name === 'endorse' && !off.includes('negotiable');
}

describe('title modules (CB-38)', () => {
  describe('the modules', () => {
    it('lists each module with its label, needs and commands', () => {
      expect(Object.keys(MODULES)).to.deep.equal(ALL);
      for (const [name, module] of Object.entries(MODULES)) {
        expect(module.name).to.equal(name);
        expect(module.label).to.be.a('string').and.not.equal('');
        expect(Object.isFrozen(module)).to.equal(true);
      }
      expect(MODULES.negotiable.needs).to.deep.equal([]);
      expect(MODULES['blank-endorsement'].needs).to.deep.equal(['negotiable']);
      expect(MODULES.amendment.needs).to.deep.equal(['negotiable']);
      expect(MODULES.split.needs).to.deep.equal(['amendment']);
      expect(MODULES.waybill.commands).to.deep.equal([
        'issue',
        'void',
        'deliver',
      ]);
      expect(MODULES.negotiable.commands).to.deep.equal([
        'issue',
        'void',
        'endorse',
        'surrender',
        'release',
        'switch-to-paper',
      ]);
      expect(MODULES['blank-endorsement'].commands).to.deep.equal([
        'endorse',
        'transfer',
      ]);
      expect(MODULES.amendment.commands).to.deep.equal([
        'surrender-for-amendment',
        'amend',
      ]);
      expect(MODULES.split.commands).to.deep.equal(['split']);
    });

    it('gives every command of the table a known module', () => {
      for (const [name, rule] of Object.entries(TITLE_COMMANDS)) {
        const modules = [
          rule.module,
          ...Object.values(rule.moduleOfKind ?? {}),
        ];
        if (rule.moduleInBlank) {
          modules.push(rule.moduleInBlank);
        }
        for (const module of modules) {
          expect(Object.hasOwn(MODULES, module), `${name}: ${module}`).to.equal(
            true,
          );
        }
      }
    });
  });

  describe('every module switched off, every case of a command', () => {
    for (const [module, off] of Object.entries(OFF_WITH)) {
      const on = ALL.filter(name => !off.includes(name));
      for (const testCase of CASES) {
        const refused = off.includes(testCase.module);
        it(`${module} off: ${testCase.label} ${refused ? 'refused' : 'runs'}`, () => {
          const {title, command, actor} = testCase;
          const before = structuredClone(title);
          expect(applyTitleCommand(title, command, actor).title).to.be.an(
            'object',
          );
          expect(allowedCommands(title, actor)).to.include(command.name);
          const call = () =>
            applyTitleCommand(title, command, actor, {modules: on});
          const listed = allowedCommands(title, actor, {modules: on});
          if (refused) {
            const refusal = refusalOf(call);
            expect(refusal.code).to.equal('module-off');
            expect(refusal.message).to.equal(REASONS[module]);
            if (stillListed(testCase, off)) {
              expect(listed).to.include(command.name);
            } else {
              expect(listed).not.to.include(command.name);
            }
            // The module comes before every rule of the state and the organisation.
            const byOther = refusalOf(() =>
              applyTitleCommand(title, command, other, {modules: on}),
            );
            expect(byOther.code).to.equal('module-off');
          } else {
            expect(call().title).to.be.an('object');
            expect(listed).to.include(command.name);
          }
          expect(title).to.deep.equal(before);
        });
      }
    }

    it('lists nothing but the waybill commands when only waybill is on', () => {
      const modules = ['waybill'];
      expect(allowedCommands(null, carrier, {modules})).to.deep.equal([
        'issue',
      ]);
      expect(
        allowedCommands(nonNegotiable('straight'), carrier, {modules}),
      ).to.deep.equal(['void', 'deliver']);
      expect(
        allowedCommands(negotiable('issued'), carrier, {modules}),
      ).to.deep.equal([]);
      expect(
        allowedCommands(negotiable('issued'), shipper, {modules}),
      ).to.deep.equal([]);
    });

    it('names the most basic module off when one it needs is off too', () => {
      const amendmentRequested = negotiable('amendment-requested', {
        holder: CARRIER,
        returnTo: BANK,
      });
      const refusal = refusalOf(() =>
        applyTitleCommand(
          amendmentRequested,
          {name: 'split', children: 2},
          carrier,
          {modules: ['waybill', 'split']},
        ),
      );
      expect(refusal.code).to.equal('module-off');
      expect(refusal.message).to.equal(REASONS.negotiable);
    });

    it('keeps waybill on even when the list given leaves it out', () => {
      const {title} = applyTitleCommand(
        null,
        {name: 'issue', kind: 'waybill', consignee: CONSIGNEE},
        carrier,
        {modules: []},
      );
      expect(title.state).to.equal('issued');
    });

    it('lets an unknown kind or command answer with its own refusal', () => {
      const modules = ['waybill'];
      const unknownKind = refusalOf(() =>
        applyTitleCommand(null, {name: 'issue', kind: 'raft'}, carrier, {
          modules,
        }),
      );
      expect(unknownKind.code).to.equal('unknown-kind');
      const unknownCommand = refusalOf(() =>
        applyTitleCommand(negotiable('issued'), {name: 'burn'}, carrier, {
          modules,
        }),
      );
      expect(unknownCommand.code).to.equal('unknown-command');
    });
  });

  describe('a title made while a module was on', () => {
    // Made with every module on: issued, then endorsed in blank to the bank.
    const issued = applyTitleCommand(
      null,
      {name: 'issue', kind: 'negotiable', shipper: SHIPPER},
      carrier,
    ).title;
    const blankEndorsed = applyTitleCommand(
      issued,
      {name: 'endorse', to: BANK, inBlank: true},
      shipper,
    ).title;

    it('stays as it was and readable with negotiable off', () => {
      const before = structuredClone(blankEndorsed);
      expect(blankEndorsed).to.deep.equal({
        kind: 'negotiable',
        state: 'with-holder',
        carrier: CARRIER,
        holder: BANK,
        endorsement: 'blank',
        consignee: null,
        returnTo: null,
      });
      const modules = ['waybill'];
      for (const actor of [carrier, bank, other]) {
        expect(allowedCommands(blankEndorsed, actor, {modules})).to.deep.equal(
          [],
        );
      }
      for (const name of Object.keys(TITLE_COMMANDS)) {
        // Issue and deliver are not a negotiable B/L's commands: their own refusals answer.
        if (name === 'issue' || name === 'deliver') {
          continue;
        }
        const refusal = refusalOf(() =>
          applyTitleCommand(
            blankEndorsed,
            {name, to: BUYER, inBlank: false},
            bank,
            {
              modules,
            },
          ),
        );
        expect(refusal.code, name).to.equal('module-off');
        expect(refusal.message, name).to.equal(REASONS.negotiable);
      }
      expect(blankEndorsed).to.deep.equal(before);
    });

    it('goes on by name with blank endorsement off', () => {
      const modules = ['waybill', 'negotiable'];
      expect(allowedCommands(blankEndorsed, bank, {modules})).to.deep.equal([
        'endorse',
        'surrender',
        'switch-to-paper',
      ]);
      const transfer = refusalOf(() =>
        applyTitleCommand(blankEndorsed, {name: 'transfer', to: BUYER}, bank, {
          modules,
        }),
      );
      expect(transfer.message).to.equal(REASONS['blank-endorsement']);
      const {title} = applyTitleCommand(
        blankEndorsed,
        {name: 'endorse', to: BUYER, inBlank: false},
        bank,
        {modules},
      );
      expect(title).to.include({holder: BUYER, endorsement: 'named'});
    });
  });

  describe('the setting', () => {
    /**
     * The modules on for a value of the setting.
     *
     * @param {(string|undefined)} value
     * @return {!ReadonlyArray<string>}
     */
    const read = value => modulesFromSettings({[MODULES_SETTING]: value});

    it('turns every module on when not set or blank', () => {
      expect(MODULES_SETTING).to.equal('LRFE_BL_MODULES');
      expect(modulesFromSettings({})).to.deep.equal(ALL);
      expect(read(undefined)).to.deep.equal(ALL);
      expect(read('')).to.deep.equal(ALL);
      expect(read('  ')).to.deep.equal(ALL);
    });

    it('reads a list in the modules order, always with waybill', () => {
      expect(read('waybill')).to.deep.equal(['waybill']);
      expect(read('negotiable')).to.deep.equal(['waybill', 'negotiable']);
      expect(read(' split , amendment,negotiable,negotiable ')).to.deep.equal([
        'waybill',
        'negotiable',
        'amendment',
        'split',
      ]);
      expect(Object.isFrozen(read('negotiable'))).to.equal(true);
    });

    it('stops the start on an unknown name', () => {
      for (const value of ['negotiable,boat', 'toString', '__proto__']) {
        expect(() => read(value), value).to.throw(
          /LRFE_BL_MODULES names an unknown B\/L module: .*Known modules: waybill, negotiable, blank-endorsement, amendment, split/,
        );
      }
      expect(() => read('negotiable,boat')).to.throw(/module: boat\./);
    });

    it('stops the start on an empty name', () => {
      expect(() => read('negotiable,,split')).to.throw(
        /LRFE_BL_MODULES has an empty name in its list\. Known modules: waybill/,
      );
      expect(() => read('negotiable,')).to.throw(/empty name/);
    });

    it('stops the start on a module without the one it needs', () => {
      expect(() => read('blank-endorsement')).to.throw(
        /LRFE_BL_MODULES turns on blank-endorsement, which needs negotiable: add negotiable or remove blank-endorsement\. Known modules: /,
      );
      expect(() => read('negotiable,split')).to.throw(
        /turns on split, which needs amendment/,
      );
      expect(() => read('amendment,split')).to.throw(
        /turns on amendment, which needs negotiable/,
      );
    });
  });
});
