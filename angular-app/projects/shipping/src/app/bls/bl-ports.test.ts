// Unit tests for the port list in the B/L forms (CB-63): what a port reads as, when the list is
// searched, that only the latest text typed counts, and the name of the port picked
// (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {type Port, PortOptions, portLabel} from './bl-ports.ts';

const ROTTERDAM: Port = {code: 'NLRTM', name: 'Rotterdam', country: 'NL'};
const SANTOS: Port = {code: 'BRSSZ', name: 'Santos', country: 'BR'};

describe('the port list in the B/L forms', () => {
  it('names a port with its country', () => {
    assert.equal(portLabel(ROTTERDAM), 'Rotterdam, Netherlands');
    assert.equal(
      portLabel({code: 'QZAAA', name: 'Nowhere', country: 'QZ'}),
      'Nowhere, QZ',
    );
  });

  it('searches only from two characters on', async () => {
    const asked: string[] = [];
    const ports = new PortOptions(async query => {
      asked.push(query);
      return [ROTTERDAM];
    });
    await ports.search('portOfDischarge', 'r');
    assert.deepEqual(asked, []);
    assert.deepEqual(ports.options('portOfDischarge'), []);
    await ports.search('portOfDischarge', ' ro ');
    assert.deepEqual(asked, ['ro']);
    assert.deepEqual(ports.options('portOfDischarge'), [ROTTERDAM]);
  });

  it('keeps only the answer to the latest text of a field', async () => {
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>(resolve => {
      releaseSlow = resolve;
    });
    const ports = new PortOptions(async query => {
      if (query === 'ro') {
        await slow;
        return [ROTTERDAM];
      }
      return [SANTOS];
    });
    const first = ports.search('portOfLoading', 'ro');
    await ports.search('portOfLoading', 'san');
    releaseSlow();
    await first;
    assert.deepEqual(ports.options('portOfLoading'), [SANTOS]);
  });

  it('names the port picked once the list offered it, in any case', async () => {
    const ports = new PortOptions(async () => [ROTTERDAM]);
    assert.equal(ports.nameOf('NLRTM'), '');
    await ports.search('portOfDischarge', 'rotter');
    assert.equal(ports.nameOf('nlrtm'), 'Rotterdam, Netherlands');
  });

  it('offers nothing when the search fails', async () => {
    const ports = new PortOptions(async () => {
      throw new Error('down');
    });
    await ports.search('portOfDischarge', 'rotter');
    assert.deepEqual(ports.options('portOfDischarge'), []);
  });
});
