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

    return { TrailEntry, TreeLeaf, TreeNode };
}
