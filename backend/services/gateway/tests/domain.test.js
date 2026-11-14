import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {domain, loadDomainPack, recordServiceOf} from '@lrfe/common';
import {expect} from 'chai';

import {ROUTES, buildApp, routesOf} from '../src/app.js';

const run = promisify(execFile);
const SERVICE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The upstreams of every service but the record service, all at one address. */
function upstreamsWithoutRecords(url) {
  return Object.fromEntries(
    ['identity', 'edrms', 'bpm', 'intake', 'audit', 'extracts'].map(name => [
      name,
      url,
    ]),
  );
}

describe('the gateway routes from the domain pack (CB-4)', () => {
  it('routes /api/records to the land pack record service', () => {
    expect(recordServiceOf(domain).name).to.equal('land-records');
    expect(ROUTES.find(r => r.prefix === '/api/records')).to.deep.equal({
      prefix: '/api/records',
      service: 'land-records',
      rewritePrefix: '/records',
    });
  });

  it('starts without a record service and has no /api/records route with a pack without one', async () => {
    const shipping = await loadDomainPack('shipping');
    const routes = routesOf(recordServiceOf({...shipping, recordKind: null}));
    expect(routes.map(r => r.prefix)).not.to.include('/api/records');
    const app = await buildApp({
      upstreams: upstreamsWithoutRecords('http://127.0.0.1:9'),
      routes,
    });
    await app.ready();
    const res = await app.inject({url: '/api/records'});
    expect(res.statusCode).to.equal(404);
    await app.close();
  });

  it('routes /api/records to shipping-records with the shipping pack (CB-28)', async () => {
    const routes = routesOf(recordServiceOf(await loadDomainPack('shipping')));
    expect(routes.find(r => r.prefix === '/api/records')).to.deep.equal({
      prefix: '/api/records',
      service: 'shipping-records',
      rewritePrefix: '/records',
    });
  });

  it('builds its routing table with LRFE_DOMAIN=shipping', async () => {
    // the install's pack is loaded once per process: this runs in its own
    const script = `
      import {ROUTES} from './src/app.js';
      console.log(JSON.stringify(ROUTES.map(r => r.service)));
    `;
    const {stdout} = await run(
      process.execPath,
      ['--input-type=module', '-e', script],
      {cwd: SERVICE_DIR, env: {...process.env, LRFE_DOMAIN: 'shipping'}},
    );
    const services = JSON.parse(stdout.trim().split('\n').pop());
    expect(services).not.to.include('land-records');
    expect(services).to.include('shipping-records');
    expect(services).to.include('audit');
  });
});
