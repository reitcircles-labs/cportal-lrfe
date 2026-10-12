// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export default {
    title: 'audit',
    description: 'Audit: a tamper-evident trail with one hash-chained entry per domain event of every service. A growing Merkle tree whose root is anchored on Cardano, and proofs anyone can check; sign-off and evidence packs follow. Design: services/audit/README.md.',
    tags: {
        Trail: 'The audit trail and its hash chain.',
        Proofs: 'Proofs that an item is in a root anchored on Cardano, and checking them.',
        'Sign-off': 'Auditors\' sign-offs and findings, with segregation of duties (sod2).',
        Evidence: 'Evidence packs: a land record with everything needed to check it outside the portal.',
        Anchorings: 'Every batch put on the blockchain, for every signed-in user.',
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
            description: 'Body `{ kind, id, version }` as for the proof. `{ valid, status, checks: { item, path, chain }, checkedAt, explorerUrl, proof }` (`explorerUrl`: the transaction\'s page on a public blockchain explorer; null while waiting). `item`: the seal recomputed from the current data by land-records or edrms (a trail entry: its hashes, and the chain to the checkpoint). `path`: the leaf and the path to the root. `chain`: the root and size in the transaction\'s metadata on the chain (Blockfrost: `source` is the provider), or with the own node, in the signed transaction as sent (`source: "stored"`). Each check has `ok` and, when it fails, `problem`. `valid` only when all three hold; never while `waiting`.'
        },
        'POST /audit/anchoring': {
            tag: 'Proofs', summary: 'The anchoring status of versions (land-records, edrms)',
            description: 'Body `{ keys }`: up to 500 of `record-version:<id>:<n>` and `document-version:<id>:<n>`. `{ items: { <key>: { status, batch, tx, network, confirmedAt } | null } }`; null when the version is not in the tree.'
        },
        'GET /audit/records': {
            tag: 'Sign-off', summary: 'The land records list of the Audit screen',
            description: '`filter`: `changed` (a version committed since the last audit sign-off; the default), `attention` (an open finding, or an item found changed since review and not re-reviewed yet) or `all`; `q` searches as land-records does; `limit` (up to 100) and `offset`. `{ items, total, counts: { changed, attention, all } }`. Each item: `id`, `recordNo`, `label`, `currentVersion`, `changedAt`, `owners`, `proof` (the current version\'s anchoring: `waiting`, `sent`, `onChain`, `confirmed`), `proofBatch` (its batch; null while waiting), `needsAttention`, and `audit`: `range` (the open checkpoint, or null), `newDocuments`, `check` (`matches`, `changed`, `notOnChain`: what is known as of the last check; the record\'s own check runs it again), `openFindings`, `lastSignoff` (`toVersion`, `signedAt`, `signedByName`, and `proof`: how far its trail entry has got, `waiting`, `sent`, `onChain` or `confirmed`, with its `batch` beside it; the checkpoint gives the same as `lastSignoff.proof: { status, batch }`).'
        },
        'GET /audit/anchors': {
            tag: 'Anchorings', summary: 'Every batch put on the blockchain, newest first',
            description: '`status`: `all` (the default), `progress` (sent or in a block, not confirmed yet) or `failed`; `limit` (up to 100) and `offset`. `{ items, total, counts: { all, progress, failed }, confirmationsNeeded, next }`. Each item: `batch`, `createdAt`, `status` (`sent`, `onChain`, `confirmed`, `failed`), `covers` (the new fingerprints since the last batch before it that did not fail; null for a failed one), `txHash` and `explorerUrl` (a public blockchain explorer; null for a failed one), `block`, `confirmations`, `reason` (a failed one: `expired`, `rolledBackExpired` or `refused`), `replacedBy` (a failed one: the next batch) and `replaces` (the failed batch before it). `next`: `{ dueAt, waiting }`, when the next batch is due and how many fingerprints wait for it; null when no blockchain is configured. Every role holds `anchors.view`.'
        },
        'GET /audit/anchoring/wallet': {
            tag: 'Anchorings', summary: 'The published anchoring wallet', auth: 'public',
            description: 'For checking a proof outside the portal (the offline verifier\'s `--address`). `{ address, explorerUrl }`: the wallet that pays for every anchoring, and its page on a public blockchain explorer; both null when no blockchain is configured. 503 while the wallet\'s key cannot be read. No sign-in.'
        },
        'GET /audit/anchors/lookup': {
            tag: 'Anchorings', summary: 'Is it on the blockchain? Find a land record or document',
            description: '`q`: a land record number (`LR-NA-2026-000001`), a document number (`EDR-NA-2026-000412`), a deed or instrument number (`T 2210/2008`), or words (an Erf, a township). Numbers match exactly; words match land records with a committed version, on their number and parcel only (never owners). `{ query, kind }`, `kind` one of: `record` (with `record`, `answer`, `history`), `document` (with `document`, `answer`, `history`), `choices` (several land records matched the words: `choices: [{ recordId, recordNo, label }]`, at most 20) or `none`. `answer` is for the current version, whose seal stands for everything before it: `{ status: "yes", version, batch }` (in a block or confirmed), `{ status: "sent", version, batch }`, `{ status: "waiting", version, nextDueAt }`, or `{ status: "notRecorded", version }` (no fingerprint recorded: no committed version yet, or not in the audit tree). `history`, newest first: each item with `at`, `status` (`waiting`, `sent`, `onChain`, `confirmed`, `notRecorded`) and `batch`; for a land record `version` items (`versionNumber`), `document` items (the documents its versions are made of: `documentId`, `version`, `edrmsNo`, `docType`, `ref`) and `signoff` items (`from`, `to`); for a document its `document` versions and `usedIn` items (the committed land record versions made of it: `recordId`, `recordNo`, `label`, `versionNumber`, `documentVersion`). 30 searches a minute per user (429 after).'
        },
        'GET /audit/anchors/{batch}': {
            tag: 'Anchorings', summary: 'One batch',
            description: 'As in the list, with what is on the blockchain: `root`, `size`, `prev` (`{ root, batch }`: the previous batch\'s root and the batch it belongs to); `steps` (`createdAt`, `sentAt`, `sends`, `onChainAt`, `confirmedAt`, `failedAt`); for a failed one the `replacement` (`batch`, `status`, `createdAt`); `previousBatch` and `nextBatch`. 404 for an unknown batch.'
        },
        'GET /audit/anchors/{batch}/coverage': {
            tag: 'Anchorings', summary: 'What one batch covers',
            description: 'The fingerprints the batch put on the blockchain for the first time (since the last batch before it that did not fail) and the audit sign-offs in the trail up to its checkpoint. `{ batch, kinds: { recordVersions, documentVersions, signoffs }, trailUpTo, records, total }`. `records`: the land records with a version or an audit sign-off in the batch, by record number, paged (`limit` up to 100, `offset`), each with `recordId`, `recordNo`, `label`, `versions` and `signoffs` (`[{ from, to }]`). Each version comes with what its fingerprint stands for: `documents` (how many it is made of), `documentsEarlier` (how many of those reached the blockchain in earlier batches) and `versionsBefore` (chained through the previous version\'s seal). A failed batch covers nothing; 404 for an unknown batch.'
        },
        'GET /audit/anchors/{batch}/documents': {
            tag: 'Anchorings', summary: 'The document versions one batch put on the blockchain',
            description: 'In the order they were sealed, paged (`limit` up to 100, `offset`): `{ batch, items, total }`, each item `documentId`, `version`, `edrmsNo`, `docType` and `ref` (the deed or instrument number; from its filing or correction in the trail, null for a document sealed before the audit service) and `usedIn`: the land record versions in the same batch made of it (`recordId`, `versionNumber`, `recordNo`, `label`). A failed batch has none; 404 for an unknown batch.'
        },
        'GET /audit/records/{id}/check': {
            tag: 'Sign-off', summary: 'The open audit checkpoint of a land record',
            description: 'What the next audit sign-off covers: `range { from, to }` (every version committed since the last audit sign-off, or null), `lastSignoff` (with `proof: { status, batch }`, how far its trail entry has got and in which batch), `versions` and `documents` (the document versions they added that no earlier sign-off covered), each with `anchoring` (`waiting`, `sent`, `onChain`, `confirmed`), `batch` (the batch it is in; null while waiting) and `match` (`matches`, `changed`, `notOnChain`, `unavailable`; a changed one also `superseded` once a re-reviewed version matches), `openFindings`, and `canSignOff` with the `reason` when not, for the user asking. A changed item starts a re-review task for the records desk the first time it is found (bpm process `audit-rereview`).'
        },
        'POST /audit/signoffs': {
            tag: 'Sign-off', summary: 'Sign off the open audit checkpoint of a land record',
            description: 'Body `{ recordId, comment? }`. One sign-off for every version committed since the last one, checked again now: accepted only when everything is in a block on the blockchain, everything matches it, and no finding is open. 201 with the sign-off (`kind: "checkpoint"`, `fromVersion`, `toVersion`, `seal` of the top version, `items` with the version and document seals and the finding ids, `signedByName`, `signedAt`). 403 `{ details: { rule: "sod2" } }` for whoever holds `record.finalize` or approved a version in the range; 409 not on the blockchain yet, changed since review, an open finding, nothing to audit, or signed off by someone else at the same moment; 503 when the check could not run. Also a trail entry (`audit.signoff.recorded`), anchored with the next root.'
        },
        'GET /audit/signoffs': { tag: 'Sign-off', summary: 'Sign-offs of a land record or document', description: '`{ items }`, oldest first; `recordId` and/or `documentId`.' },
        'POST /audit/findings': {
            tag: 'Sign-off', summary: 'Raise a finding',
            description: 'Body `{ recordId, version, documentId?, description }` (a land record version, or a document version in it) or `{ documentId, version, description }` (a document version). On the current version (409 for a replaced one). The records officers and the registrars get a task in their inbox (bpm process `audit-finding`); 503 when bpm cannot be reached (the finding is not raised). 201 with the finding (`status: "open"`, `instanceId`). A trail entry (`audit.finding.raised`).'
        },
        'GET /audit/findings': { tag: 'Sign-off', summary: 'Findings of a land record or document', description: '`{ items }`, oldest first; filter by `recordId`, `documentId`, `status` (`open`, `resolved`, `closed`). For auditors and the records desk.' },
        'GET /audit/findings/{id}': { tag: 'Sign-off', summary: 'One finding', description: 'With `status`, `answers`, and `resolvedByVersion` (a newer reviewed version resolved it) or `outcome`, `closedByName`, `closeReason` (the closing answer), `closedAt`.' },
        'POST /audit/findings/{id}/answers': {
            tag: 'Sign-off', summary: 'Answer a finding',
            description: 'Body `{ text }`. Any auditor, not only the one who raised it. 201 with the finding and its `answers` (`byName`, `role`, `at`, `text`). 409 when it is no longer open. A trail entry (`audit.finding.answered`) with the whole thread under `Findings`.'
        },
        'POST /audit/findings/{id}/close': {
            tag: 'Sign-off', summary: 'Close a finding, answering it',
            description: 'Body `{ outcome, answer }`: `agreed` (resolved by agreement outside the portal, for example in a meeting) or `mistake` (raised by mistake), and the answer: who agreed, when, what was decided. `{ reason }` alone is read as `{ outcome: "mistake", answer: reason }`. 409 when it is no longer open. Its inbox tasks are withdrawn if still open. A trail entry (`audit.finding.closed` with the `outcome`, and the thread under `Findings`); a newer reviewed version closes it the same way with `outcome: "resolved"`.'
        },
        'GET /audit/records/{id}/evidence': {
            tag: 'Evidence', summary: 'The evidence pack of a land record (zip)',
            description: 'Every committed version with its seal, the pinned document versions (metadata and files), the record\'s trail, sign-offs, findings, a proof for each version, document version and trail entry, `manifest.json` (every file\'s SHA-256) and `README.txt`. Check it with the offline verifier: `node lrfe-verify.mjs <pack>.zip --address <wallet>`. The export is a trail entry (`audit.evidence.exported`, with the manifest\'s SHA-256, also in the `x-manifest-sha256` header). 409 when the record has no committed version.'
        },
        'GET /audit/trail/verify': {
            tag: 'Trail', summary: 'Recompute the trail\'s hash chain',
            description: '`{ intact: true, entries, head: { seq, hash, time } }`, or `{ intact: false, entries, brokenAt, problem }`, where `problem` is `changed`, `missing`, `out of order` or `does not follow the entry before it`. `entries` is how many entries were checked before the break.'
        }
    }
};
