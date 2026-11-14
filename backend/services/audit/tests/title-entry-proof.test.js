import {strict as assert} from 'node:assert';

import {TreeService} from '../src/tree.service.js';
import {verifyProof} from '../verifier/lrfe-verify.mjs';
import {publicSource} from './register.js';
import {
  auditedChain,
  serviceHeader,
  titleAudit,
  titleEvent,
  titleChain,
} from './title-proof.js';

/**
 * CB-33: the audit service and the chain of title. Each chain entry reaches the audit trail as
 * its `records.title.<command>` event, lands on the B/L's trail (record:<id>) and is anchored with
 * the trail's checkpoints (no new leaf type); the pack's record service, and only it, gets the
 * trail-entry proof of an entry's event by its eventId (POST /audit/anchoring/entry-proof).
 */
describe('the chain of title on the audit trail (CB-33)', () => {
  describe('each entry on the trail', () => {
    let c;
    before(async () => {
      c = await auditedChain({anchored: false});
    });
    after(async () => {
      await c.audit.close();
    });

    it("puts every entry's event on the B/L's trail (record:<id>), the full signed entry in it", async () => {
      assert.equal(c.trailEntries.length, c.entries.length);
      for (const [i, t] of c.trailEntries.entries()) {
        assert.equal(t.type, `records.title.${c.entries[i].command}`);
        assert.equal(t.source, 'shipping-records');
        assert.ok(t.subjects.includes(`record:${c.recordId}`));
        assert.deepEqual(t.data.entry, c.entries[i]);
      }
      const listed = await c.audit.trail.list({
        subject: `record:${c.recordId}`,
      });
      const types = listed.entries.map(e => e.type);
      assert.deepEqual(
        types.filter(t => t.startsWith('records.title.')).sort(),
        [
          'records.title.endorse',
          'records.title.endorse',
          'records.title.issue',
        ],
      );
    });

    it('adds no tree leaf for a title event: entries are anchored through the trail checkpoints', async () => {
      for (const event of c.events) {
        assert.equal(TreeService.leafOf(event, c.audit.pack), null);
      }
    });
  });

  describe('the trail-entry proof by eventId (POST /audit/anchoring/entry-proof)', () => {
    let c;
    beforeEach(async () => {
      c = await auditedChain({anchored: false});
    });
    afterEach(async () => {
      await c.audit.close();
    });

    it('gives the record service the trail-entry proof of an event, waiting before the anchoring', async () => {
      const last = c.events.at(-1);
      const res = await c.audit.entryProof(
        last.id,
        serviceHeader('shipping-records'),
      );
      assert.equal(res.statusCode, 200, res.body);
      const proof = res.json();
      assert.equal(proof.format, 'lrfe-audit-proof/1');
      assert.equal(proof.status, 'waiting');
      assert.equal(proof.item.kind, 'trail-entry');
      assert.equal(proof.item.seq, c.trailEntries.at(-1).seq);
      assert.equal(proof.trail.entry.eventId, last.id);
      assert.deepEqual(proof.trail.entry.data.entry, c.entries.at(-1));
      assert.equal(proof.leaf, null);
      assert.equal(proof.anchor, null);
    });

    it('once anchored, gives the same proof as the trail-entry proof by seq, and it verifies offline', async () => {
      await c.audit.anchor();
      for (const [i, event] of c.events.entries()) {
        const res = await c.audit.entryProof(
          event.id,
          serviceHeader('shipping-records'),
        );
        assert.equal(res.statusCode, 200, res.body);
        const proof = res.json();
        assert.equal(proof.status, 'confirmed');
        assert.deepEqual(proof, await c.proofOfEntry(i + 1));
        assert.deepEqual(proof.trail.entry.data.entry, c.entries[i]);
        const offline = await verifyProof(structuredClone(proof), {
          fetchImpl: publicSource(c.audit.driver),
        });
        assert.equal(offline.valid, true, JSON.stringify(offline.checks));
      }
    });

    it('answers 404 for an event that is not on the trail', async () => {
      const known = await c.audit.entryProof(
        c.events[0].id,
        serviceHeader('shipping-records'),
      );
      assert.equal(known.statusCode, 200, known.body);
      for (const eventId of [
        '00000000-0000-4000-8000-000000000099',
        'toString',
        '__proto__',
        'constructor',
      ]) {
        const res = await c.audit.entryProof(
          eventId,
          serviceHeader('shipping-records'),
        );
        assert.equal(res.statusCode, 404, `${eventId}: ${res.body}`);
      }
    });

    it('refuses a request without an eventId, or with one that is not a string (400)', async () => {
      for (const payload of [
        {},
        {eventId: ''},
        {eventId: 42},
        {eventId: 'x'.repeat(500)},
        {eventId: c.events[0].id, more: 1},
      ]) {
        const res = await c.audit.app.inject({
          method: 'POST',
          url: '/audit/anchoring/entry-proof',
          headers: serviceHeader('shipping-records'),
          payload,
        });
        assert.equal(
          res.statusCode,
          400,
          `${JSON.stringify(payload)}: ${res.body}`,
        );
      }
    });

    it('refuses a call without a token (401) and a person, even an auditor (401: service token required)', async () => {
      const id = c.events[0].id;
      assert.equal((await c.audit.entryProof(id)).statusCode, 401);
      const auditor = c.audit.app.jwt.sign({
        typ: 'access',
        sub: 'u3',
        name: 'Auditor',
        perms: ['audit.view', 'audit.export'],
        roles: ['aud'],
      });
      const res = await c.audit.entryProof(id, {
        authorization: `Bearer ${auditor}`,
      });
      assert.equal(res.statusCode, 401);
    });

    it('refuses every other service (403): only the pack’s record service may ask', async () => {
      const id = c.events[0].id;
      for (const service of [
        'extracts',
        'edrms',
        'land-records',
        'bpm',
        'identity',
        'audit',
      ]) {
        const res = await c.audit.entryProof(id, serviceHeader(service));
        assert.equal(res.statusCode, 403, `${service}: ${res.body}`);
      }
    });
  });

  describe('on a land install', () => {
    it('allows the land record service, refuses shipping-records (403)', async () => {
      const chain = await titleChain({steps: 1, reference: 'CB33-LAND'});
      const audit = await titleAudit({packName: 'land'});
      try {
        const event = titleEvent(chain.entries[0], {
          recordNo: chain.recordNo,
          actor: chain.actors[0],
        });
        await audit.consume(event);
        const refused = await audit.entryProof(
          event.id,
          serviceHeader('shipping-records'),
        );
        assert.equal(refused.statusCode, 403, refused.body);
        const allowed = await audit.entryProof(
          event.id,
          serviceHeader('land-records'),
        );
        assert.equal(allowed.statusCode, 200, allowed.body);
        assert.equal(allowed.json().trail.entry.eventId, event.id);
      } finally {
        await audit.close();
      }
    });
  });
});
