import {strict as assert} from 'node:assert';

import {loadDomainPack} from '@lrfe/common';

import {cardanoFromEnv} from '../src/cardano/adapter.js';
import {anchorMetadata} from '../src/cardano/tx.js';
import {recordKindOf} from '../src/domain.js';
import {verifyProof, verifyTitleProof} from '../verifier/lrfe-verify.mjs';
import {failedChecks} from './helpers.js';
import {publicSource} from './register.js';
import {auditedChain, bundleOf} from './title-proof.js';

/**
 * CB-49: a shipping install anchors on the same public blockchain as the land registry, under the
 * same label (8890), its batches marked with `"product": "shipping"` in the metadata (CIP-25 style:
 * one label, namespaced keys, a version). A land install's metadata stays exactly as it was (no
 * key = land); the offline verifier requires the key on a title proof and its absence on a land
 * proof.
 */

const ROOT = 'ab'.repeat(32);
const PREV = 'cd'.repeat(32);

/**
 * Koios answering from the fake chain, with the anchoring metadata changed as `edit` says: a
 * stand-in for a transaction written by the other product.
 * @param {object} driver the fake chain's driver
 * @param {function(object): object} edit the metadata as the source should report it
 * @return {function(string, object): !Promise<object>}
 */
function editedSource(driver, edit) {
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
          metadata: {8890: edit({...row.metadata[8890]})},
        })),
    };
  };
}

describe('the product in the anchoring metadata (CB-49)', () => {
  describe('the metadata the audit service writes', () => {
    it('a land install: byte for byte as before (no product key)', () => {
      assert.equal(
        JSON.stringify(
          anchorMetadata({root: ROOT, size: 7, batch: 3, prev: PREV}),
        ),
        `{"v":1,"sys":"lrfe-audit","root":"${ROOT}","size":7,"batch":3,"prev":"${PREV}"}`,
      );
      assert.equal(
        JSON.stringify(
          anchorMetadata({root: ROOT, size: 1, batch: 1, product: null}),
        ),
        `{"v":1,"sys":"lrfe-audit","root":"${ROOT}","size":1,"batch":1}`,
      );
    });

    it('a shipping install: the same object, with "product": "shipping" at the end', () => {
      assert.equal(
        JSON.stringify(
          anchorMetadata({
            root: ROOT,
            size: 7,
            batch: 3,
            prev: PREV,
            product: 'shipping',
          }),
        ),
        `{"v":1,"sys":"lrfe-audit","root":"${ROOT}","size":7,"batch":3,"prev":"${PREV}","product":"shipping"}`,
      );
    });

    it('refuses a product that is not a pack name (it goes on chain as it is)', () => {
      for (const product of ['Shipping', 'a b', '', 'x'.repeat(40), 7]) {
        assert.throws(
          () => anchorMetadata({root: ROOT, size: 1, batch: 1, product}),
          /product/,
          String(product),
        );
      }
    });

    it('the product comes from the pack: land has none, shipping is "shipping"', async () => {
      assert.equal(
        recordKindOf(await loadDomainPack('land')).anchorProduct,
        null,
      );
      assert.equal(
        recordKindOf(await loadDomainPack('shipping')).anchorProduct,
        'shipping',
      );
    });

    it('the adapter writes it into every anchoring it prepares, and only when given', async () => {
      const env = {CARDANO_PROVIDER: 'test', NODE_ENV: 'test'};
      const quiet = {info() {}, warn() {}, error() {}};
      const shipping = cardanoFromEnv(env, {
        logger: quiet,
        product: 'shipping',
      });
      const land = cardanoFromEnv(env, {logger: quiet});
      const shipped = await shipping.prepare({root: ROOT, size: 1, batch: 1});
      const landed = await land.prepare({root: ROOT, size: 1, batch: 1});
      assert.equal(shipped.metadata.product, 'shipping');
      assert.equal('product' in landed.metadata, false);
    });
  });

  describe('the offline verifier', () => {
    let c;
    let anchor;
    let wallet;
    before(async () => {
      c = await auditedChain();
      anchor = await c.proofOfEntry(c.entries.length);
      wallet = await c.audit.cardano.address();
    });
    after(async () => {
      await c.audit.close();
    });

    it('a title proof whose anchoring carries "product": "shipping" is valid', async () => {
      const r = await verifyTitleProof(bundleOf(c, anchor), {
        fetchImpl: publicSource(c.audit.driver),
        address: wallet,
      });
      assert.equal(r.valid, true, JSON.stringify(r.checks));
    });

    it('a title proof whose anchoring has no product (a land transaction) is not valid', async () => {
      const r = await verifyTitleProof(bundleOf(c, anchor), {
        fetchImpl: editedSource(c.audit.driver, md => {
          delete md.product;
          return md;
        }),
        address: wallet,
      });
      assert.equal(r.valid, false);
      assert.deepEqual(failedChecks(r), ['root in the transaction']);
      const check = r.checks.find(x => x.name === 'root in the transaction');
      assert.match(check.detail, /product/);
    });

    it('a land proof (no product asked) is not valid on a shipping transaction', async () => {
      const r = await verifyProof(structuredClone(anchor), {
        fetchImpl: publicSource(c.audit.driver),
        address: wallet,
      });
      assert.deepEqual(failedChecks(r), ['root in the transaction']);
    });

    it('a proof of a shipping install verifies with its product named', async () => {
      const r = await verifyProof(structuredClone(anchor), {
        fetchImpl: publicSource(c.audit.driver),
        address: wallet,
        product: 'shipping',
      });
      assert.equal(r.valid, true, JSON.stringify(r.checks));
    });

    it('a land transaction (no product): the land proof is valid and its check reads as before', async () => {
      const r = await verifyProof(structuredClone(anchor), {
        fetchImpl: editedSource(c.audit.driver, md => {
          delete md.product;
          return md;
        }),
        address: wallet,
      });
      assert.equal(r.valid, true, JSON.stringify(r.checks));
      const check = r.checks.find(x => x.name === 'root in the transaction');
      assert.match(
        check.detail,
        /^label 8890: root [0-9a-f]{16}…, size \d+, batch \d+$/,
      );
    });
  });
});
