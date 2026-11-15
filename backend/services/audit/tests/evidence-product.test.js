import {strict as assert} from 'node:assert';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {readPack, verifyPack} from '../verifier/lrfe-verify.mjs';
import {failedChecks} from './helpers.js';
import {audited, people, publicSource} from './register.js';

/**
 * CB-49: an evidence pack of a shipping install, whose anchorings say "product": "shipping",
 * verifies with that product named (`--product shipping`); a land pack verifies as before, and
 * never with another product's transactions.
 */

/**
 * Koios answering from the fake chain with "product": "shipping" in every anchoring's metadata:
 * the transactions of a shipping install.
 * @param {object} driver the fake chain's driver
 * @return {function(string, object): !Promise<object>}
 */
function shippingSource(driver) {
  const source = publicSource(driver);
  return async (url, init) => {
    const res = await source(url, init);
    if (!url.endsWith('/tx_metadata')) {
      return res;
    }
    const rows = await res.json();
    return {
      ok: true,
      status: 200,
      json: async () =>
        rows.map(row => ({
          ...row,
          metadata: {8890: {...row.metadata[8890], product: 'shipping'}},
        })),
    };
  };
}

/**
 * A land record anchored on the fake chain, and its evidence pack as the auditor downloads it,
 * unpacked by the verifier's own reader (as evidence.test.js does).
 * @return {!Promise<{files: !Map<string, !Buffer>, address: string, driver: object}>}
 */
async function anchoredPack() {
  const a = await audited();
  await a.anchor();
  const res = await a.auditApp.inject({
    url: `/audit/records/${a.record.id}/evidence`,
    headers: a.as(people.aud),
  });
  await a.settle();
  const dir = mkdtempSync(join(tmpdir(), 'lrfe-pack-'));
  try {
    writeFileSync(join(dir, 'pack.zip'), res.rawPayload);
    return {
      files: readPack(join(dir, 'pack.zip')),
      address: await a.cardano.address(),
      driver: a.driver,
    };
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

describe('evidence packs and the product of the install (CB-49)', () => {
  let pack;
  before(async () => {
    pack = await anchoredPack();
  });

  it('a land pack verifies as before, with no product named', async () => {
    const r = await verifyPack(pack.files, {
      address: pack.address,
      fetchImpl: publicSource(pack.driver),
    });
    assert.equal(r.valid, true, JSON.stringify(failedChecks(r)));
  });

  it("a shipping install's pack verifies with its product named", async () => {
    const r = await verifyPack(pack.files, {
      address: pack.address,
      fetchImpl: shippingSource(pack.driver),
      product: 'shipping',
    });
    assert.equal(r.valid, true, JSON.stringify(failedChecks(r)));
  });

  it("a shipping install's pack checked as a land pack is not valid", async () => {
    const r = await verifyPack(pack.files, {
      address: pack.address,
      fetchImpl: shippingSource(pack.driver),
    });
    assert.equal(r.valid, false);
  });

  it('a land pack checked as a shipping pack is not valid', async () => {
    const r = await verifyPack(pack.files, {
      address: pack.address,
      fetchImpl: publicSource(pack.driver),
      product: 'shipping',
    });
    assert.equal(r.valid, false);
  });
});
