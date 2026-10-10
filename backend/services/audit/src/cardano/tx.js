import C from '@emurgo/cardano-serialization-lib-nodejs';

/**
 * Building the anchoring transaction (README.md section 3): one input and one change output to the
 * wallet's own address, no script, the root in the metadata under label 8890. The fee is computed
 * from the chain's current parameters (fee = minFeeA × size + minFeeB), for the transaction as it
 * will be sent, signature included.
 */
export const LABEL = 8890;
export const NETWORK_IDS = { preview: 0, preprod: 0, mainnet: 1 };

export class CardanoError extends Error {
    /**
     * code: EUNAVAILABLE (provider unreachable, slow or failing: retry later), EREJECTED (the chain
     * refused the transaction), EFUNDS (the wallet cannot pay), ESIGN (OpenBao could not sign),
     * ECONFIG (a setting is missing or wrong).
     */
    constructor(message, code, { cause, details } = {}) {
        super(message);
        this.name = 'CardanoError';
        this.code = code;
        this.retryable = code === 'EUNAVAILABLE' || code === 'ESIGN';         // ESPENT: an output to spend is gone
        if (details) this.details = details;
        if (cause) this.cause = cause;
    }
}

/** The wallet's enterprise address (payment key only, no staking) for a 32-byte Ed25519 public key. */
export function addressOf(publicKey, network) {
    if (!(network in NETWORK_IDS)) throw new CardanoError(`Unknown Cardano network "${network}"`, 'ECONFIG');
    const key = C.PublicKey.from_bytes(publicKey);
    return C.EnterpriseAddress.new(NETWORK_IDS[network], C.Credential.from_keyhash(key.hash())).to_address()
        .to_bech32(NETWORK_IDS[network] === 1 ? 'addr' : 'addr_test');
}

/** The metadata of one anchoring. Strings are at most 64 bytes on chain: hashes go as 64 hex characters. */
export function anchorMetadata({ root, size, batch, prev }) {
    const hex = /^[0-9a-f]{64}$/;
    if (!hex.test(root || '')) throw new CardanoError('An anchoring needs the root as 64 hex characters', 'ECONFIG');
    if (prev && !hex.test(prev)) throw new CardanoError('The previous root must be 64 hex characters', 'ECONFIG');
    return { v: 1, sys: 'lrfe-audit', root, size, batch, ...(prev ? { prev } : {}) };
}

/**
 * Build the transaction and its 32-byte body hash, which the wallet's key signs. `ttl`: the slot
 * from which it is invalid (Cardano's invalid_hereafter: valid only in slots before it). `input`:
 * spend exactly this output (a re-anchoring spends the input of the one it replaces, so the two can
 * never both land); when it is gone, CardanoError ESPENT. `utxos`:
 * [{ txHash, index, lovelace, assets }] (outputs holding other tokens are not spent);
 * `params`: { minFeeA, minFeeB, coinsPerUtxoByte, maxTxSize }.
 * Returns { bodyHash, fee, change, input, sign(signature) → { cbor, txHash, bytes } }.
 */
export function buildAnchorTx({ utxos, address, publicKey, params, metadata, ttl, input: wanted }) {
    const addr = C.Address.from_bech32(address);
    // a fresh object each time: the library takes ownership of what it is given
    const makeAux = () => {
        const md = C.GeneralTransactionMetadata.new();
        md.insert(C.BigNum.from_str(String(LABEL)), C.encode_json_str_to_metadatum(JSON.stringify(metadata), C.MetadataJsonSchema.NoConversions));
        const aux = C.AuxiliaryData.new();
        aux.set_metadata(md);
        return aux;
    };
    const auxHash = C.hash_auxiliary_data(makeAux()).to_bytes();

    // one input: the largest output holding ADA only (normally the change of the last anchoring)
    const spendable = utxos.filter(u => !u.assets).sort((a, b) => (BigInt(b.lovelace) > BigInt(a.lovelace) ? 1 : -1));
    const input = wanted ? spendable.find(u => u.txHash === wanted.txHash && u.index === wanted.index) : spendable[0];
    if (wanted && !input) throw new CardanoError(`The output ${wanted.txHash}#${wanted.index} is no longer unspent`, 'ESPENT');
    if (!input) throw new CardanoError(`The anchoring wallet ${address} has no funds`, 'EFUNDS');
    const tooLittle = () => new CardanoError(`The anchoring wallet holds ${lovelaceToAda(input.lovelace)} ADA in its largest output; that does not pay for an anchoring`, 'EFUNDS');
    if (BigInt(input.lovelace) <= BigInt(params.minFeeB)) throw tooLittle();

    const body = (fee) => {
        const inputs = C.TransactionInputs.new();
        inputs.add(C.TransactionInput.new(C.TransactionHash.from_hex(input.txHash), input.index));
        const outputs = C.TransactionOutputs.new();
        outputs.add(C.TransactionOutput.new(addr, C.Value.new(C.BigNum.from_str(String(BigInt(input.lovelace) - fee)))));
        const b = C.TransactionBody.new_tx_body(inputs, outputs, C.BigNum.from_str(String(fee)));
        b.set_auxiliary_data_hash(C.AuxiliaryDataHash.from_bytes(auxHash));
        if (ttl !== undefined) b.set_ttl(C.BigNum.from_str(String(ttl)));
        return b;
    };
    const witnessed = (b, signature) => {
        const w = C.Vkeywitnesses.new();
        w.add(C.Vkeywitness.new(C.Vkey.new(C.PublicKey.from_bytes(publicKey)), C.Ed25519Signature.from_bytes(signature)));
        const ws = C.TransactionWitnessSet.new();
        ws.set_vkeys(w);
        return C.Transaction.new(b, ws, makeAux());
    };

    // the fee depends on the size, which depends (by a byte or so) on the fee: settle it
    let fee = BigInt(params.minFeeB);
    for (let i = 0; i < 5; i++) {
        const bytes = witnessed(body(fee), Buffer.alloc(64)).to_bytes().length;
        const needed = BigInt(params.minFeeA) * BigInt(bytes) + BigInt(params.minFeeB);
        if (needed <= fee) break;
        fee = needed;
        if (BigInt(input.lovelace) <= fee) throw tooLittle();
    }
    const change = BigInt(input.lovelace) - fee;
    const minChange = BigInt(C.min_ada_for_output(
        C.TransactionOutput.new(addr, C.Value.new(C.BigNum.from_str(String(change > 0n ? change : 1n)))),
        C.DataCost.new_coins_per_byte(C.BigNum.from_str(String(params.coinsPerUtxoByte)))
    ).to_str());
    if (change < minChange) {
        throw new CardanoError(`The anchoring wallet holds ${lovelaceToAda(input.lovelace)} ADA in its largest output; an anchoring needs ${lovelaceToAda(fee + minChange)} ADA`, 'EFUNDS');
    }
    const final = body(fee);
    const bodyHash = Buffer.from(C.FixedTransaction.new_from_body_bytes(final.to_bytes()).transaction_hash().to_bytes());
    return {
        bodyHash, fee, change, input,
        sign(signature) {
            const tx = witnessed(final, signature);
            const bytes = tx.to_bytes();
            if (bytes.length > params.maxTxSize) throw new CardanoError(`The transaction is ${bytes.length} bytes; the chain takes at most ${params.maxTxSize}`, 'EREJECTED');
            return { cbor: Buffer.from(bytes).toString('hex'), txHash: bodyHash.toString('hex'), bytes: bytes.length };
        }
    };
}

/** The anchoring metadata in a transaction (CBOR hex), or null. */
export function readAnchorMetadata(cbor) {
    const tx = C.Transaction.from_hex(cbor);
    const md = tx.auxiliary_data()?.metadata()?.get(C.BigNum.from_str(String(LABEL)));
    return md ? JSON.parse(C.decode_metadatum_to_json_str(md, C.MetadataJsonSchema.NoConversions)) : null;
}

export const lovelaceToAda = (l) => (Number(BigInt(l)) / 1e6).toFixed(6).replace(/\.?0+$/, '');

/**
 * The anchoring metadata a stored signed transaction commits to (API-658), or null when it does
 * not hold together: its id is the hash of its body, the body holds the hash of the metadata (so the
 * transaction `txHash` can only carry this metadata), and it is signed by the anchoring wallet's key
 * (`address`), so only that key can have made it. Used where the provider cannot look up a past
 * transaction (the own node: Ogmios keeps no index of them).
 */
export function committedMetadata(cbor, txHash, address) {
    try {
        const tx = C.Transaction.from_hex(cbor);
        const bodyHash = C.FixedTransaction.new_from_body_bytes(tx.body().to_bytes()).transaction_hash();
        const aux = tx.auxiliary_data();
        const declared = tx.body().auxiliary_data_hash();
        if (bodyHash.to_hex() !== txHash || !aux || !declared || C.hash_auxiliary_data(aux).to_hex() !== declared.to_hex()) return null;
        const wallet = C.EnterpriseAddress.from_address(C.Address.from_bech32(address))?.payment_cred().to_keyhash()?.to_hex();
        const vkeys = tx.witness_set().vkeys();
        let signed = false;
        for (let i = 0; wallet && vkeys && i < vkeys.len(); i++) {
            const w = vkeys.get(i);
            const key = w.vkey().public_key();
            if (key.hash().to_hex() === wallet && key.verify(bodyHash.to_bytes(), w.signature())) signed = true;
        }
        return signed ? readAnchorMetadata(cbor) : null;
    } catch { return null; }
}
