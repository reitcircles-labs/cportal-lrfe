// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export default {
    title: 'audit',
    description: 'Audit: a tamper-evident trail with one hash-chained entry per domain event of every service. A growing Merkle tree whose root is anchored on Cardano, and proofs anyone can check; sign-off and evidence packs follow. Design: services/audit/README.md.',
    tags: {
        Trail: 'The audit trail and its hash chain.',
        Proofs: 'Proofs that an item is in a root anchored on Cardano, and checking them.',
        Service: 'Health and metadata.'
    },
    routes: {
        'GET /health': { tag: 'Service', summary: 'Health check', auth: 'public' },
        'GET /audit/trail': {
            tag: 'Trail', summary: 'Trail entries, oldest first',
            description: '`{ total, subjects, entries }`. Each entry has `seq`, `eventId`, `type`, `source`, `time`, `actor`, `subjects`, `data`, `prevHash`, `contentHash` and `hash`. `subject` is `record:<id>`, `document:<id>`, `edrmsNo:<number>`, `intake:<id>`, `process:<id>` or `user:<id>`. A land record or document also brings in the steps of what it is made of: its documents\' capture, filing and amendments, and its review processes. Other records\' steps are left out; `subjects` lists what was included. `type` is an event type, or a prefix ending in a dot (`intake.`). `from` and `to` are dates on the event\'s time (`to` is exclusive).'
        },
        'GET /audit/proofs/{kind}/{id}': {
            tag: 'Proofs', summary: 'The proof of a land record version, a document version or a trail entry',
            description: '`kind` is `record-version` or `document-version` (`id` the land record or document id, `?version=` required) or `trail-entry` (`id` its seq). `{ format: "lrfe-audit-proof/1", status, item, leaf, tree: { size, path, peaks, root }, anchor: { network, label, batch, tx, root, size, address (the anchoring wallet), block, blockIs, confirmations, status, confirmedAt } }`; a trail entry adds `trail: { entry, later, checkpoint }` (the entry, the contentHash of each later entry up to the anchored checkpoint). `status`: `waiting` (not in an anchoring yet: `anchor` is null, and for a trail entry `leaf` and `tree` too), `anchored` or `confirmed`. Save it as a file for the offline verifier (services/audit/verifier). 404 when the item is not in the tree.'
        },
        'POST /audit/verify': {
            tag: 'Proofs', summary: 'Check an item now',
            description: 'Body `{ kind, id, version }` as for the proof. `{ valid, status, checks: { item, path, chain }, checkedAt, proof }`. `item`: the seal recomputed from the current data by land-records or edrms (a trail entry: its hashes, and the chain to the checkpoint). `path`: the leaf and the path to the root. `chain`: the root and size in the transaction\'s metadata on the chain (Blockfrost: `source` is the provider), or with the own node, in the signed transaction as sent (`source: "stored"`). Each check has `ok` and, when it fails, `problem`. `valid` only when all three hold; never while `waiting`.'
        },
        'POST /audit/anchoring': {
            tag: 'Proofs', summary: 'The anchoring status of versions (land-records, edrms)',
            description: 'Body `{ keys }`: up to 500 of `record-version:<id>:<n>` and `document-version:<id>:<n>`. `{ items: { <key>: { status, batch, tx, network, confirmedAt } | null } }`; null when the version is not in the tree.'
        },
        'GET /audit/trail/verify': {
            tag: 'Trail', summary: 'Recompute the trail\'s hash chain',
            description: '`{ intact: true, entries, head: { seq, hash, time } }`, or `{ intact: false, entries, brokenAt, problem }`, where `problem` is `changed`, `missing`, `out of order` or `does not follow the entry before it`. `entries` is how many entries were checked before the break.'
        }
    }
};
