/**
 * The demo users the readiness check looks for (CB-48): the land registry's on a land install, as
 * before, and the shipping pack's on a shipping install (it checked the land users there before).
 * Run with: node --test demo/demo-users.test.mjs
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {identity} from '../backend/domains/shipping/src/identity.js';
import {demoUsersFor} from './demo-users.mjs';

test('a land install: the 14 land demo users, unchanged', () => {
  const users = demoUsersFor(false);
  assert.equal(users.length, 14);
  assert.deepEqual(users[0], {
    email: 'e.shivute@deeds.gov.na',
    role: 'supervisor',
  });
  assert.deepEqual(users.at(-1), {
    email: 'l.tjiueza@deeds.gov.na',
    role: 'reviewer',
    status: 'Invited',
  });
});

test("a shipping install: the shipping pack's demo users, with their roles and organisations", () => {
  const users = demoUsersFor(true);
  assert.deepEqual(
    users.map(u => u.email),
    identity.demoUsers.map(u => u.email),
  );
  assert.equal(
    users.some(u => u.email.endsWith('deeds.gov.na')),
    false,
  );
  const carrier = identity.demoOrganisations[0];
  const clerk = users.find(
    u =>
      u.email ===
      identity.demoUsers.find(d => d.organisation === carrier.code).email,
  );
  assert.equal(clerk.role, `B/L documentation (carrier), ${carrier.name}`);
  const admin = users.find(u => u.role === 'administrator');
  assert.ok(admin, 'the administrator is checked too');
  assert.ok(users.every(u => u.status === undefined || u.status === 'Active'));
});
