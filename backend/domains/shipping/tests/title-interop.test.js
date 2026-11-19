import {expect} from 'chai';

import {
  END_STATES,
  KINDS,
  STATES,
  TITLE_COMMANDS,
  TitleRefusal,
  allowedCommands,
  applyTitleCommand,
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
 * The refusal a synchronous call throws.
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
 * A negotiable title in the given state.
 *
 * @param {string} state
 * @param {!Object=} overrides
 * @return {!Object}
 */
function negotiableTitle(state, overrides = {}) {
  return {
    kind: KINDS.NEGOTIABLE,
    state,
    carrier: CARRIER,
    holder: BANK,
    endorsement: 'named',
    consignee: null,
    returnTo: null,
    ...overrides,
  };
}

/**
 * A non-negotiable title in `issued` state.
 *
 * @param {string} kind
 * @return {!Object}
 */
function nonNegotiableTitle(kind) {
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

describe('title engine cross-platform interop (CB-55)', () => {
  it('declares transfer-pending, transferred-out and arrived as non-end states with transfer-out and accept-incoming commands', () => {
    expect(STATES.negotiable).to.include.members([
      'transfer-pending',
      'transferred-out',
      'arrived',
    ]);
    for (const state of ['transfer-pending', 'transferred-out', 'arrived']) {
      expect(END_STATES, state).not.to.include(state);
    }
    expect(Object.keys(TITLE_COMMANDS)).to.include.members([
      'transfer-out',
      'accept-incoming',
    ]);
  });

  it('transfer-out moves an issued or with-holder negotiable B/L to transfer-pending while keeping the holder', () => {
    const command = {
      name: 'transfer-out',
      platform: 'MERIDIAN',
      partyCode: 'BANK-01',
      to: 'BANK-01',
      inBlank: false,
    };

    const issued = negotiableTitle('issued', {
      holder: SHIPPER,
      endorsement: 'none',
    });
    const issuedSnapshot = structuredClone(issued);
    expect(allowedCommands(issued, shipper)).to.include('transfer-out');
    const pendingFromIssued = applyTitleCommand(issued, command, shipper);
    expect(pendingFromIssued.title).to.include({
      kind: 'negotiable',
      state: 'transfer-pending',
      carrier: CARRIER,
      holder: SHIPPER,
    });
    expect(issued).to.deep.equal(issuedSnapshot);

    const withHolder = negotiableTitle('with-holder', {holder: BANK});
    expect(allowedCommands(withHolder, bank)).to.include('transfer-out');
    const pendingFromHolder = applyTitleCommand(withHolder, command, bank);
    expect(pendingFromHolder.title).to.include({
      kind: 'negotiable',
      state: 'transfer-pending',
      carrier: CARRIER,
      holder: BANK,
    });
  });

  it('transfer-out is holder-only and negotiable-only', () => {
    const command = {
      name: 'transfer-out',
      platform: 'MERIDIAN',
      partyCode: 'BANK-01',
      to: 'BANK-01',
      inBlank: false,
    };
    const withHolder = negotiableTitle('with-holder', {holder: BANK});
    for (const nonHolder of [carrier, other]) {
      const refusal = refusalOf(() =>
        applyTitleCommand(withHolder, command, nonHolder),
      );
      expect(refusal.code, nonHolder.organisation).to.equal('not-holder');
      expect(allowedCommands(withHolder, nonHolder)).not.to.include(
        'transfer-out',
      );
    }

    for (const kind of [KINDS.STRAIGHT, KINDS.WAYBILL]) {
      const nonNeg = nonNegotiableTitle(kind);
      const refusal = refusalOf(() =>
        applyTitleCommand(nonNeg, command, carrier),
      );
      expect(refusal.code, kind).to.equal('wrong-kind');
      expect(allowedCommands(nonNeg, carrier)).not.to.include('transfer-out');
    }
  });

  it('locks a B/L in transfer-pending against all holder and carrier commands with wrong-state', () => {
    const pending = negotiableTitle('transfer-pending', {
      holder: BANK,
      endorsement: 'blank',
    });
    const holderCommands = [
      {name: 'endorse', to: BUYER, inBlank: false},
      {name: 'transfer', to: BUYER},
      {name: 'surrender'},
      {name: 'surrender-for-amendment'},
      {name: 'switch-to-paper', confirmBearer: true},
      {
        name: 'transfer-out',
        platform: 'MERIDIAN',
        partyCode: 'BUYER-01',
        to: 'BUYER-01',
        inBlank: false,
      },
      {name: 'accept-incoming'},
    ];
    for (const command of holderCommands) {
      const refusal = refusalOf(() =>
        applyTitleCommand(pending, command, bank),
      );
      expect(refusal.code, command.name).to.equal('wrong-state');
      expect(allowedCommands(pending, bank), command.name).not.to.include(
        command.name,
      );
    }

    const carrierCommands = [
      {name: 'void'},
      {name: 'release'},
      {name: 'amend'},
      {name: 'split', children: 2},
    ];
    for (const command of carrierCommands) {
      const refusal = refusalOf(() =>
        applyTitleCommand(pending, command, carrier),
      );
      expect(refusal.code, command.name).to.equal('wrong-state');
    }
    expect(allowedCommands(pending, carrier)).to.deep.equal([]);
  });

  it('refuses all local commands with wrong-state when a B/L is inactive in transferred-out', () => {
    const transferredOut = negotiableTitle('transferred-out', {
      holder: null,
      endorsement: 'named',
    });
    const commands = [
      {name: 'void'},
      {name: 'endorse', to: BUYER, inBlank: false},
      {name: 'transfer', to: BUYER},
      {name: 'surrender'},
      {name: 'release'},
      {name: 'surrender-for-amendment'},
      {name: 'amend'},
      {name: 'split', children: 2},
      {name: 'switch-to-paper', confirmBearer: true},
      {
        name: 'transfer-out',
        platform: 'MERIDIAN',
        partyCode: 'BUYER-01',
        to: 'BUYER-01',
        inBlank: false,
      },
      {name: 'accept-incoming'},
    ];
    for (const actor of [carrier, bank, other]) {
      expect(
        allowedCommands(transferredOut, actor),
        actor.organisation,
      ).to.deep.equal([]);
      for (const command of commands) {
        const refusal = refusalOf(() =>
          applyTitleCommand(transferredOut, command, actor),
        );
        expect(refusal.code, `${actor.organisation} ${command.name}`).to.equal(
          'wrong-state',
        );
      }
    }
  });

  it('accept-incoming moves an arrived negotiable B/L to with-holder for its holder only', () => {
    const arrived = negotiableTitle('arrived', {
      holder: BUYER,
      endorsement: 'named',
    });
    expect(allowedCommands(arrived, buyer)).to.include('accept-incoming');
    expect(allowedCommands(arrived, buyer)).not.to.include.members([
      'endorse',
      'surrender',
      'surrender-for-amendment',
      'switch-to-paper',
    ]);

    for (const nonHolder of [carrier, other]) {
      const refusal = refusalOf(() =>
        applyTitleCommand(arrived, {name: 'accept-incoming'}, nonHolder),
      );
      expect(refusal.code, nonHolder.organisation).to.equal('not-holder');
      expect(allowedCommands(arrived, nonHolder)).not.to.include(
        'accept-incoming',
      );
    }

    const accepted = applyTitleCommand(
      arrived,
      {name: 'accept-incoming'},
      buyer,
    );
    expect(accepted.title).to.include({
      kind: 'negotiable',
      state: 'with-holder',
      carrier: CARRIER,
      holder: BUYER,
    });
    expect(allowedCommands(accepted.title, buyer)).to.include.members([
      'endorse',
      'surrender',
    ]);

    for (const state of [
      'issued',
      'with-holder',
      'surrendered',
      'transfer-pending',
      'transferred-out',
    ]) {
      const title = negotiableTitle(state, {holder: BUYER});
      const refusal = refusalOf(() =>
        applyTitleCommand(title, {name: 'accept-incoming'}, buyer),
      );
      expect(refusal.code, state).to.equal('wrong-state');
    }

    for (const kind of [KINDS.STRAIGHT, KINDS.WAYBILL]) {
      const nonNeg = nonNegotiableTitle(kind);
      const refusal = refusalOf(() =>
        applyTitleCommand(nonNeg, {name: 'accept-incoming'}, carrier),
      );
      expect(refusal.code, kind).to.equal('wrong-kind');
    }
  });

  it('refuses transfer-out and accept-incoming when negotiable B/Ls are disabled', () => {
    const issued = negotiableTitle('issued', {holder: SHIPPER});
    const arrived = negotiableTitle('arrived', {holder: BUYER});

    const outRefusal = refusalOf(() =>
      applyTitleCommand(
        issued,
        {
          name: 'transfer-out',
          platform: 'MERIDIAN',
          partyCode: 'BANK-01',
          to: 'BANK-01',
          inBlank: false,
        },
        shipper,
        {modules: ['waybill']},
      ),
    );
    expect(outRefusal.code).to.equal('module-off');

    const inRefusal = refusalOf(() =>
      applyTitleCommand(arrived, {name: 'accept-incoming'}, buyer, {
        modules: ['waybill'],
      }),
    );
    expect(inRefusal.code).to.equal('module-off');
  });
});
