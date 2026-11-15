import {expect} from 'chai';
import {cmsDerOf} from './pdf-reader.js';

describe('the test PDF reader', () => {
  it('reads a signature container whose DER ends in a zero byte, padded with zeros', () => {
    // A SEQUENCE of 3 bytes ending in 0x00, as a CMS container can by chance.
    const der = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]);
    const padded = Buffer.concat([der, Buffer.alloc(16)]).toString('hex');

    expect(cmsDerOf(padded).equals(der)).to.equal(true);
  });

  it('reads a container without padding', () => {
    const der = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x07]);

    expect(cmsDerOf(der.toString('hex')).equals(der)).to.equal(true);
  });
});
