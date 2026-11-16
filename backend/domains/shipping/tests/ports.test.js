import {expect} from 'chai';

import {
  createPortList,
  loadPortList,
  portProblems,
  portsOfUnLocodeCsv,
} from '../src/ports/index.js';

/** The port list (CB-63): built from a UN/LOCODE CSV, searched, and checked on a B/L. */

const CSV = [
  'Change,Country,Location,Name,NameWoDiacritics,Subdivision,Status,Function,Date,IATA,Coordinates,Remarks',
  ',NL,RTM,Rotterdam,Rotterdam,ZH,AI,12345---,0307,,5155N 00430E,',
  ',BR,SSZ,Santos,Santos,SP,AI,1-3-----,0307,,,',
  ',DE,BER,Berlin,Berlin,BE,AI,-2345---,0307,,,"inland, no port"',
  'X,NL,OLD,Old port,Old port,,,1-------,0307,,,',
  ',TR,IST,İstanbul,Istanbul,34,AI,1234----,0307,,,',
].join('\n');

/**
 * A B/L document with these ports.
 * @param {string} loading
 * @param {string} discharge
 * @return {object}
 */
function documentWith(loading, discharge) {
  return {
    transports: {
      portOfLoading: {UNLocationCode: loading},
      portOfDischarge: {UNLocationCode: discharge},
    },
  };
}

describe('port list', () => {
  const ports = createPortList(portsOfUnLocodeCsv(CSV));

  it('keeps the sea ports of a UN/LOCODE list, not inland places or removed entries', () => {
    expect(portsOfUnLocodeCsv(CSV).map(port => port.code)).to.deep.equal([
      'BRSSZ',
      'NLRTM',
      'TRIST',
    ]);
  });

  it('finds a port by its code in any case', () => {
    expect(ports.has('nlrtm')).to.equal(true);
    expect(ports.get('BRSSZ')).to.deep.equal({
      code: 'BRSSZ',
      name: 'Santos',
      country: 'BR',
    });
    expect(ports.has('DEBER')).to.equal(false);
  });

  it('searches by code or name, accents ignored', () => {
    expect(ports.search('rott').map(port => port.code)).to.deep.equal([
      'NLRTM',
    ]);
    expect(ports.search('istanbul').map(port => port.code)).to.deep.equal([
      'TRIST',
    ]);
    expect(ports.search('BR').map(port => port.code)).to.deep.equal(['BRSSZ']);
    expect(ports.search('')).to.deep.equal([]);
  });

  it('refuses a new port that is not on the list', () => {
    const problems = portProblems(documentWith('NLRTM', 'XXAAA'), null, ports);
    expect(problems).to.have.length(1);
    expect(problems[0].path).to.equal(
      'transports.portOfDischarge.UNLocationCode',
    );
    expect(problems[0].message).to.contain('XXAAA');
  });

  it('does not check again a port the previous version already named', () => {
    const previous = documentWith('NLRTM', 'XXAAA');
    expect(
      portProblems(documentWith('BRSSZ', 'XXAAA'), previous, ports),
    ).to.deep.equal([]);
    expect(
      portProblems(documentWith('NLRTM', 'YYBBB'), previous, ports),
    ).to.have.length(1);
  });

  it('checks nothing without a list', () => {
    expect(
      portProblems(documentWith('XXAAA', 'YYBBB'), null, null),
    ).to.deep.equal([]);
  });

  it('ships a list with the ports the demo uses', () => {
    const shipped = loadPortList();
    expect(shipped.size).to.be.greaterThan(10000);
    for (const code of ['NLRTM', 'BRSSZ', 'DEBRV', 'DKAAR', 'NAWVB']) {
      expect(shipped.has(code), code).to.equal(true);
    }
  });
});
