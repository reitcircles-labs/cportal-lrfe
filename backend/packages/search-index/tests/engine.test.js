import {expect} from 'chai';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEngine} from '../src/index.js';

/** A port on this machine that nothing listens on. */
const closedPort = () =>
  new Promise(resolve => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });

describe('search index: the connection to the engine', () => {
  let loginDir;
  beforeEach(() => {
    loginDir = mkdtempSync(join(tmpdir(), 'lrfe-search-login-'));
  });
  afterEach(() => rmSync(loginDir, {recursive: true, force: true}));

  it('starts without the login; each request reads it until it is written (API-803)', async () => {
    const url = `https://127.0.0.1:${await closedPort()}`;
    // search-prepare has not written the login yet: the service starts anyway
    const request = createEngine({url, loginDir});
    let err = await request('GET', '/').catch(e => e);
    expect(err.message).to.match(/The search engine login has no user/);
    err = await request('GET', '/').catch(e => e);
    expect(err.message).to.match(/The search engine login has no user/);

    // once written, the next request reads it and goes to the engine (here: nothing listening)
    writeFileSync(join(loginDir, 'user'), 'edrms\n');
    writeFileSync(join(loginDir, 'password'), 'secret\n');
    writeFileSync(join(loginDir, 'ca.pem'), 'not checked before connecting');
    err = await request('GET', '/').catch(e => e);
    expect(err.code).to.equal('ECONNREFUSED');
  });

  it('without a login directory, the request says so', async () => {
    const request = createEngine({url: 'https://127.0.0.1:1', loginDir: ''});
    const err = await request('GET', '/').catch(e => e);
    expect(err.message).to.equal('OPENSEARCH_LOGIN_DIR is not set');
  });
});
