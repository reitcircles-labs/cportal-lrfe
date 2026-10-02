import { DataTypes } from 'sequelize';

export const SCHEMA = 'edrms';

/** Sequelize models for the `edrms` Postgres schema. */
export function defineModels(sequelize) {
    const opts = (extra = {}) => ({ schema: SCHEMA, freezeTableName: true, ...extra });

    const Document = sequelize.define('document', {
        id: { type: DataTypes.UUID, primaryKey: true },
        edrmsNo: { type: DataTypes.STRING, allowNull: false, unique: true },
        docType: { type: DataTypes.STRING, allowNull: false },
        title: { type: DataTypes.STRING, allowNull: false },
        instrumentRef: { type: DataTypes.STRING, unique: true },
        registry: { type: DataTypes.STRING, allowNull: false },
        batchId: { type: DataTypes.STRING },
        sourceId: { type: DataTypes.STRING, unique: true },
        pages: { type: DataTypes.INTEGER, allowNull: false },
        fields: { type: DataTypes.JSONB, allowNull: false },
        // fields flattened to { key: value } for filtering (props @> {...}); GIN-indexed
        props: { type: DataTypes.JSONB, allowNull: false },
        recordMetadata: { type: DataTypes.JSONB, allowNull: false },
        currentVersion: { type: DataTypes.INTEGER, allowNull: false },
        filedAt: { type: DataTypes.DATE, allowNull: false },
        filedById: { type: DataTypes.STRING },
        filedByName: { type: DataTypes.STRING },
        updatedAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({
        timestamps: false,
        indexes: [{ fields: ['docType'] }, { fields: ['batchId'] }, { fields: ['props'], using: 'gin' }]
    }));

    // One immutable row per version. Never updated after insert.
    const Version = sequelize.define('document_version', {
        id: { type: DataTypes.UUID, primaryKey: true },
        documentId: { type: DataTypes.UUID, allowNull: false },
        versionNumber: { type: DataTypes.INTEGER, allowNull: false },
        label: { type: DataTypes.STRING, allowNull: false },
        kind: { type: DataTypes.ENUM('filed', 'amendment'), allowNull: false },
        reason: { type: DataTypes.TEXT },
        changes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        fields: { type: DataTypes.JSONB, allowNull: false },
        recordMetadata: { type: DataTypes.JSONB, allowNull: false },
        storageKey: { type: DataTypes.STRING, allowNull: false },
        fileName: { type: DataTypes.STRING, allowNull: false },
        mimeType: { type: DataTypes.STRING, allowNull: false },
        size: { type: DataTypes.BIGINT, allowNull: false },
        sha256: { type: DataTypes.STRING(64), allowNull: false },
        seal: { type: DataTypes.STRING(64), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        createdById: { type: DataTypes.STRING },
        createdByName: { type: DataTypes.STRING },
        // Amendments: the second person who approved the change (four-eyes, via bpm). Sealed.
        approvedById: { type: DataTypes.STRING },
        approvedByName: { type: DataTypes.STRING },
        // Filing only: how the values were produced (intake extraction: model, prompt version,
        // extracted vs corrected fields). Sealed with the version.
        provenance: { type: DataTypes.JSONB }
    }, opts({
        timestamps: false,
        indexes: [{ unique: true, fields: ['documentId', 'versionNumber'] }]
    }));

    // Gap-free EDRMS number sequence per year.
    const Counter = sequelize.define('counter', {
        year: { type: DataTypes.INTEGER, primaryKey: true },
        last: { type: DataTypes.INTEGER, allowNull: false }
    }, opts({ timestamps: false }));

    return { Document, Version, Counter };
}
