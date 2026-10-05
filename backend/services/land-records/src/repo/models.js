import { DataTypes } from 'sequelize';

export const SCHEMA = 'records';

/**
 * Sequelize models for the `records` Postgres schema (README.md sections 1 and 5). Every attribute
 * gets its own definition object (Sequelize writes the column name into it).
 */
export function defineModels(sequelize) {
    const opts = (extra = {}) => ({ schema: SCHEMA, freezeTableName: true, timestamps: false, ...extra });
    const s = () => ({ type: DataTypes.STRING });
    const d = () => ({ type: DataTypes.DATE });

    // One per parcel.
    const Record = sequelize.define('land_record', {
        id: { type: DataTypes.UUID, primaryKey: true },
        recordNo: { type: DataTypes.STRING, allowNull: false, unique: true },
        parcelKey: { type: DataTypes.STRING, allowNull: false, unique: true },
        kind: { type: DataTypes.STRING, allowNull: false },
        label: { type: DataTypes.STRING, allowNull: false },
        // draft = never committed; committed = has a current version (a change may be in progress)
        status: { type: DataTypes.ENUM('draft', 'committed'), allowNull: false },
        currentVersion: { type: DataTypes.INTEGER },
        draftVersion: { type: DataTypes.INTEGER },
        draftState: { type: DataTypes.ENUM('draft', 'in_review') },          // state of the open draft, for lists
        // e.g. [{ type: 'document_updated', edrmsNo, from, to, at }] (README.md section 8)
        flags: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // parcel, record number, owners' names and ID numbers of the current version and the draft
        searchText: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        createdById: s(), createdByName: s(),
        updatedAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['status'] }] }));

    // One row per version. Committed versions are never changed again (only superseded).
    const Version = sequelize.define('record_version', {
        id: { type: DataTypes.UUID, primaryKey: true },
        recordId: { type: DataTypes.UUID, allowNull: false },
        versionNumber: { type: DataTypes.INTEGER, allowNull: false },
        state: { type: DataTypes.ENUM('draft', 'in_review', 'committed', 'superseded'), allowNull: false },
        // draft edits: an edit made on an older revision is refused (optimistic concurrency)
        revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        schemaVersion: { type: DataTypes.STRING, allowNull: false },
        data: { type: DataTypes.JSONB, allowNull: false },
        // computed from the documents: suggestions, chain of title (README.md section 3)
        derived: { type: DataTypes.JSONB },
        checks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        // against the version that was current when this one was opened
        changes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        reviewComment: { type: DataTypes.TEXT },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        createdById: s(), createdByName: s(),
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        submittedAt: d(), submittedById: s(), submittedByName: s(),
        approvedById: s(), approvedByName: s(),
        committedAt: d(),
        seal: { type: DataTypes.STRING(64) },
        previousSeal: { type: DataTypes.STRING(64) }
    }, opts({ indexes: [{ unique: true, fields: ['recordId', 'versionNumber'] }, { fields: ['state'] }] }));

    // Gap-free record number sequence per year.
    const Counter = sequelize.define('counter', {
        year: { type: DataTypes.INTEGER, primaryKey: true },
        last: { type: DataTypes.INTEGER, allowNull: false }
    }, opts());

    return { Record, Version, Counter };
}
