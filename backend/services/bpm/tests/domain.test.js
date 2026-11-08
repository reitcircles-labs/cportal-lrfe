import {expect} from 'chai';
import {loadDomainPack, recordServiceOf} from '@lrfe/common';
import {buildApp} from '../src/app.js';
import {createConnectors} from '../src/connectors/index.js';
import {loadDefinitions} from '../src/definitions/index.js';
import {makeEngine} from './helpers.js';

const SECRET = 'shared-jwt-secret-shared-jwt-secret';

/** Deploys the definitions of `pack` on a fresh engine; returns the engine and their keys. */
async function deployed(pack) {
  const {engine} = makeEngine(
    createConnectors({
      urls: {edrms: 'http://edrms', records: 'http://records'},
      serviceToken: () => 'token',
    }),
  );
  for (const definition of await loadDefinitions(pack)) {
    await engine.deployDefinition(definition);
  }
  const keys = (await engine.repo.listDefinitions()).map(d => d.key);
  return {engine, keys};
}

describe('bpm and the domain pack (CB-3)', () => {
  it('with the land pack: its review, and the audit workflows acknowledged by its roles', async () => {
    const land = await loadDomainPack('land');
    const definitions = await loadDefinitions(land);
    expect(definitions.map(d => d.key)).to.deep.equal([
      'audit-finding',
      'audit-rereview',
      'document-amendment',
      'land-record-review',
    ]);
    const finding = definitions.find(d => d.key === 'audit-finding');
    expect(finding.nodes.notify.next).to.deep.equal(['officer', 'registrar']);
    expect(finding.nodes.officer.assignee).to.deep.equal({role: 'rec'});
    expect(finding.nodes.registrar.outputVar).to.equal('registrarAck');
    expect(finding.description).to.equal(
      land.workflows.descriptions['audit-finding'],
    );
    // a copy of the pack's definition, not the frozen pack itself
    const review = definitions.find(d => d.key === 'land-record-review');
    expect(Object.isFrozen(review)).to.equal(false);
    expect(review).to.deep.equal(land.workflows.definitions[0]);
  });

  it('with the empty shipping pack: only the platform workflows nobody has to acknowledge, and the app starts', async () => {
    const shipping = await loadDomainPack('shipping');
    const {engine, keys} = await deployed(shipping);
    expect(keys).to.deep.equal(['document-amendment']);
    const app = await buildApp({engine, jwtSecret: SECRET});
    await app.ready();
    await app.close();
  });

  it('commits and rejects through the record contract, with the same paths and bodies (CB-4)', async () => {
    const land = await loadDomainPack('land');
    const sent = [];
    const connectors = createConnectors({
      urls: {edrms: 'http://edrms', records: recordServiceOf(land).url},
      serviceToken: () => 'token',
      fetchImpl: async (url, init) => {
        sent.push([init.method, url, JSON.parse(init.body)]);
        return {ok: true, text: async () => '{"current":{"seal":"s1"}}'};
      },
    });
    const variables = {
      record: {id: 'rec-1', versionNumber: 2},
      approval: {by: {id: 'u2', name: 'Ann'}, comment: 'ok'},
    };
    expect(
      await connectors['records.commitVersion']({variables}),
    ).to.deep.equal({seal: 's1'});
    expect(
      await connectors['records.rejectVersion']({variables}),
    ).to.deep.equal({});
    const body = {by: {id: 'u2', name: 'Ann'}, comment: 'ok'};
    expect(sent).to.deep.equal([
      ['POST', 'http://localhost:3505/records/rec-1/versions/2/commit', body],
      ['POST', 'http://localhost:3505/records/rec-1/versions/2/reject', body],
    ]);
  });

  it('with the shipping pack: no record service, so no records connectors (CB-4)', async () => {
    const shipping = await loadDomainPack('shipping');
    const connectors = createConnectors({
      urls: {
        edrms: 'http://edrms',
        records: recordServiceOf(shipping)?.url ?? null,
      },
      serviceToken: () => 'token',
    });
    expect(Object.keys(connectors)).to.not.include('records.commitVersion');
    expect(Object.keys(connectors)).to.not.include('records.rejectVersion');
  });

  it('with one acknowledger: the task alone, without a gateway', async () => {
    const pack = {
      name: 'demo',
      workflows: {auditAcknowledgers: [{task: 'clerk', role: 'clk'}]},
    };
    const {engine, keys} = await deployed(pack);
    expect(keys).to.deep.equal([
      'audit-finding',
      'audit-rereview',
      'document-amendment',
    ]);
    const {definition} = await engine.repo.getDefinition('audit-rereview');
    expect(Object.keys(definition.nodes)).to.deep.equal([
      'start',
      'clerk',
      'done',
    ]);
    expect(definition.nodes.start.next).to.equal('clerk');
    expect(definition.nodes.clerk.next).to.equal('done');
  });

  it('refuses a product workflow with the key of a platform one', async () => {
    const pack = {
      name: 'demo',
      workflows: {definitions: [{key: 'document-amendment', nodes: {}}]},
    };
    let error;
    try {
      await loadDefinitions(pack);
    } catch (err) {
      error = err;
    }
    expect(error?.message).to.equal(
      'Domain pack demo: the workflow "document-amendment" has the key of a platform workflow',
    );
  });
});
