import { DataTypes } from 'sequelize';

export const SCHEMA = 'audit';

/** Sequelize models for the `audit` Postgres schema (README.md section 1). */
export function defineModels(sequelize) {
    const opts = (extra = {}) => ({ schema: SCHEMA, freezeTableName: true, timestamps: false, ...extra });

    // One per durable domain event, append-only; hash-chained in `seq` order.
    const TrailEntry = sequelize.define('trail_entry', {
        seq: { type: DataTypes.BIGINT, primaryKey: true },                 // 1, 2, 3 … without gaps
        eventId: { type: DataTypes.STRING, allowNull: false, unique: true },
        type: { type: DataTypes.STRING, allowNull: false },
        source: { type: DataTypes.STRING, allowNull: false },
        // the event's time exactly as published (text: it is hashed)
        time: { type: DataTypes.STRING, allowNull: false },
        actor: { type: DataTypes.JSONB, allowNull: false },
        // what it is about: ['record:…', 'document:…', 'user:…'] (subjects.js)
        subjects: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        data: { type: DataTypes.JSONB, allowNull: false },
        prevHash: { type: DataTypes.STRING(64), allowNull: false },
        contentHash: { type: DataTypes.STRING(64), allowNull: false },
        hash: { type: DataTypes.STRING(64), allowNull: false },
        recordedAt: { type: DataTypes.DATE, allowNull: false }              // when the audit service wrote it (not hashed)
    }, opts({ indexes: [{ fields: ['type'] }, { fields: ['time'] }, { fields: ['subjects'], using: 'gin' }] }));

    // The growing Merkle tree (README.md section 2): one row per leaf, one per node (leaves and
    // inner nodes) by post-order position. Append-only.
    const TreeLeaf = sequelize.define('tree_leaf', {
        leafIndex: { type: DataTypes.BIGINT, primaryKey: true },            // 0, 1, 2 … in the order added
        // what it is, once: record-version:<id>:<n>, document-version:<id>:<n>, trail-checkpoint:<seq>
        key: { type: DataTypes.STRING, allowNull: false, unique: true },
        type: { type: DataTypes.SMALLINT, allowNull: false },               // 1 record version, 2 document version, 3 trail checkpoint
        item: { type: DataTypes.STRING(64), allowNull: false },             // the seal or trail hash (hex)
        eventId: { type: DataTypes.STRING },                                // the event it came from, if any
        createdAt: { type: DataTypes.DATE, allowNull: false }
    }, opts());
    const TreeNode = sequelize.define('tree_node', {
        pos: { type: DataTypes.BIGINT, primaryKey: true },
        hash: { type: DataTypes.BLOB, allowNull: false }                    // 32 bytes
    }, opts());

    // One per anchoring on Cardano (README.md section 3): the audit service's own bookkeeping, not in the trail.
    const Anchor = sequelize.define('anchor', {
        batch: { type: DataTypes.INTEGER, primaryKey: true },               // 1, 2, 3 …
        root: { type: DataTypes.STRING(64), allowNull: false },
        size: { type: DataTypes.BIGINT, allowNull: false },                 // leaves covered: 0 … size-1
        prevRoot: { type: DataTypes.STRING(64) },
        checkpointSeq: { type: DataTypes.BIGINT },                          // the trail head it covers
        network: { type: DataTypes.STRING, allowNull: false },
        // prepared → submitted → onChain → confirmed; or failed (expired or refused: a later anchoring covers it)
        status: { type: DataTypes.STRING, allowNull: false },
        txHash: { type: DataTypes.STRING(64) },
        cbor: { type: DataTypes.TEXT },                                     // the signed transaction, sent again if needed
        ttl: { type: DataTypes.BIGINT },                                    // invalid from this slot on (invalid_hereafter)
        inputTxHash: { type: DataTypes.STRING(64) },                        // the wallet output it spends
        inputIndex: { type: DataTypes.INTEGER },
        expiredSeenHeight: { type: DataTypes.INTEGER },                     // block height when first seen past ttl, not on chain
        spentSeenHeight: { type: DataTypes.INTEGER },                       // block height when its input was first found spent
        lastSentAt: { type: DataTypes.DATE },
        fee: { type: DataTypes.BIGINT },
        bytes: { type: DataTypes.INTEGER },
        firstSeenHeight: { type: DataTypes.INTEGER },                       // block height when first seen on chain
        blockHeight: { type: DataTypes.INTEGER },                           // its own block, when the provider knows it
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        error: { type: DataTypes.TEXT },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        submittedAt: { type: DataTypes.DATE },
        confirmedAt: { type: DataTypes.DATE }
    }, opts({ indexes: [{ fields: ['status'] }] }));
    // Which instance runs the anchoring job (one at a time), until when.
    const JobLease = sequelize.define('job_lease', {
        name: { type: DataTypes.STRING, primaryKey: true },
        holder: { type: DataTypes.STRING, allowNull: false },
        expiresAt: { type: DataTypes.DATE, allowNull: false }
    }, opts());

    // Sign-offs and findings (README.md section 5, API-659): what an auditor recorded about a land record
    // version or a document version. Each is also a durable event, so it is in the trail and anchored.
    const item = {
        recordId: { type: DataTypes.UUID },                                 // the land record version …
        recordNo: { type: DataTypes.STRING },
        recordVersion: { type: DataTypes.INTEGER },
        documentId: { type: DataTypes.UUID },                               // … or a document version (in it)
        edrmsNo: { type: DataTypes.STRING },
        documentVersion: { type: DataTypes.INTEGER },
        seal: { type: DataTypes.STRING(64) }                                // the seal of what was looked at
    };
    // An audit sign-off (API-680) is a checkpoint: `kind` 'checkpoint', the versions fromVersion …
    // toVersion (recordVersion = toVersion, seal = its seal) and in `items` the version and document
    // seals it covers and the ids of the findings in its range. API-659's sign-offs of one item have
    // `kind` 'item' and stay readable as history.
    const Signoff = sequelize.define('signoff', {
        id: { type: DataTypes.UUID, primaryKey: true },
        kind: { type: DataTypes.STRING, allowNull: false, defaultValue: 'item' },
        ...item,
        fromVersion: { type: DataTypes.INTEGER },
        toVersion: { type: DataTypes.INTEGER },
        items: { type: DataTypes.JSONB },
        comment: { type: DataTypes.TEXT },
        signedById: { type: DataTypes.STRING, allowNull: false },
        signedByName: { type: DataTypes.STRING },
        signedAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['recordId'] }, { fields: ['documentId'] }] }));
    const Finding = sequelize.define('finding', {
        id: { type: DataTypes.UUID, primaryKey: true },
        ...item,
        description: { type: DataTypes.TEXT, allowNull: false },
        status: { type: DataTypes.STRING, allowNull: false },               // open → resolved (a newer version) | closed (by an auditor)
        outcome: { type: DataTypes.STRING },                                // when closed: agreed (resolved outside the portal) | mistake
        answers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },   // auditors' answers: { byId, byName, role, at, text }
        raisedById: { type: DataTypes.STRING, allowNull: false },
        raisedByName: { type: DataTypes.STRING },
        raisedAt: { type: DataTypes.DATE, allowNull: false },
        instanceId: { type: DataTypes.UUID },                               // the bpm process that notifies the records desk
        resolvedByVersion: { type: DataTypes.INTEGER },
        closedById: { type: DataTypes.STRING },
        closedByName: { type: DataTypes.STRING },
        closeReason: { type: DataTypes.TEXT },
        closedAt: { type: DataTypes.DATE }
    }, opts({ indexes: [{ fields: ['recordId', 'status'] }, { fields: ['documentId', 'status'] }] }));

    // A changed item (no longer matching the blockchain, API-680): found once, when its re-review task
    // was started. Keyed by the item's leaf key.
    const ChangedAlert = sequelize.define('changed_alert', {
        key: { type: DataTypes.STRING, primaryKey: true },
        recordId: { type: DataTypes.UUID, allowNull: false },
        recordNo: { type: DataTypes.STRING },
        versionNumber: { type: DataTypes.INTEGER },
        documentId: { type: DataTypes.UUID },
        edrmsNo: { type: DataTypes.STRING },
        documentVersion: { type: DataTypes.INTEGER },
        currentVersion: { type: DataTypes.INTEGER, allowNull: false },      // the record's current version when it was found
        instanceId: { type: DataTypes.UUID },                               // the bpm re-review process
        foundAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['recordId'] }] }));

    return { TrailEntry, TreeLeaf, TreeNode, Anchor, JobLease, Signoff, Finding, ChangedAlert };
}
