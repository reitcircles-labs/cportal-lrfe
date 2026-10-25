import {expect} from 'chai';
import {
  INDEX_ALIAS,
  analysis,
  buildSearchQuery,
  checkCountryPack,
  ensureIndex,
  loadCountryPack,
  queryParts,
} from '../src/index.js';
import {engineAvailable, startTestEngine} from '../src/testing.js';

const NA = loadCountryPack('NA');

describe('search index: the country pack', () => {
  it('Namibia has a pack; an unknown country or a broken pack fails at once', () => {
    expect(NA.country).to.equal('NA');
    expect(() => loadCountryPack('ZZ')).to.throw(/No country pack for "ZZ"/);
    expect(() => loadCountryPack('../na')).to.throw(/not two letters/);
    const broken = {
      country: 'XX',
      search: {
        ...NA.search,
        references: [{name: 'r', pattern: '\\d+', examples: ['T/']}],
      },
    };
    expect(() => checkCountryPack(broken)).to.throw(/"r" does not match T\//);
  });

  it('the analysers come from the pack: another pack, other spellings', () => {
    const filters = analysis(NA).analyzer.lrfe_variant.filter;
    expect(filters).to.deep.equal([
      'lowercase',
      'asciifolding',
      'lrfe_variant_1',
      'lrfe_variant_2',
    ]);
    const other = {
      country: 'XX',
      search: {...NA.search, wordStartMin: 2, nameVariants: []},
    };
    expect(analysis(other).analyzer.lrfe_variant.filter).to.deep.equal([
      'lowercase',
      'asciifolding',
    ]);
    expect(analysis(other).filter.lrfe_word_start.min_gram).to.equal(2);
  });
});

describe('search index: the query', () => {
  it('splits references, numbers and words', () => {
    expect(queryParts('T 2210/2008 Nghishidi', NA)).to.deep.equal({
      exact: ['t22102008'],
      words: ['nghishidi'],
    });
    expect(queryParts('Erf 1873, Klein Windhoek', NA)).to.deep.equal({
      exact: ['1873'],
      words: ['erf', 'klein', 'windhoek'],
    });
    expect(queryParts('EDR-NA-2026-000004 Hoäeb !Naruseb', NA)).to.deep.equal({
      exact: ['edrna2026000004'],
      words: ['hoaeb', 'naruseb'],
    });
  });

  it('keeps an apostrophe inside a name, as the index does', () => {
    expect(queryParts("O'Brien 'Shikongo'", NA).words).to.deep.equal([
      "o'brien",
      'shikongo',
    ]);
  });

  it('nothing to search: no query', () => {
    expect(buildSearchQuery('  ,; ', NA)).to.equal(null);
  });
});

describe('search index: creating it', () => {
  it('creates the first version with its alias, or keeps the one the alias points to', async () => {
    const calls = [];
    const answers = [{status: 404}, {status: 200, body: {acknowledged: true}}];
    const request = async (method, path, body) => {
      calls.push({method, path, body});
      return answers.shift();
    };
    expect(await ensureIndex(request, NA)).to.equal('lrfe-documents-v1');
    expect(calls[1]).to.deep.include({
      method: 'PUT',
      path: '/lrfe-documents-v1',
    });
    expect(calls[1].body.aliases).to.deep.equal({[INDEX_ALIAS]: {}});

    const kept = await ensureIndex(
      async () => ({
        status: 200,
        body: {'lrfe-documents-v2': {aliases: {'lrfe-documents': {}}}},
      }),
      NA,
    );
    expect(kept).to.equal('lrfe-documents-v2');

    // another service created it at the same moment: theirs is used
    const raced = [
      {status: 404},
      {status: 400, body: {error: {type: 'resource_already_exists_exception'}}},
      {
        status: 200,
        body: {'lrfe-documents-v1': {aliases: {'lrfe-documents': {}}}},
      },
    ];
    expect(await ensureIndex(async () => raced.shift(), NA)).to.equal(
      'lrfe-documents-v1',
    );
  });
});

// ---- the test set, against a real search engine -------------------------------------------------

/** The testers' sample documents for Erf 1873 (as edrms' search tests), plus Olympia and a bond. */
const DOCS = {
  grant: {
    status: 'filed',
    reference: 'G 88/1978',
    edrmsNo: 'EDR-NA-2026-000001',
    refs: ['G 88/1978'],
    numbers: ['1873'],
    names: ['the State', 'Municipality of Windhoek'],
    places: ['Erf 1873, Klein Windhoek'],
    title: 'Deed of Grant',
  },
  t1996: {
    status: 'filed',
    reference: 'T 1502/1996',
    edrmsNo: 'EDR-NA-2026-000002',
    refs: ['T 1502/1996', 'G 88/1978'],
    numbers: ['1873', '61042500187'],
    names: ['Municipality of Windhoek', 'Johannes Shikongo'],
    places: ['Erf 1873, Klein Windhoek'],
    title: 'Deed of Transfer',
  },
  sg: {
    status: 'filed',
    reference: 'A 412/2007',
    edrmsNo: 'EDR-NA-2026-000003',
    refs: ['A 412/2007'],
    numbers: ['1873'],
    places: ['Erf 1873, Klein Windhoek'],
    title: 'SG Diagram',
  },
  // filed; the officer corrected an ID number the AI misread: both values are searchable
  t2008: {
    status: 'filed',
    reference: 'T 2210/2008',
    edrmsNo: 'EDR-NA-2026-000004',
    refs: ['T 2210/2008', 'A 412/2007', 'T 1502/1996'],
    numbers: [
      '1873',
      '61042500187',
      '72110800845',
      '72110800345',
      '75060200418',
    ],
    names: ['Johannes Shikongo', 'Petrus Nghishidi', 'Maria Nghishidi'],
    places: ['Erf 1873, Klein Windhoek'],
    title: 'Deed of Transfer',
    shown: {fields: [{k: 'tee1Id', v: '72110800345'}]},
  },
  // still in intake: the AI's reading only, no EDRMS number yet
  t2019: {
    status: 'intake',
    intakeStatus: 'ready',
    reference: 'T 4521/2019',
    refs: ['T 4521/2019', 'T 2210/2008'],
    numbers: ['1873', '98030100562', '01112500379'],
    names: [
      'Estate of the late Petrus Nghishidi',
      'Ndapewa Nghishidi',
      'Tomas Nghishidi',
    ],
    places: ['Erf 1873, Klein Windhoek'],
    title: 'Deed of Transfer',
  },
  olympia: {
    status: 'filed',
    reference: 'T 3329/2011',
    edrmsNo: 'EDR-NA-2026-000006',
    refs: ['T 3329/2011'],
    numbers: ['3329', '80010100123', '88012345678'],
    names: ['Frieda Hoäeb', 'Hilma !Naruseb'],
    places: ['Erf 3329, Olympia'],
    title: 'Deed of Transfer',
  },
  // the name is only in its page text
  bond: {
    status: 'filed',
    reference: 'B 812/2008',
    edrmsNo: 'EDR-NA-2026-000007',
    refs: ['B 812/2008'],
    numbers: ['1873'],
    names: ['Bank Windhoek Limited'],
    places: ['Erf 1873, Klein Windhoek'],
    title: 'Mortgage Bond',
    text: 'Mortgage bond over Erf 1873 in favour of the bank, signed by Johannes Shikongo as surety.',
  },
};

(engineAvailable ? describe : describe.skip)(
  'search index: the test set on a real search engine (API-801)',
  function () {
    this.timeout(180_000);
    let engine;
    let request;
    /** The ids found for what was typed, best first, with the names of the clauses that matched. */
    const search = async q => {
      const res = await request(
        'POST',
        `/${INDEX_ALIAS}/_search`,
        buildSearchQuery(q, NA),
      );
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      return res.body.hits.hits.map(h => ({
        id: h._id,
        status: h._source.status,
        matched: h.matched_queries ?? [],
      }));
    };
    const ids = async q => (await search(q)).map(h => h.id);

    before(async () => {
      engine = await startTestEngine();
      request = engine.request;
      expect(await ensureIndex(request, NA)).to.equal('lrfe-documents-v1');
      const lines = Object.entries(DOCS).flatMap(([id, doc]) => [
        JSON.stringify({index: {_id: id}}),
        JSON.stringify({documentId: id, ...doc}),
      ]);
      const {body: bulk} = await request(
        'POST',
        `/${INDEX_ALIAS}/_bulk?refresh=true`,
        `${lines.join('\n')}\n`,
      );
      expect(
        bulk.errors,
        JSON.stringify(bulk.items?.find(i => i.index.error)),
      ).to.equal(false);
    });

    after(async () => {
      if (!engine) return;
      await engine.empty();
      engine.stop();
    });

    it('the index is created from the pack once: a second start keeps it', async () => {
      expect(await ensureIndex(request, NA)).to.equal('lrfe-documents-v1');
      const mapping = await request('GET', `/${INDEX_ALIAS}/_mapping`);
      expect(mapping.body['lrfe-documents-v1'].mappings.dynamic).to.equal(
        'strict',
      );
    });

    it('a reference matches however it is typed, its own document first', async () => {
      for (const q of ['T 2210/2008', 't2210 / 2008', 'T2210/2008']) {
        const found = await ids(q);
        expect(found[0], q).to.equal('t2008');
        // the documents that cite it come after
        expect(found, q).to.have.members(['t2008', 't2019']);
      }
      expect((await ids('G 88/1978'))[0]).to.equal('grant');
      expect(await ids('EDR-NA-2026-000004')).to.deep.equal(['t2008']);
    });

    it('numbers match exactly: an ID number, never every number starting the same', async () => {
      expect(await ids('61042500187')).to.have.members(['t1996', 't2008']);
      expect(await ids('880')).to.deep.equal([]);
      expect(await ids('Erf 9999')).to.deep.equal([]);
      const erf = await ids('Erf 1873');
      expect(erf).to.have.lengthOf(6).and.not.include('olympia');
    });

    it("both the AI's value and the officer's correction find the document", async () => {
      expect(await ids('72110800845')).to.deep.equal(['t2008']);
      expect(await ids('72110800345')).to.deep.equal(['t2008']);
    });

    it('names: spelling variants, accents and clicks, word starts', async () => {
      expect(await ids('Ngishidi')).to.have.members(['t2008', 't2019']);
      expect(await ids('Shikongu')).to.include.members(['t1996', 't2008']);
      expect(await ids('Hoäeb')).to.deep.equal(['olympia']);
      expect(await ids('hoaeb')).to.deep.equal(['olympia']);
      expect(await ids('Naruseb')).to.deep.equal(['olympia']);
      expect(await ids('Olym')).to.deep.equal(['olympia']);
      expect(await ids('Klein Wind'))
        .to.have.lengthOf(6)
        .and.not.include('olympia');
      // every word must match
      expect(await ids('Petrus Olympia')).to.deep.equal([]);
    });

    it('a match in the page text ranks below field matches and says so', async () => {
      const found = await search('Shikongo');
      expect(found.map(h => h.id)).to.have.members(['t1996', 't2008', 'bond']);
      expect(found.at(-1)).to.deep.include({id: 'bond', matched: ['text']});
      for (const h of found.slice(0, -1)) expect(h.matched).to.include('field');
    });

    it('a document in intake is found with its status, not hidden', async () => {
      const found = await search('Ndapewa');
      expect(found).to.have.lengthOf(1);
      expect(found[0]).to.deep.include({id: 't2019', status: 'intake'});
    });
  },
);
