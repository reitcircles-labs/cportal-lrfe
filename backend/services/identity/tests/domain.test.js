import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {domain, loadDomainPack} from '@lrfe/common';
import {expect} from 'chai';

import {catalogueOf} from '../src/catalogue.js';
import {invitationEmail} from '../src/mailer.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {seedIdentity} from '../src/seed.js';

const run = promisify(execFile);
const SERVICE_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('the catalogue from the domain pack (CB-3)', () => {
  it('has only the platform roles and permissions with the shipping pack', async () => {
    const catalogue = catalogueOf(await loadDomainPack('shipping'));
    expect(catalogue.roleIds).to.deep.equal(['adm']);
    expect(catalogue.groups).to.deep.equal([
      'General',
      'Capture',
      'Verification',
      'Audit',
      'Administration',
    ]);
    expect(catalogue.permIds.some(p => p.startsWith('record.'))).to.equal(
      false,
    );
    expect(catalogue.sodRules.map(r => r.id)).to.deep.equal(['sod1', 'sod4']);
    expect(catalogue.offices).to.deep.equal([]);
    expect(catalogue.demoUsers).to.deep.equal([]);

    const repo = createMemoryRepo();
    await seedIdentity(repo, {catalogue, demoPassword: 'x'.repeat(12)});
    expect((await repo.listRoles()).map(r => r.id)).to.deep.equal(['adm']);
    expect(await repo.listUsers()).to.deep.equal([]);
  });

  it("adds the land pack's groups, roles and rules in the platform's order", () => {
    const catalogue = catalogueOf(domain);
    expect(catalogue.groups).to.deep.equal([
      'General',
      'Capture',
      'Verification',
      'Land records',
      'Audit',
      'Administration',
    ]);
    expect(catalogue.roleIds).to.deep.equal([
      'sup',
      'scan',
      'rev',
      'rec',
      'aud',
      'adm',
    ]);
    expect(catalogue.sodRules.map(r => r.id)).to.deep.equal([
      'sod1',
      'sod2',
      'sod3',
      'sod4',
    ]);
    expect(catalogue.version).to.equal(4);
  });

  it("refuses a pack whose entries clash with the platform's or name unknown ones", () => {
    const packWith = identity => ({
      name: 'demo',
      identity,
      wording: {identity: {}},
    });
    const role = perms => ({
      id: 'agent',
      label: 'Agent',
      desc: '',
      home: '/',
      perms,
    });
    expect(() =>
      catalogueOf(packWith({roles: [{...role([]), id: 'adm'}]})),
    ).to.throw(/demo: identity: the role adm is the platform's/);
    expect(() =>
      catalogueOf(packWith({roles: [role(['cargo.view'])]})),
    ).to.throw(/unknown permission\(s\) cargo.view/);
    expect(() =>
      catalogueOf(
        packWith({
          permissions: [
            {id: 'audit.view', group: 'Audit', label: 'A', desc: ''},
          ],
        }),
      ),
    ).to.throw(/the permission audit.view is the platform's/);
    expect(() =>
      catalogueOf(
        packWith({
          separationOfDuties: [
            {
              id: 'sod1',
              a: 'audit.view',
              b: 'admin.roles',
              label: 'x',
              on: true,
            },
          ],
        }),
      ),
    ).to.throw(/the rule sod1 is the platform's/);
  });

  it('names the system in the invitation by the pack, "system" when it names none', () => {
    const invitation = {
      name: 'A',
      link: 'https://example.test/i',
      expiresAt: new Date('2026-11-08T10:00:00Z'),
      invitedBy: 'B',
      issuer: 'Port Authority',
    };
    expect(invitationEmail(invitation).text).to.include(
      'to the Port Authority land records system.',
    );
    expect(invitationEmail(invitation, {}).text).to.include(
      'to the Port Authority system.',
    );
  });

  it('builds the app and serves the catalogue with LRFE_DOMAIN=shipping', async () => {
    // the install's pack is loaded once per process: this runs in its own
    const script = `
      import {createEventBus} from '@lrfe/common';
      import {buildApp} from './src/app.js';
      import {IdentityService} from './src/identity.service.js';
      import {createMemoryRepo} from './src/repo/memory.js';
      import {seedIdentity} from './src/seed.js';
      import './src/repo/sequelize.js';
      const repo = createMemoryRepo();
      await seedIdentity(repo, {demoPassword: 'x'.repeat(12)});
      const service = new IdentityService({
        repo,
        events: createEventBus({driver: 'memory', source: 'identity'}),
      });
      const app = await buildApp({service, jwtSecret: 'x'.repeat(40), logger: false});
      await app.ready();
      const catalogue = await service.catalogue();
      console.log(JSON.stringify({
        groups: catalogue.groups,
        roles: catalogue.roles.map(r => r.id),
        users: (await repo.listUsers()).length,
      }));
      await app.close();
    `;
    const {stdout} = await run(
      process.execPath,
      ['--input-type=module', '-e', script],
      {cwd: SERVICE_DIR, env: {...process.env, LRFE_DOMAIN: 'shipping'}},
    );
    expect(JSON.parse(stdout.trim().split('\n').pop())).to.deep.equal({
      groups: ['General', 'Capture', 'Verification', 'Audit', 'Administration'],
      roles: ['adm'],
      users: 0,
    });
  });
});
