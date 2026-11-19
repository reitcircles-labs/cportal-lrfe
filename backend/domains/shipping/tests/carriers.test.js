import {expect} from 'chai';

import {
  carrierProblems,
  carriersOfRows,
  createCarrierList,
  loadCarrierList,
} from '../src/carriers/index.js';

/** The SMDG carrier code list (CB-68): built, searched, and checked on a B/L. */

const ROWS = [
  ['MSK', 'Maersk'],
  ['MSC', 'Mediterranean Shipping Company'],
  ['HLC', 'Hapag-Lloyd'],
  ['G2O', 'G2 Ocean AS'],
  ['TRL', 'Türkish Line'],
];

describe('SMDG carrier code list (CB-68)', () => {
  const carriers = createCarrierList(carriersOfRows(ROWS), '20261028');

  it('finds a carrier by its code in any case', () => {
    expect(carriers.has('msk')).to.equal(true);
    expect(carriers.get('MSC')).to.deep.equal({
      code: 'MSC',
      name: 'Mediterranean Shipping Company',
    });
    expect(carriers.has('BWML')).to.equal(false);
    expect(carriers.has('ECAR')).to.equal(false);
  });

  it('searches by code or name, accents ignored, and lists all when query is empty', () => {
    expect(carriers.search('maersk').map(c => c.code)).to.deep.equal(['MSK']);
    expect(carriers.search('turkish').map(c => c.code)).to.deep.equal(['TRL']);
    expect(carriers.search('g2').map(c => c.code)).to.deep.equal(['G2O']);
    expect(carriers.search('MSC').map(c => c.code)).to.deep.equal(['MSC']);
    expect(carriers.search('')).to.have.length(ROWS.length);
  });

  it('refuses a carrier code that is not on the SMDG list', () => {
    const problems = carrierProblems({carrierCode: 'BWML'}, carriers);
    expect(problems).to.have.length(1);
    expect(problems[0].path).to.equal('carrierCode');
    expect(problems[0].message).to.contain('BWML');
    expect(carrierProblems({carrierCode: 'MSC'}, carriers)).to.deep.equal([]);
  });

  it('checks nothing without a list', () => {
    expect(carrierProblems({carrierCode: 'BWML'}, null)).to.deep.equal([]);
  });

  it('ships the bundled SMDG Liner Code List with expected carriers', () => {
    const shipped = loadCarrierList();
    expect(shipped.size).to.be.greaterThan(350);
    for (const code of ['MSC', 'MSK', 'HLC', 'CMA', 'COS', 'ONE', 'G2O']) {
      expect(shipped.has(code), code).to.equal(true);
    }
  });
});
