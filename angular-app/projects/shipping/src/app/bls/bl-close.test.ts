// Unit tests for the switch to paper and the void on a B/L's page (CB-51): which of the two the
// page offers, what each confirmation asks and says (the bearer document of a blank-endorsed
// B/L), what is sent, and the note on a closed B/L (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  closeCommands,
  closeConfirmation,
  closeNote,
  closeRequest,
  needsBearerConfirmation,
} from './bl-close.ts';

describe('what the page offers', () => {
  it('the holder: "Switch to paper", next to its other commands', () => {
    const offered = closeCommands(['endorse', 'surrender', 'switch-to-paper']);
    assert.deepEqual(
      offered.map(command => [command.name, command.label]),
      [['switch-to-paper', 'Switch to paper']],
    );
  });

  it('the carrier while the shipper holds the B/L: "Void"', () => {
    const offered = closeCommands(['void']);
    assert.deepEqual(
      offered.map(command => [command.name, command.label]),
      [['void', 'Void']],
    );
  });

  it('nothing to whom the title read allows neither, nor on a closed B/L', () => {
    assert.deepEqual(closeCommands([]), []);
    assert.deepEqual(closeCommands(['issue', 'release', 'surrender']), []);
  });

  it('gives a new list each call', () => {
    const first = closeCommands(['void']);
    first[0].label = 'changed';
    assert.equal(closeCommands(['void'])[0].label, 'Void');
  });
});

describe('the confirmations', () => {
  it('the void names the B/L and says it is cancelled for good', () => {
    const asked = closeConfirmation('void', 'MAEU 123', 'none');
    assert.equal(asked.title, 'Void MAEU 123?');
    assert.match(asked.body, /cancelled for good/);
    assert.equal(asked.confirmLabel, 'Void the B/L');
  });

  it('the switch says the paper B/L takes over', () => {
    const asked = closeConfirmation('switch-to-paper', 'MAEU 123', 'named');
    assert.equal(asked.title, 'Switch MAEU 123 to paper?');
    assert.match(asked.body, /paper B\/L takes over/);
    assert.doesNotMatch(asked.body, /bearer/);
    assert.equal(asked.confirmLabel, 'Switch to paper');
  });

  it('the switch of a blank-endorsed B/L confirms the bearer document', () => {
    const asked = closeConfirmation('switch-to-paper', 'MAEU 123', 'blank');
    assert.match(asked.body, /bearer document/);
    assert.equal(asked.confirmLabel, 'Switch to a bearer paper B/L');
  });

  it('says "this B/L" when the label is not known', () => {
    assert.equal(closeConfirmation('void', '', null).title, 'Void this B/L?');
    assert.equal(
      closeConfirmation('switch-to-paper', '', null).title,
      'Switch this B/L to paper?',
    );
  });
});

describe('what is sent', () => {
  it('the bearer confirmation only for a blank-endorsed B/L switched to paper', () => {
    assert.deepEqual(closeRequest('switch-to-paper', 'blank'), {
      confirmBearer: true,
    });
    assert.equal(closeRequest('switch-to-paper', 'named'), undefined);
    assert.equal(closeRequest('switch-to-paper', null), undefined);
    assert.equal(closeRequest('void', 'blank'), undefined);
  });

  it('only "blank" needs the bearer confirmation', () => {
    assert.equal(needsBearerConfirmation('blank'), true);
    assert.equal(needsBearerConfirmation('named'), false);
    assert.equal(needsBearerConfirmation('none'), false);
    assert.equal(needsBearerConfirmation(null), false);
  });
});

describe('the note on a closed B/L', () => {
  it('switched to paper: the paper B/L takes over', () => {
    assert.match(closeNote('switched-to-paper'), /^Switched to paper:/);
  });

  it('void: the carrier cancelled it', () => {
    assert.match(closeNote('void'), /^Void: the carrier cancelled/);
  });

  it('nothing for the other states, nor before issue', () => {
    assert.equal(closeNote('with-holder'), '');
    assert.equal(closeNote('accomplished'), '');
    assert.equal(closeNote(null), '');
  });
});
