// Unit tests for the endorsement to a named organisation on a B/L's page (CB-45): whether the
// page offers it, whom the holder may pick, what the confirmation says and what is sent
// (`npm run test:shipping`). The endorsement in blank and the transfer: CB-52.
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  endorseConfirmation,
  endorseRequest,
  endorseStatus,
  endorseeChoices,
  endorsementLabel,
  handOverWords,
  mayAcceptIncoming,
  mayEndorse,
  mayRetryTransfer,
  mayTransfer,
  mayTransferOut,
} from './bl-endorse.ts';
import type {PartyOrganisation} from './bl.model.ts';

/** The organisations registered and active on the platform, in the order the service lists them. */
const ORGANISATIONS: PartyOrganisation[] = [
  {id: 'org-shipper', code: 'SHP', name: 'Serra Verde Exports'},
  {id: 'org-buyer', code: 'BUY', name: 'Noordhaven Roasters'},
  {id: 'org-bank', code: 'BNK', name: 'Meridian Trade Bank'},
  {id: 'org-carrier', code: 'CAR', name: 'Atlantic Line'},
];

describe('whether the page offers the endorsement', () => {
  it('when the title read allows the endorse command', () => {
    assert.equal(mayEndorse(['endorse', 'surrender']), true);
  });

  it('not without it: another organisation, or no permission to endorse', () => {
    assert.equal(mayEndorse([]), false);
    assert.equal(mayEndorse(['issue', 'void']), false);
  });

  it('not for the transfer alone (a blank-endorsed B/L moved on by transfer)', () => {
    assert.equal(mayEndorse(['transfer']), false);
  });
});

describe('whether the page offers the transfer (CB-52)', () => {
  it('when the title read allows it: the holder of a blank-endorsed B/L', () => {
    assert.equal(mayTransfer(['endorse', 'transfer']), true);
  });

  it('not without it: a B/L endorsed by name, not endorsed yet, or another organisation', () => {
    assert.equal(mayTransfer(['endorse', 'surrender']), false);
    assert.equal(mayTransfer([]), false);
  });
});

describe('whom the holder may endorse to', () => {
  it('every registered organisation but its own and the current holder, by name', () => {
    const choices = endorseeChoices(ORGANISATIONS, {
      self: 'org-shipper',
      holder: 'org-shipper',
    });
    assert.deepEqual(
      choices.map(o => o.name),
      ['Atlantic Line', 'Meridian Trade Bank', 'Noordhaven Roasters'],
    );
  });

  it('leaves out the holder when it is named apart from the user', () => {
    const choices = endorseeChoices(ORGANISATIONS, {
      self: 'org-bank',
      holder: 'org-buyer',
    });
    assert.deepEqual(
      choices.map(o => o.id),
      ['org-carrier', 'org-shipper'],
    );
  });

  it('nobody to pick when the platform has no other organisation', () => {
    const only = [ORGANISATIONS[0]];
    assert.deepEqual(
      endorseeChoices(only, {self: 'org-shipper', holder: 'org-shipper'}),
      [],
    );
    assert.deepEqual(
      endorseeChoices([], {self: 'org-shipper', holder: null}),
      [],
    );
  });

  it('keeps the list it was given unchanged', () => {
    const before = ORGANISATIONS.map(o => o.id);
    endorseeChoices(ORGANISATIONS, {
      self: 'org-shipper',
      holder: 'org-shipper',
    });
    assert.deepEqual(
      ORGANISATIONS.map(o => o.id),
      before,
    );
  });

  it('a name from outside is shown as given, never read as markup', () => {
    const odd = {id: 'org-odd', code: 'ODD', name: '<b>Odd & Sons</b>'};
    const choices = endorseeChoices([odd], {self: 'org-shipper', holder: null});
    assert.equal(choices[0].name, '<b>Odd & Sons</b>');
  });
});

describe('what the confirmation says', () => {
  it('names the new holder and that the user can no longer act on the B/L', () => {
    assert.equal(
      endorseConfirmation('Meridian Trade Bank'),
      'Meridian Trade Bank becomes the holder; you can no longer act on this B/L.',
    );
  });

  it('with an organisation of no name, still says what happens', () => {
    assert.equal(
      endorseConfirmation(''),
      'The organisation becomes the holder; you can no longer act on this B/L.',
    );
  });
});

describe('what the confirmation says of an endorsement in blank (CB-52)', () => {
  it('names the organisation it goes to and explains what in blank means', () => {
    const said = endorseConfirmation('Meridian Trade Bank', 'blank');
    assert.match(said, /^Meridian Trade Bank becomes the holder; /);
    assert.match(said, /no longer names a holder by endorsement/);
    assert.match(said, /whoever it is then transferred to becomes its holder/);
  });

  it('says nothing of blank endorsement for a named one', () => {
    assert.doesNotMatch(
      endorseConfirmation('Meridian Trade Bank', 'named'),
      /blank/,
    );
  });
});

describe('what is sent', () => {
  it('a named endorsement to the organisation picked, by default', () => {
    assert.deepEqual(endorseRequest('org-bank'), {
      to: 'org-bank',
      inBlank: false,
    });
  });

  it('an endorsement in blank, still to the organisation picked (CB-52)', () => {
    assert.deepEqual(endorseRequest('org-bank', 'blank'), {
      to: 'org-bank',
      inBlank: true,
    });
  });
});

describe('what the page says of the endorsement (CB-52)', () => {
  it('in blank, by name or not yet', () => {
    assert.equal(endorsementLabel('blank'), 'Endorsed in blank');
    assert.equal(endorsementLabel('named'), 'Endorsed to a named organisation');
    assert.equal(endorsementLabel('none'), 'Not endorsed yet');
  });

  it('nothing before issue or for an endorsement it does not know', () => {
    assert.equal(endorsementLabel(null), '');
    assert.equal(endorsementLabel('odd'), '');
  });
});

describe('what the confirmation asks and the toast says (CB-52)', () => {
  it('an endorsement by name', () => {
    assert.deepEqual(handOverWords('endorse', 'named', 'BL-1', 'Bank'), {
      title: 'Endorse BL-1 to Bank?',
      confirmLabel: 'Endorse',
      done: 'B/L endorsed to Bank',
    });
  });

  it('an endorsement in blank', () => {
    assert.deepEqual(handOverWords('endorse', 'blank', 'BL-1', 'Bank'), {
      title: 'Endorse BL-1 in blank and hand it to Bank?',
      confirmLabel: 'Endorse in blank',
      done: 'B/L endorsed in blank to Bank',
    });
  });

  it('a transfer, whatever the mode', () => {
    assert.deepEqual(handOverWords('transfer', 'blank', 'BL-1', 'Bank'), {
      title: 'Transfer BL-1 to Bank?',
      confirmLabel: 'Transfer',
      done: 'B/L transferred to Bank',
    });
  });
});

describe('what the panel announces (review of CB-45: status notes are read out)', () => {
  const choices = ORGANISATIONS.slice(1);

  it('that the organisations are loading, while they are', () => {
    assert.equal(endorseStatus(null, ''), 'Loading the organisations…');
  });

  it('that there is nobody to pick, on a platform of one organisation', () => {
    assert.equal(
      endorseStatus([], ''),
      'No other organisation is registered on the platform yet.',
    );
  });

  it('nothing before an organisation is picked', () => {
    assert.equal(endorseStatus(choices, ''), '');
  });

  it('what happens, once one is picked', () => {
    assert.equal(
      endorseStatus(choices, 'Meridian Trade Bank'),
      'Meridian Trade Bank becomes the holder; you can no longer act on this B/L.',
    );
  });

  it('what an endorsement in blank means, once one is picked (CB-52)', () => {
    assert.match(
      endorseStatus(choices, 'Meridian Trade Bank', 'blank'),
      /no longer names a holder by endorsement/,
    );
  });

  it('offers cross-platform transfer, incoming acceptance, and holder-only retry (CB-55)', () => {
    assert.equal(mayTransferOut(['endorse', 'transfer-out']), true);
    assert.equal(mayTransferOut(['endorse']), false);
    assert.equal(mayAcceptIncoming(['accept-incoming']), true);
    assert.equal(mayAcceptIncoming(['endorse']), false);
    assert.equal(
      mayRetryTransfer('transfer-pending', ['holder'], ['bl.endorse']),
      true,
    );
    assert.equal(
      mayRetryTransfer('transfer-pending', ['carrier'], ['bl.issue']),
      false,
    );
    assert.equal(
      mayRetryTransfer('transfer-pending', ['holder'], ['bl.read']),
      false,
    );
    assert.equal(
      mayRetryTransfer('with-holder', ['holder'], ['bl.endorse']),
      false,
    );
  });
});
