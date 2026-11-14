import {
  canonicalJson,
  createEventBus,
  createLocalSigner,
  createTransitSigner,
  sha256Hex,
  signJws,
  verifyJws,
} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';
import {UniqueConstraintError} from 'sequelize';

import {createFakeOpenBao} from '../../../packages/common/tests/fake-openbao.js';
import {verifyTitleChain} from '../src/chain.js';
import {ShippingRecordsService} from '../src/records.service.js';
import {TitleService} from '../src/title.service.js';
import {
  ACTIVE_ORGANISATIONS,
  exampleWithReference,
  makeClock,
  makeHttp,
  stores,
} from './helpers.js';

/** The organisations of the tests: the carrier owns the B/Ls. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';

/** The JWS type of a chain-of-title entry. */
const TYP = 'lrfe-title-entry';

/** The fields of a chain entry, as the repo answers it: nothing else. */
const ENTRY_FIELDS = [
  'actor',
  'at',
  'command',
  'documentHash',
  'endorsement',
  'entryHash',
  'from',
  'kid',
  'previousHash',
  'recordId',
  'seq',
  'signature',
  'to',
];

/** The carrier's staff: one drafts and submits, the other approves (four-eyes). */
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

/**
 * A person of an organisation, running title commands.
 * @param {string} org
 * @return {{id: string, name: string, org: string}}
 */
function staffOf(org) {
  return {id: `u-${org}`, name: `Staff of ${org}`, org};
}

/**
 * The record and title services on a store, sharing its transactions, the title service signing
 * with `signer`.
 * @param {{open: function(): Promise<object>}} store
 * @param {?object} signer the platform signer (null: none, as in production without one)
 * @return {Promise<object>}
 */
async function makeServices(store, signer) {
  const {repo, atomic, close, sequelize} = await store.open();
  const bus = createEventBus({driver: 'memory', source: 'shipping-records'});
  let events = bus;
  if (atomic) {
    events = {...bus, atomic};
  }
  const clock = makeClock();
  const records = new ShippingRecordsService({
    repo,
    events,
    formats: formatsFromSettings({}),
    clock,
  });
  const titles = new TitleService({
    repo,
    events,
    modules: modulesFromSettings({}),
    organisations: ACTIVE_ORGANISATIONS,
    clock,
    signer,
  });
  return {
    repo,
    events,
    clock,
    sequelize,
    records,
    titles,
    signer,
    close: async () => {
      await close?.();
    },
  };
}

/**
 * A negotiable B/L of the carrier, its first version committed, the shipper linked: its id.
 * @param {object} ctx makeServices' answer
 * @param {string} reference
 * @return {Promise<string>}
 */
async function committedBl(ctx, reference) {
  const body = {
    format: 'dcsa-3.0',
    document: exampleWithReference(reference),
    partyOrganisations: {shipper: SHIPPER},
  };
  const record = await ctx.records.createRecord(body, drafter, CARRIER);
  await ctx.records.submit(record.id, 1, drafter, CARRIER);
  await ctx.records.commit(record.id, 1, {by: approver}, 'bpm');
  return record.id;
}

/**
 * Runs something expected to fail: the error.
 * @param {!Promise<*>} pending
 * @return {Promise<!Error>}
 */
async function refused(pending) {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('It was not refused');
}

/**
 * An entry without its hash and signature: what the hash and the signature are over.
 * @param {object} entry
 * @return {object}
 */
function contentOf(entry) {
  const content = {...entry};
  delete content.entryHash;
  delete content.signature;
  return content;
}

/**
 * The commands of the blueprint journey of a negotiable B/L: who runs them and with what.
 * @return {!Array<!Array<*>>}
 */
function journey() {
  return [
    [CARRIER, {name: 'issue'}],
    [SHIPPER, {name: 'endorse', to: BANK, inBlank: true}],
    [BANK, {name: 'transfer', to: BUYER}],
    [BUYER, {name: 'endorse', to: BANK, inBlank: false}],
    [BANK, {name: 'surrender'}],
    [CARRIER, {name: 'release'}],
  ];
}

/**
 * Runs commands on a B/L: the views each answered.
 * @param {object} ctx
 * @param {string} id
 * @param {!Array<!Array<*>>} steps [organisation, command]
 * @return {Promise<!Array<object>>}
 */
async function run(ctx, id, steps) {
  const views = [];
  for (const [org, command] of steps) {
    views.push(await ctx.titles.apply(id, command, staffOf(org)));
  }
  return views;
}

/**
 * Signed entries built by hand, as a split child's chain will be (CB-35): seq from 1, the first
 * linked to `previousHash`, each hashed and signed as the design says.
 * @param {!Array<object>} contents the entries' data (command, actor, from, to, ...)
 * @param {object} signer
 * @param {?string} previousHash the hash the first entry links to
 * @return {Promise<!Array<object>>}
 */
async function handMadeChain(contents, signer, previousHash) {
  const kid = (await signer.jwks()).keys[0].kid;
  const entries = [];
  let previous = previousHash;
  for (const [index, data] of contents.entries()) {
    const content = {...data, seq: index + 1, previousHash: previous, kid};
    const entryHash = sha256Hex(canonicalJson(content));
    const signature = await signJws(content, signer, {typ: TYP});
    entries.push({...content, entryHash, signature});
    previous = entryHash;
  }
  return entries;
}

/**
 * Re-hashes and re-signs one entry after a change, as a forger with a key would.
 * @param {object} entry
 * @param {object} signer
 * @return {Promise<object>}
 */
async function resealed(entry, signer) {
  const content = contentOf(entry);
  return {
    ...content,
    entryHash: sha256Hex(canonicalJson(content)),
    signature: await signJws(content, signer, {typ: TYP}),
  };
}

for (const store of stores()) {
  describe(`the chain of title (CB-32), ${store.name}`, () => {
    let ctx;
    beforeEach(async () => {
      ctx = await makeServices(store, await createLocalSigner());
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('one entry per applied command', () => {
      it('adds the first entry on issue: seq 1, no previous hash, who, from, to, the document hash and time', async () => {
        const id = await committedBl(ctx, 'CB32-FIRST');
        const view = await ctx.titles.apply(
          id,
          {name: 'issue'},
          staffOf(CARRIER),
        );
        const entries = await ctx.repo.listTitleEntries(id);
        expect(entries).to.have.length(1);
        const [entry] = entries;
        expect(Object.keys(entry).sort()).to.deep.equal(ENTRY_FIELDS);
        expect(entry).to.include({
          recordId: id,
          seq: 1,
          command: 'issue',
          from: null,
          to: SHIPPER,
          endorsement: view.title.endorsement,
          documentHash: view.title.documentHash,
          previousHash: null,
        });
        expect(entry.actor).to.deep.equal(staffOf(CARRIER));
        expect(entry.at).to.be.a('string');
        const stored = await ctx.repo.getTitle(id);
        expect(entry.at).to.equal(new Date(stored.updatedAt).toISOString());
      });

      it('hashes each entry: SHA-256 of the canonical JSON of the entry without hash and signature', async () => {
        const id = await committedBl(ctx, 'CB32-HASH');
        await run(ctx, id, journey().slice(0, 3));
        for (const entry of await ctx.repo.listTitleEntries(id)) {
          expect(entry.entryHash, entry.command).to.match(/^[0-9a-f]{64}$/);
          expect(entry.entryHash, entry.command).to.equal(
            sha256Hex(canonicalJson(contentOf(entry))),
          );
        }
      });

      it("signs each entry with the platform key: a JWS over the hashed content, the entry's kid in its header", async () => {
        const id = await committedBl(ctx, 'CB32-SIGNED');
        await run(ctx, id, journey().slice(0, 3));
        const jwks = await ctx.signer.jwks();
        for (const entry of await ctx.repo.listTitleEntries(id)) {
          expect(entry.kid, entry.command).to.equal(jwks.keys[0].kid);
          const header = JSON.parse(
            Buffer.from(entry.signature.split('.')[0], 'base64url').toString(),
          );
          expect(header, entry.command).to.deep.equal({
            alg: 'ES256',
            kid: entry.kid,
            typ: TYP,
          });
          expect(await verifyJws(entry.signature, jwks)).to.deep.equal(
            contentOf(entry),
          );
        }
      });

      it('adds one entry per command, each linked to the one before, from holder to holder', async () => {
        const id = await committedBl(ctx, 'CB32-JOURNEY');
        const views = await run(ctx, id, journey());
        const entries = await ctx.repo.listTitleEntries(id);
        expect(entries.map(e => e.seq)).to.deep.equal([1, 2, 3, 4, 5, 6]);
        expect(entries.map(e => e.command)).to.deep.equal([
          'issue',
          'endorse',
          'transfer',
          'endorse',
          'surrender',
          'release',
        ]);
        expect(entries.map(e => e.from)).to.deep.equal([
          null,
          SHIPPER,
          BANK,
          BUYER,
          BANK,
          CARRIER,
        ]);
        expect(entries.map(e => e.to)).to.deep.equal(
          views.map(v => v.title.holder),
        );
        expect(entries.map(e => e.endorsement)).to.deep.equal(
          views.map(v => v.title.endorsement),
        );
        expect(entries.map(e => e.actor.org)).to.deep.equal(
          journey().map(([org]) => org),
        );
        expect(entries[0].previousHash).to.equal(null);
        for (let i = 1; i < entries.length; i++) {
          expect(entries[i].previousHash, `entry ${i + 1}`).to.equal(
            entries[i - 1].entryHash,
          );
          expect(entries[i].documentHash).to.equal(entries[0].documentHash);
        }
        const title = await ctx.repo.getTitle(id);
        expect(entries).to.have.length(title.revision);
      });

      it('keeps each B/L its own chain, each starting at seq 1 with no previous hash', async () => {
        const first = await committedBl(ctx, 'CB32-APART-1');
        const second = await committedBl(ctx, 'CB32-APART-2');
        await run(ctx, first, journey().slice(0, 2));
        await run(ctx, second, journey().slice(0, 1));
        const firstEntries = await ctx.repo.listTitleEntries(first);
        const secondEntries = await ctx.repo.listTitleEntries(second);
        expect(firstEntries.map(e => e.recordId)).to.deep.equal([first, first]);
        expect(secondEntries).to.have.length(1);
        expect(secondEntries[0]).to.include({
          recordId: second,
          seq: 1,
          previousHash: null,
        });
        expect(
          await ctx.repo.listTitleEntries(
            '00000000-0000-4000-8000-000000000000',
          ),
        ).to.deep.equal([]);
      });
    });

    describe('nothing appended when nothing changes', () => {
      it('appends nothing for a refused command', async () => {
        const id = await committedBl(ctx, 'CB32-REFUSED');
        await run(ctx, id, journey().slice(0, 2));
        const before = await ctx.repo.listTitleEntries(id);
        const cases = [
          [CARRIER, {name: 'endorse', to: BUYER, inBlank: false}],
          [BANK, {name: 'release'}],
          [BANK, {name: 'issue'}],
          [BANK, {name: 'endorse', inBlank: false}],
          [BANK, {name: 'toString'}],
          [SHIPPER, {name: 'surrender'}],
        ];
        for (const [org, command] of cases) {
          await refused(ctx.titles.apply(id, command, staffOf(org)));
        }
        expect(await ctx.repo.listTitleEntries(id)).to.deep.equal(before);
      });

      it('appends nothing for a B/L that cannot be issued', async () => {
        const body = {
          format: 'dcsa-3.0',
          document: exampleWithReference('CB32-DRAFT'),
          partyOrganisations: {shipper: SHIPPER},
        };
        const record = await ctx.records.createRecord(body, drafter, CARRIER);
        await refused(
          ctx.titles.apply(record.id, {name: 'issue'}, staffOf(CARRIER)),
        );
        expect(await ctx.repo.listTitleEntries(record.id)).to.deep.equal([]);
      });

      it("appends exactly one entry when two endorsements race: the winner's", async () => {
        for (let round = 1; round <= 5; round++) {
          const id = await committedBl(ctx, `CB32-RACE-${round}`);
          await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          const results = await Promise.allSettled(
            [BANK, BUYER].map(to =>
              ctx.titles.apply(
                id,
                {name: 'endorse', to, inBlank: false},
                staffOf(SHIPPER),
              ),
            ),
          );
          const won = results.filter(r => r.status === 'fulfilled');
          expect(won, `round ${round}`).to.have.length(1);
          const entries = await ctx.repo.listTitleEntries(id);
          expect(
            entries.map(e => e.seq),
            `round ${round}`,
          ).to.deep.equal([1, 2]);
          expect(entries[1].to).to.equal(won[0].value.title.holder);
          expect(entries[1].previousHash).to.equal(entries[0].entryHash);
        }
      });

      it('refuses title commands without a platform signer (503), storing no title and no entry', async () => {
        const unsigned = await makeServices(store, null);
        try {
          const id = await committedBl(unsigned, 'CB32-NO-SIGNER');
          const error = await refused(
            unsigned.titles.apply(id, {name: 'issue'}, staffOf(CARRIER)),
          );
          expect(error.statusCode).to.equal(503);
          expect(error.message).to.not.match(/bao|vault|transit|signer/i);
          expect(await unsigned.repo.getTitle(id)).to.equal(null);
          expect(await unsigned.repo.listTitleEntries(id)).to.deep.equal([]);
        } finally {
          await unsigned.close();
        }
      });

      it('changes neither the title nor the chain when the signing fails', async () => {
        const id = await committedBl(ctx, 'CB32-SIGN-FAILS');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const title = await ctx.repo.getTitle(id);
        const entries = await ctx.repo.listTitleEntries(id);
        const failing = {
          ...ctx.signer,
          kind: ctx.signer.kind,
          jwks: () => ctx.signer.jwks(),
          sign: async () => {
            throw Object.assign(new Error('The signature could not be made'), {
              statusCode: 503,
            });
          },
        };
        const titles = new TitleService({
          repo: ctx.repo,
          events: ctx.events,
          modules: modulesFromSettings({}),
          organisations: ACTIVE_ORGANISATIONS,
          clock: ctx.clock,
          signer: failing,
        });
        await refused(
          titles.apply(
            id,
            {name: 'endorse', to: BANK, inBlank: false},
            staffOf(SHIPPER),
          ),
        );
        expect(await ctx.repo.getTitle(id)).to.deep.equal(title);
        expect(await ctx.repo.listTitleEntries(id)).to.deep.equal(entries);
      });
    });

    if (store.name === 'PostgreSQL') {
      describe('in the database', () => {
        it('has the database refuse a second entry with the same seq for a B/L', async () => {
          const id = await committedBl(ctx, 'CB32-UNIQUE');
          await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          const [entry] = await ctx.repo.listTitleEntries(id);
          const {TitleEntry} = ctx.repo.models;
          const duplicate = await refused(
            TitleEntry.create({...entry, command: 'void'}),
          );
          expect(duplicate).to.be.instanceOf(UniqueConstraintError);
          const [rows] = await ctx.sequelize.query(
            'SELECT count(*)::int AS n FROM shipping_records.bl_title_entry WHERE "recordId" = :id',
            {replacements: {id}},
          );
          expect(rows[0].n).to.equal(1);
        });

        it('rolls the title back when its entry cannot be stored (same transaction)', async () => {
          const id = await committedBl(ctx, 'CB32-ATOMIC');
          await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          const title = await ctx.repo.getTitle(id);
          const entries = await ctx.repo.listTitleEntries(id);
          const repo = {
            ...ctx.repo,
            appendTitleEntry: async () => {
              throw new Error('The entry could not be stored');
            },
          };
          const titles = new TitleService({
            repo,
            events: ctx.events,
            modules: modulesFromSettings({}),
            organisations: ACTIVE_ORGANISATIONS,
            clock: ctx.clock,
            signer: ctx.signer,
          });
          await refused(
            titles.apply(
              id,
              {name: 'endorse', to: BANK, inBlank: false},
              staffOf(SHIPPER),
            ),
          );
          expect(await ctx.repo.getTitle(id)).to.deep.equal(title);
          expect(await ctx.repo.listTitleEntries(id)).to.deep.equal(entries);
        });

        it('reads back entries that still verify (nothing changed by storing them)', async () => {
          const id = await committedBl(ctx, 'CB32-ROUNDTRIP');
          await run(ctx, id, journey());
          const entries = await ctx.repo.listTitleEntries(id);
          const result = await verifyTitleChain(
            entries,
            await ctx.signer.jwks(),
          );
          expect(result.valid).to.equal(true);
        });
      });
    }

    describe('verifying a chain (verifyTitleChain)', () => {
      let id;
      let entries;
      let jwks;
      beforeEach(async () => {
        id = await committedBl(ctx, 'CB32-VERIFY');
        await run(ctx, id, journey());
        entries = await ctx.repo.listTitleEntries(id);
        jwks = await ctx.signer.jwks();
      });

      it('verifies a chain from the first entry to the last, every entry linked, intact and signed', async () => {
        const result = await verifyTitleChain(entries, jwks);
        expect(result).to.deep.equal({
          valid: true,
          entries: entries.map(e => ({
            seq: e.seq,
            linked: true,
            intact: true,
            signed: true,
          })),
        });
      });

      it('verifies offline: from the entries and the key set as JSON, with no network', async () => {
        const savedFetch = globalThis.fetch;
        globalThis.fetch = async () => {
          throw new Error('No network in this test');
        };
        try {
          const exported = JSON.parse(JSON.stringify({entries, jwks}));
          const result = await verifyTitleChain(
            exported.entries,
            exported.jwks,
          );
          expect(result.valid).to.equal(true);
        } finally {
          globalThis.fetch = savedFetch;
        }
      });

      it('fails when any field of any entry is changed', async () => {
        const changes = {
          command: 'void',
          actor: {...entries[1].actor, org: 'org-stranger'},
          from: 'org-stranger',
          to: 'org-stranger',
          endorsement: 'changed',
          documentHash: 'f'.repeat(64),
          at: '2026-11-14T09:00:00.000Z',
          recordId: '00000000-0000-4000-8000-000000000000',
        };
        for (const index of [0, 2, entries.length - 1]) {
          for (const [field, value] of Object.entries(changes)) {
            const tampered = structuredClone(entries);
            tampered[index][field] = value;
            const result = await verifyTitleChain(tampered, jwks);
            expect(result.valid, `${field} of entry ${index + 1}`).to.equal(
              false,
            );
            expect(
              result.entries[index].intact,
              `${field} of entry ${index + 1}`,
            ).to.equal(false);
          }
        }
      });

      it('fails when an entry is changed and hashed again: its signature and the next link break', async () => {
        const tampered = structuredClone(entries);
        const content = {...contentOf(tampered[2]), to: 'org-stranger'};
        tampered[2] = {
          ...content,
          entryHash: sha256Hex(canonicalJson(content)),
          signature: tampered[2].signature,
        };
        const result = await verifyTitleChain(tampered, jwks);
        expect(result.valid).to.equal(false);
        expect(result.entries[2]).to.include({intact: true, signed: false});
        expect(result.entries[3].linked).to.equal(false);
      });

      it('fails when an entry is removed: the first, one in the middle', async () => {
        const withoutFirst = entries.slice(1);
        const first = await verifyTitleChain(withoutFirst, jwks);
        expect(first.valid).to.equal(false);
        expect(first.entries[0].linked).to.equal(false);

        const withoutMiddle = [...entries.slice(0, 2), ...entries.slice(3)];
        const middle = await verifyTitleChain(withoutMiddle, jwks);
        expect(middle.valid).to.equal(false);
        expect(middle.entries[2].linked).to.equal(false);
      });

      it('fails when entries are reordered', async () => {
        const swapped = structuredClone(entries);
        [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
        const result = await verifyTitleChain(swapped, jwks);
        expect(result.valid).to.equal(false);
        expect(result.entries[2].linked).to.equal(false);

        const reversed = await verifyTitleChain([...entries].reverse(), jwks);
        expect(reversed.valid).to.equal(false);
      });

      it('fails when the seq numbers are changed even if the links hold (seq must count 1..n)', async () => {
        const signer = ctx.signer;
        const renumbered = [];
        let previous = null;
        for (const [index, entry] of entries.entries()) {
          const content = {
            ...contentOf(entry),
            seq: index === 0 ? 1 : index + 2,
            previousHash: previous,
          };
          const resigned = await resealed(content, signer);
          renumbered.push(resigned);
          previous = resigned.entryHash;
        }
        const result = await verifyTitleChain(renumbered, jwks);
        expect(result.valid).to.equal(false);
        expect(result.entries[1].linked).to.equal(false);
      });

      it("fails when a signature is replaced by another entry's", async () => {
        const tampered = structuredClone(entries);
        tampered[3].signature = tampered[2].signature;
        const result = await verifyTitleChain(tampered, jwks);
        expect(result.valid).to.equal(false);
        expect(result.entries[3].signed).to.equal(false);
      });

      it("fails when an entry is re-signed with another key under the platform's kid", async () => {
        const forger = await createLocalSigner();
        const forgerKid = (await forger.jwks()).keys[0].kid;
        const tampered = structuredClone(entries);
        const content = {...contentOf(tampered[1]), kid: forgerKid};
        tampered[1] = await resealed(content, forger);
        const result = await verifyTitleChain(tampered, jwks);
        expect(result.valid).to.equal(false);
        expect(result.entries[1].signed).to.equal(false);
      });

      it('fails for a kid in no key of the set, and with an empty key set', async () => {
        for (const kid of ['unknown:v9', 'toString', '__proto__']) {
          const tampered = structuredClone(entries);
          tampered[0].kid = kid;
          const result = await verifyTitleChain(tampered, jwks);
          expect(result.valid, kid).to.equal(false);
          expect(result.entries[0].intact, kid).to.equal(false);
        }
        const noKeys = await verifyTitleChain(entries, {keys: []});
        expect(noKeys.valid).to.equal(false);
        expect(noKeys.entries.every(e => e.signed === false)).to.equal(true);
      });

      it('fails, without throwing, for a signature that is not a JWS', async () => {
        for (const signature of ['', 'x', 'a.b.c', null, undefined]) {
          const tampered = structuredClone(entries);
          tampered[4].signature = signature;
          const result = await verifyTitleChain(tampered, jwks);
          expect(result.valid, String(signature)).to.equal(false);
          expect(result.entries[4].signed, String(signature)).to.equal(false);
        }
      });

      it('fails for an empty chain', async () => {
        expect(await verifyTitleChain([], jwks)).to.deep.equal({
          valid: false,
          entries: [],
        });
      });

      it("starts a split child from its parent's last entry hash, and fails from anything else", async () => {
        const parentLast = entries.at(-1);
        const child = await handMadeChain(
          [
            {
              recordId: '11111111-1111-4111-8111-111111111111',
              command: 'issue',
              actor: staffOf(CARRIER),
              from: null,
              to: SHIPPER,
              endorsement: 'none',
              documentHash: 'c'.repeat(64),
              at: '2026-11-14T10:00:00.000Z',
            },
            {
              recordId: '11111111-1111-4111-8111-111111111111',
              command: 'endorse',
              actor: staffOf(SHIPPER),
              from: SHIPPER,
              to: BANK,
              endorsement: 'named',
              documentHash: 'c'.repeat(64),
              at: '2026-11-14T10:01:00.000Z',
            },
          ],
          ctx.signer,
          parentLast.entryHash,
        );
        const fromParent = await verifyTitleChain(child, jwks, {
          startPreviousHash: parentLast.entryHash,
        });
        expect(fromParent.valid).to.equal(true);

        const fromNothing = await verifyTitleChain(child, jwks);
        expect(fromNothing.valid).to.equal(false);
        expect(fromNothing.entries[0].linked).to.equal(false);

        const fromAnother = await verifyTitleChain(child, jwks, {
          startPreviousHash: entries[0].entryHash,
        });
        expect(fromAnother.valid).to.equal(false);

        const parentWithStart = await verifyTitleChain(entries, jwks, {
          startPreviousHash: parentLast.entryHash,
        });
        expect(parentWithStart.valid).to.equal(false);
      });
    });

    describe('after a key rotation (the key in the key store)', () => {
      it('signs new entries with the new key version; old entries keep their kid and verify', async () => {
        const bao = createFakeOpenBao({keyName: 'title-signing'});
        const transit = createTransitSigner({
          ...bao.settings,
          fetch: bao.fetch,
        });
        const rotating = await makeServices(store, transit);
        try {
          const id = await committedBl(rotating, 'CB32-ROTATION');
          await run(rotating, id, journey().slice(0, 2));
          bao.rotate();
          await run(rotating, id, journey().slice(2, 4));
          const entries = await rotating.repo.listTitleEntries(id);
          expect(entries.map(e => e.kid)).to.deep.equal([
            'title-signing:v1',
            'title-signing:v1',
            'title-signing:v2',
            'title-signing:v2',
          ]);
          const jwks = await transit.jwks();
          const result = await verifyTitleChain(entries, jwks);
          expect(result.valid).to.equal(true);

          // with only the new key, the old entries no longer verify: the kid picks the key
          const newOnly = {
            keys: jwks.keys.filter(k => k.kid === 'title-signing:v2'),
          };
          const partial = await verifyTitleChain(entries, newOnly);
          expect(partial.valid).to.equal(false);
          expect(partial.entries.map(e => e.signed)).to.deep.equal([
            false,
            false,
            true,
            true,
          ]);
        } finally {
          await rotating.close();
        }
      });
    });

    describe('the public keys (GET /records/title/keys)', () => {
      it('answers the key set of the platform signer without a token', async () => {
        const signer = await createLocalSigner();
        const http = await makeHttp(store, {signer});
        try {
          const res = await http.app.inject({
            method: 'GET',
            url: '/records/title/keys',
          });
          expect(res.statusCode).to.equal(200);
          expect(res.headers['content-type']).to.match(/json/);
          const body = res.json();
          expect(body).to.deep.equal(
            JSON.parse(JSON.stringify(await signer.jwks())),
          );
          for (const key of body.keys) {
            expect(key).to.not.have.property('d');
          }
        } finally {
          await http.close();
        }
      });

      it('lists every key version after a rotation, and those keys verify a chain offline', async () => {
        const bao = createFakeOpenBao({keyName: 'title-signing'});
        const transit = createTransitSigner({
          ...bao.settings,
          fetch: bao.fetch,
        });
        const http = await makeHttp(store, {signer: transit});
        try {
          const id = await committedBl(
            {records: http.service},
            'CB32-KEYS-ROUTE',
          );
          await http.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          bao.rotate();
          await http.titles.apply(
            id,
            {name: 'endorse', to: BANK, inBlank: false},
            staffOf(SHIPPER),
          );
          const res = await http.app.inject({
            method: 'GET',
            url: '/records/title/keys',
          });
          expect(res.statusCode).to.equal(200);
          const keys = res.json();
          expect(keys.keys.map(k => k.kid).sort()).to.deep.equal([
            'title-signing:v1',
            'title-signing:v2',
          ]);
          const entries = await http.repo.listTitleEntries(id);
          bao.unreachable = true;
          const result = await verifyTitleChain(entries, keys);
          expect(result.valid).to.equal(true);
        } finally {
          await http.close();
        }
      });
    });
  });
}
