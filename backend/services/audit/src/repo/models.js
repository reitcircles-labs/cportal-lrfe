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

    return { TrailEntry };
}
