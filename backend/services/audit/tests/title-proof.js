import {randomUUID} from 'node:crypto';

import {
  createEventBus,
  createLocalSigner as createTitleSigner,
  createServiceTokenSigner,
  loadDomainPack,
} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';

import {AnchorService} from '../src/anchor.service.js';
import {buildApp} from '../src/app.js';
import {createCardanoAdapter} from '../src/cardano/adapter.js';
import {createLocalSigner} from '../src/cardano/signer.js';
import {ProofService} from '../src/proof.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {TrailService} from '../src/trail.service.js';
import {TreeService} from '../src/tree.service.js';
import {ShippingRecordsService} from '../../shipping-records/src/records.service.js';
import {TitleService} from '../../shipping-records/src/title.service.js';
import {createMemoryRepo as createShippingRepo} from '../../shipping-records/src/repo/memory.js';
import {exampleWithReference} from '../../shipping-records/tests/helpers.js';
import {fakeDriver} from './helpers.js';

/**
 * What the CB-33 tests share (lrfe-title-proof/1): a B/L's chain of title made by the shipping
 * records service as it is (CB-32), the audit service of a shipping install following its
 * `records.title.<command>` events and anchoring them on the fake chain, and a title proof
 * bundle assembled as the agreed design describes it.
 */

const MINUTE = 60_000;
const quiet = {info() {}, warn() {}, error() {}};
export const SECRET = 'a-test-secret-of-at-least-thirty-two-characters';

/** The organisations of the journey: the carrier owns the B/L. */
export const CARRIER = 'org-carrier';
export const SHIPPER = 'org-shipper';
export const BANK = 'org-bank';
export const BUYER = 'org-buyer';

/** The title proof bundle's format. */
export const TITLE_PROOF_FORMAT = 'lrfe-title-proof/1';

/**
 * A person of an organisation, running title commands.
 * @param {string} org
 * @return {{id: string, name: string, org: string}}
 */
export function staffOf(org) {
  return {id: `u-${org}`, name: `Staff of ${org}`, org};
}

/**
 * A token signer that signs as `service`.
 * @param {string} service
 * @return {function(): string}
 */
export const asService = service =>
  createServiceTokenSigner({secret: SECRET, service});

/**
 * A negotiable B/L of the carrier, committed and issued to the shipper, then endorsed to the
 * bank and by the bank to the buyer (named endorsements): its chain of title as the shipping
 * records service stores it, the platform's public keys and the title after the last entry.
 * `steps` lets a test stop the journey earlier.
 * @param {{reference?: string, steps?: number}} [options]
 * @return {!Promise<{recordId: string, recordNo: string, entries: !Array<object>,
 *     jwks: {keys: !Array<object>}, title: object, actors: !Array<object>}>}
 */
export async function titleChain({reference = 'CB33-CHAIN', steps = 3} = {}) {
  const repo = createShippingRepo();
  const events = createEventBus({driver: 'memory', source: 'shipping-records'});
  let now = Date.parse('2026-11-14T08:00:00Z');
  const clock = () => {
    now += MINUTE;
    return new Date(now);
  };
  const records = new ShippingRecordsService({
    repo,
    events,
    formats: formatsFromSettings({}),
    clock,
  });
  const signer = await createTitleSigner();
  const titles = new TitleService({
    repo,
    events,
    modules: modulesFromSettings({}),
    clock,
    signer,
  });
  const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
  const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};
  const record = await records.createRecord(
    {
      format: 'dcsa-3.0',
      document: exampleWithReference(reference),
      partyOrganisations: {shipper: SHIPPER},
    },
    drafter,
    CARRIER,
  );
  await records.submit(record.id, 1, drafter, CARRIER);
  await records.commit(record.id, 1, {by: approver}, 'bpm');
  const journey = [
    [CARRIER, {name: 'issue'}],
    [SHIPPER, {name: 'endorse', to: BANK, inBlank: false}],
    [BANK, {name: 'endorse', to: BUYER, inBlank: false}],
  ].slice(0, steps);
  const actors = [];
  for (const [org, command] of journey) {
    await titles.apply(record.id, command, staffOf(org));
    actors.push(staffOf(org));
  }
  const stored = await repo.getRecord(record.id);
  return {
    recordId: record.id,
    recordNo: stored.recordNo,
    entries: structuredClone(await repo.listTitleEntries(record.id)),
    jwks: structuredClone(await titles.keys()),
    title: await repo.getTitle(record.id),
    actors,
  };
}

/**
 * The event a chain entry is published as (the agreed design): `records.title.<command>` from
 * shipping-records, its data the record's id and number, the entry's seq and the full signed
 * entry, never the document.
 * @param {object} entry
 * @param {{recordNo: string, actor: object, time?: string}} context
 * @return {object}
 */
export function titleEvent(entry, {recordNo, actor, time}) {
  return {
    id: randomUUID(),
    type: `records.title.${entry.command}`,
    source: 'shipping-records',
    time: time ?? entry.at,
    actor,
    data: {recordId: entry.recordId, recordNo, seq: entry.seq, entry},
  };
}

/**
 * The audit service of an install with the given pack (shipping by default), following events
 * into its trail and tree and anchoring them on the fake chain; its HTTP app.
 * @param {{packName?: string}} [options]
 * @return {!Promise<object>}
 */
export async function titleAudit({packName = 'shipping'} = {}) {
  const pack = await loadDomainPack(packName);
  const repo = createMemoryRepo();
  let now = Date.parse('2026-11-14T12:00:00Z');
  const clock = () => new Date(now);
  clock.advance = ms => {
    now += ms;
  };
  const trail = new TrailService({repo, clock, logger: quiet, pack});
  const tree = new TreeService({repo, clock, logger: quiet, pack});
  const driver = fakeDriver();
  const cardano = createCardanoAdapter({
    driver,
    signer: createLocalSigner(),
    network: 'preview',
    logger: quiet,
  });
  const job = new AnchorService({
    repo,
    tree,
    cardano,
    logger: quiet,
    clock,
    config: {confirmations: 10},
  });
  const proofs = new ProofService({
    repo,
    tree,
    cardano,
    clock,
    logger: quiet,
    pack,
  });
  const app = await buildApp({service: trail, proofs, jwtSecret: SECRET});
  await app.ready();

  /**
   * What the audit consumer does with an event: a trail entry and, for a seal, a tree leaf.
   * @param {object} event
   * @return {!Promise<object>} the trail entry
   */
  const consume = async event => {
    const entry = await trail.record(event);
    await tree.fromEvent(event);
    return entry;
  };
  /** Runs the hourly job until an anchoring is confirmed (a block a minute). */
  const anchor = async () => {
    clock.advance(3_600_000);
    for (let i = 0; i < 40; i++) {
      if ((await job.tick()).action === 'confirmed') {
        return;
      }
      clock.advance(MINUTE);
      driver.chain.height++;
      driver.chain.slot += 60;
    }
    throw new Error('no anchoring confirmed');
  };
  /**
   * Asks the audit service for the trail-entry proof of an event, as a service or a person.
   * @param {string} eventId
   * @param {{authorization?: string}} [headers]
   * @return {!Promise<object>} the HTTP answer
   */
  const entryProof = (eventId, headers) =>
    app.inject({
      method: 'POST',
      url: '/audit/anchoring/entry-proof',
      headers,
      payload: {eventId},
    });
  return {
    pack,
    repo,
    clock,
    trail,
    tree,
    driver,
    cardano,
    job,
    proofs,
    app,
    consume,
    anchor,
    entryProof,
    close: () => app.close(),
  };
}

/**
 * A service's auth header.
 * @param {string} service
 * @return {{authorization: string}}
 */
export function serviceHeader(service) {
  return {authorization: `Bearer ${asService(service)()}`};
}

/**
 * A B/L's chain followed by the audit service of a shipping install: each entry published as its
 * event and recorded, optionally anchored. Gives the chain, the events, their trail entries, the
 * audit service and `proofOfEntry(seq)`.
 * @param {{anchored?: boolean, steps?: number, reference?: string}} [options]
 * @return {!Promise<object>}
 */
export async function auditedChain({
  anchored = true,
  steps = 3,
  reference,
} = {}) {
  const chain = await titleChain({steps, reference});
  const audit = await titleAudit();
  const events = [];
  const trailEntries = [];
  for (const [i, entry] of chain.entries.entries()) {
    const event = titleEvent(entry, {
      recordNo: chain.recordNo,
      actor: chain.actors[i],
    });
    trailEntries.push(await audit.consume(event));
    events.push(event);
  }
  if (anchored) {
    await audit.anchor();
  }
  /**
   * The audit's trail-entry proof of the event of entry `seq` (1..n), as JSON carries it.
   * @param {number} seq
   * @return {!Promise<object>}
   */
  const proofOfEntry = async seq =>
    JSON.parse(
      JSON.stringify(
        await audit.proofs.proof(
          'trail-entry',
          String(trailEntries[seq - 1].seq),
        ),
      ),
    );
  return {...chain, audit, events, trailEntries, proofOfEntry};
}

/**
 * A title proof bundle (lrfe-title-proof/1) as the agreed design describes it: every entry, the
 * keys, and the trail-entry proof of the last entry (or `{pending: true}` before anchoring).
 * @param {object} chain titleChain's answer
 * @param {object} anchor the audit's trail-entry proof, or {pending: true}
 * @param {{entries?: !Array<object>}} [options] other entries (tampering tests)
 * @return {object}
 */
export function bundleOf(chain, anchor, {entries} = {}) {
  return structuredClone({
    format: TITLE_PROOF_FORMAT,
    recordId: chain.recordId,
    recordNo: chain.recordNo,
    entries: entries ?? chain.entries,
    jwks: chain.jwks,
    anchor,
  });
}
