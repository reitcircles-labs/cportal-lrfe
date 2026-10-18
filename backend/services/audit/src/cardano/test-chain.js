// The blockchain of the unit tests, and of the end-to-end test stack (CARDANO_PROVIDER=test, only
// with NODE_ENV=test; see adapter.js). Never used on a system that anchors for real.
import C from '@emurgo/cardano-serialization-lib-nodejs';
import {createHash} from 'node:crypto';
import {addressOf, CardanoError, LABEL, readAnchorMetadata} from './tx.js';

export const PARAMS = {
  minFeeA: 44,
  minFeeB: 155381,
  coinsPerUtxoByte: 4310,
  maxTxSize: 16384,
};
/** A made-up transaction id (64 hex characters) for test number `n`. */
export const txid = n => createHash('sha256').update(`tx ${n}`).digest('hex');
const idOf = tx =>
  Buffer.from(
    C.FixedTransaction.new_from_body_bytes(tx.body().to_bytes())
      .transaction_hash()
      .to_bytes(),
  ).toString('hex');

/**
 * A chain in memory for the Cardano driver interface (drivers.js), with what matters for
 * anchoring: a ledger of unspent outputs, blocks (height) and time (slot), a mempool, transaction
 * expiry and rollbacks. Like a real node, it refuses a transaction whose input is already spent, in
 * the ledger or by a transaction waiting in the mempool, and one whose validity has ended (slot ≥ its
 * ttl, Cardano's invalid_hereafter); expired transactions are never included.
 *
 *   chain.height, chain.slot   raise them to let time pass (a block every 20 slots in the tests)
 *   chain.mempool = true       accepted transactions wait until chain.include(); false: included at once
 *   chain.fail                 a CardanoError every call throws (an outage)
 *   chain.reject               a CardanoError submit throws (refused)
 *   chain.lostReply            submit accepts the transaction, then throws as if it timed out (once)
 *   chain.include()            the mempool's transactions go into the next block
 *   chain.dropMempool()        the mempool forgets its transactions (e.g. a node restart)
 *   chain.rollback(id, { toMempool })  the transaction leaves the chain; back to the mempool or gone
 */
export function createTestChainDriver({
  lovelace = '10000000000',
  synced = true,
} = {}) {
  const chain = {
    ledger: [{txHash: txid(0), index: 0, lovelace, assets: false}],
    blocks: [], // { id, cbor, height, spent }
    waiting: [], // the mempool: { id, cbor, spent, change }
    height: 100,
    slot: 2000,
    mempool: false,
    fail: null,
    reject: null,
    lostReply: false,
    synced,
    get submitted() {
      return chain.blocks;
    },
    include() {
      for (const t of chain.waiting.splice(0)) {
        if (t.ttl !== null && chain.slot >= t.ttl) continue; // expired: dropped, never included
        chain.ledger = chain.ledger
          .filter(u => u !== t.spent)
          .concat([t.change]);
        chain.blocks.push({...t, height: chain.height});
      }
    },
    dropMempool() {
      chain.waiting = [];
    },
    rollback(id, {toMempool = false} = {}) {
      const i = chain.blocks.findIndex(x => x.id === id);
      const [t] = chain.blocks.splice(i, 1);
      chain.ledger = chain.ledger.filter(u => u !== t.change).concat([t.spent]);
      if (toMempool) chain.waiting.push(t);
    },
    /** Another output for the wallet (a top-up). */
    topUp(lovelace = '50000000000') {
      const u = {
        txHash: txid(`topup-${chain.ledger.length}`),
        index: 0,
        lovelace,
        assets: false,
      };
      chain.ledger.push(u);
      return u;
    },
  };
  return {
    chain,
    name: 'test',
    async parameters() {
      if (chain.fail) throw chain.fail;
      return PARAMS;
    },
    async utxos() {
      if (chain.fail) throw chain.fail;
      return chain.ledger;
    },
    async submit(cbor) {
      if (chain.fail) throw chain.fail;
      if (chain.reject) throw chain.reject;
      const tx = C.Transaction.from_hex(cbor);
      const id = idOf(tx);
      const ttl = tx.body().ttl_bignum();
      if (ttl && chain.slot >= Number(ttl.to_str())) {
        throw new CardanoError(
          'The chain refused the transaction: OutsideValidityInterval',
          'EREJECTED',
        );
      }
      chain.waiting = chain.waiting.filter(
        t => t.ttl === null || chain.slot < t.ttl,
      ); // nodes purge what has expired
      const input = tx.body().inputs().get(0);
      const spent = chain.ledger.find(
        u =>
          u.txHash === input.transaction_id().to_hex() &&
          u.index === input.index(),
      );
      const inMempool = chain.waiting.some(t => t.spent === spent);
      if (!spent || inMempool) {
        throw new CardanoError(
          'The chain refused the transaction: BadInputsUTxO (the input is spent or unknown)',
          'EREJECTED',
        );
      }
      const change = {
        txHash: id,
        index: 0,
        lovelace: tx.body().outputs().get(0).amount().coin().to_str(),
        assets: false,
      };
      chain.waiting.push({
        id,
        cbor,
        spent,
        change,
        ttl: ttl ? Number(ttl.to_str()) : null,
      });
      if (!chain.mempool) chain.include();
      if (chain.lostReply) {
        chain.lostReply = false;
        throw new CardanoError(
          'Blockfrost is unreachable: timeout',
          'EUNAVAILABLE',
        );
      }
      return id;
    },
    async output(id) {
      const s = chain.blocks.find(x => x.id === id);
      return {onChain: !!s, blockHeight: s ? s.height : null};
    },
    async tipHeight() {
      if (chain.fail) throw chain.fail;
      return chain.height;
    },
    async tipSlot() {
      if (chain.fail) throw chain.fail;
      return chain.slot;
    },
    async synced() {
      return chain.synced;
    },
    async metadata(id) {
      const s = chain.blocks.find(x => x.id === id);
      return s ? {[LABEL]: readAnchorMetadata(s.cbor)} : null;
    },
  };
}

/**
 * What a public blockchain API (Koios, as the offline verifier reads it) answers about the test
 * chain's transactions: `path` is the API path (`/tx_metadata`, `/tx_status`, `/tx_info`), `txHashes`
 * the `_tx_hashes` of the request. For the end-to-end tests' offline verification (API-672).
 */
export function testChainKoiosAnswer(
  driver,
  path,
  txHashes,
  network = 'preview',
) {
  const payer = cbor =>
    addressOf(
      C.Transaction.from_hex(cbor)
        .witness_set()
        .vkeys()
        .get(0)
        .vkey()
        .public_key()
        .as_bytes(),
      network,
    );
  return txHashes
    .map(tx => {
      const b = driver.chain.blocks.find(x => x.id === tx);
      if (path === '/tx_metadata') {
        return b
          ? {tx_hash: tx, metadata: {[LABEL]: readAnchorMetadata(b.cbor)}}
          : null;
      }
      if (path === '/tx_status') {
        return {
          tx_hash: tx,
          num_confirmations: b ? driver.chain.height - b.height + 1 : null,
        };
      }
      return b
        ? {
            tx_hash: tx,
            block_height: b.height,
            inputs: [{payment_addr: {bech32: payer(b.cbor)}}],
          }
        : null;
    })
    .filter(Boolean);
}
