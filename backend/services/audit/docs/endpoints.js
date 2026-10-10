// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export default {
    title: 'audit',
    description: 'Audit: a tamper-evident trail with one hash-chained entry per domain event of every service. A growing Merkle tree whose root is anchored on Cardano, and proofs anyone can check; sign-off and evidence packs follow. Design: services/audit/README.md.',
    tags: {
        Trail: 'The audit trail and its hash chain.',
        Proofs: 'Proofs that an item is in a root anchored on Cardano, and checking them.',
        'Sign-off': 'Auditors\' sign-offs and findings, with segregation of duties (sod2).',
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
        'POST /audit/signoffs': {
            tag: 'Sign-off', summary: 'Sign off a land record version, or a document version in it',
            description: 'Body `{ recordId, version, documentId?, comment }`. The version must be committed; `documentId` must be pinned in it. 201 with the sign-off (`id`, the record and document numbers and versions, the `seal` of what was signed off, `comment`, `signedById`, `signedByName`, `signedAt`). 403 `{ details: { rule: "sod2" } }` for whoever holds `record.finalize` ("You can finalize land records: an auditor without that permission must sign it off") or approved the version or document version ("You approved this version: another auditor must sign it off"). 409 when this auditor already signed it off. Also a trail entry (`audit.signoff.recorded`), anchored with the next root.'
        },
        'GET /audit/signoffs': { tag: 'Sign-off', summary: 'Sign-offs of a land record or document', description: '`{ items }`, oldest first; `recordId` and/or `documentId`.' },
        'POST /audit/findings': {
            tag: 'Sign-off', summary: 'Raise a finding',
            description: 'Body `{ recordId, version, documentId?, description }` (a land record version, or a document version in it) or `{ documentId, version, description }` (a document version). On the current version (409 for a replaced one). The records officers and the registrars get a task in their inbox (bpm process `audit-finding`); 503 when bpm cannot be reached (the finding is not raised). 201 with the finding (`status: "open"`, `instanceId`). A trail entry (`audit.finding.raised`).'
        },
        'GET /audit/findings': { tag: 'Sign-off', summary: 'Findings of a land record or document', description: '`{ items }`, oldest first; filter by `recordId`, `documentId`, `status` (`open`, `resolved`, `closed`). For auditors and the records desk.' },
        'GET /audit/findings/{id}': { tag: 'Sign-off', summary: 'One finding', description: 'With `status`, and `resolvedByVersion` (a newer reviewed version resolved it) or `closedByName`, `closeReason`, `closedAt`.' },
        'POST /audit/findings/{id}/close': {
            tag: 'Sign-off', summary: 'Close a finding with a reason',
            description: 'Body `{ reason }`. 409 when it is no longer open. Its inbox tasks are withdrawn if still open. A trail entry (`audit.finding.closed`, `outcome: "closed"`); a newer reviewed version closes it the same way with `outcome: "resolved"`.'
        },
        'GET /audit/trail/verify': {
            tag: 'Trail', summary: 'Recompute the trail\'s hash chain',
            description: '`{ intact: true, entries, head: { seq, hash, time } }`, or `{ intact: false, entries, brokenAt, problem }`, where `problem` is `changed`, `missing`, `out of order` or `does not follow the entry before it`. `entries` is how many entries were checked before the break.'
        }
    }
};
