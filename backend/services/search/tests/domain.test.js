import {expect} from 'chai';
import {loadDomainPack} from '@lrfe/common';
import {buildEntry} from '../src/entry.js';
import {SearchService} from '../src/search.service.js';

/** An intake reading with two names: a buyer first, then a mortgagor. */
const reading = {
  documentId: 'd1',
  status: 'ready',
  docType: 'deed_of_sale',
  updatedAt: '2026-11-08T10:00:00Z',
  fields: [
    {k: 'buyer1', label: 'Purchaser 1', v: 'Anna Shipanga', search: 'name'},
    {k: 'mortgagor', label: 'Mortgagor', v: 'Petrus Nghishidi', search: 'name'},
  ],
  pages: [],
};

describe('search with another domain pack (CB-3)', () => {
  it("the party is the land pack's party field first, otherwise the first name", async () => {
    const land = await loadDomainPack('land');
    const shipping = await loadDomainPack('shipping');
    expect(buildEntry({reading}, land).body.shown.party).to.equal(
      'Petrus Nghishidi',
    );
    expect(buildEntry({reading}, shipping).body.shown.party).to.equal(
      'Anna Shipanga',
    );
  });

  it('starts with the empty shipping pack', async () => {
    const domainPack = await loadDomainPack('shipping');
    const service = new SearchService({
      events: {},
      intake: {},
      edrms: {},
      domainPack,
    });
    expect(service.domainPack.name).to.equal('shipping');
  });
});
