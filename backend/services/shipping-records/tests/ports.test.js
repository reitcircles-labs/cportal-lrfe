import {expect} from 'chai';
import {loadPortList} from '@lrfe/domain-shipping/ports';

import {exampleWithReference, makeHttp, stores, users} from './helpers.js';

/**
 * The port list of a B/L (CB-63): a new port of loading or discharge must be a UN/LOCODE sea port;
 * the list can be searched by code or name.
 */

/** The shipping pack's port list, as the service loads it by default. */
const PORTS = loadPortList();

/**
 * A DCSA example with its own reference and the given port of discharge.
 * @param {string} reference
 * @param {string} port
 * @return {object}
 */
function withDischarge(reference, port) {
  const document = exampleWithReference(reference);
  return {
    ...document,
    transports: {
      ...document.transports,
      portOfDischarge: {UNLocationCode: port},
    },
  };
}

for (const store of stores()) {
  describe(`port list, ${store.name}`, () => {
    let ctx;
    before(async () => {
      ctx = await makeHttp(store, {ports: PORTS});
    });
    after(async () => {
      await ctx?.close();
    });

    /**
     * Creates a draft B/L as a user: the raw answer.
     * @param {object} document
     * @return {!Promise<object>}
     */
    function create(document) {
      return ctx.app.inject({
        method: 'POST',
        url: '/records',
        headers: ctx.as(users.a1),
        payload: {format: 'dcsa-3.0', document},
      });
    }

    it('accepts a B/L whose ports are on the list', async () => {
      const res = await create(withDischarge('PORTS0001', 'NLRTM'));
      expect(res.statusCode, res.body).to.equal(201);
    });

    it('refuses a new port that is not on the list, naming it', async () => {
      const res = await create(withDischarge('PORTS0002', 'XXAAA'));
      expect(res.statusCode).to.equal(400);
      const {details, message} = res.json();
      expect(details.code).to.equal('unknown-port');
      expect(message).to.contain('XXAAA');
      expect(details.problems[0].path).to.equal(
        'transports.portOfDischarge.UNLocationCode',
      );
    });

    it('searches the list by name and by code', async () => {
      const byName = await ctx.app.inject({
        method: 'GET',
        url: '/records/ports?q=rotterdam',
        headers: ctx.as(users.a1),
      });
      expect(byName.statusCode).to.equal(200);
      expect(byName.json().items.map(port => port.code)).to.include('NLRTM');
      const byCode = await ctx.app.inject({
        method: 'GET',
        url: '/records/ports?code=nawvb',
        headers: ctx.as(users.a1),
      });
      expect(byCode.json().items).to.deep.equal([
        {code: 'NAWVB', name: 'Walvis Bay', country: 'NA'},
      ]);
    });

    it('lets only people who draft or issue B/Ls search it', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/records/ports?q=rot',
        headers: ctx.as(users.aReader),
      });
      expect(res.statusCode).to.equal(403);
    });
  });
}
