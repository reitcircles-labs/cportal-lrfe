import { DataTypes } from 'sequelize';

export const SCHEMA = 'intake';

/**
 * Sequelize models for the `intake` Postgres schema. Every attribute gets its own definition
 * object (Sequelize writes the column name into it; a shared object maps several attributes onto
 * one column — see tests/models.test.js).
 */
export function defineModels(sequelize) {
    const opts = (extra = {}) => ({ schema: SCHEMA, freezeTableName: true, timestamps: false, ...extra });
    const s = () => ({ type: DataTypes.STRING });
    const d = () => ({ type: DataTypes.DATE });
    const j = (dflt) => ({ type: DataTypes.JSONB, ...(dflt !== undefined ? { allowNull: false, defaultValue: dflt } : {}) });

    const Batch = sequelize.define('batch', {
        id: { type: DataTypes.STRING, primaryKey: true },
        registry: { type: DataTypes.STRING, allowNull: false },
        source: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
        createdById: s(), createdByName: s(),
        createdAt: { type: DataTypes.DATE, allowNull: false }
    }, opts());

    const Document = sequelize.define('document', {
        id: { type: DataTypes.UUID, primaryKey: true },
        batchId: { type: DataTypes.STRING, allowNull: false },
        status: { type: DataTypes.ENUM('queued', 'extracting', 'ready', 'failed', 'filed', 'rejected'), allowNull: false },
        fileKey: { type: DataTypes.STRING, allowNull: false },
        fileName: { type: DataTypes.STRING, allowNull: false },
        mimeType: { type: DataTypes.STRING, allowNull: false },
        size: { type: DataTypes.BIGINT, allowNull: false },
        sha256: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        capturedById: s(), capturedByName: s(),
        capturedAt: { type: DataTypes.DATE, allowNull: false },
        docType: s(), docTypeReason: { type: DataTypes.TEXT },
        languages: j([]), handwritingPresent: { type: DataTypes.BOOLEAN },
        pages: { type: DataTypes.INTEGER },
        fields: j([]), notes: j([]),
        latestExtractionId: { type: DataTypes.UUID },
        // the automatic cross-check of the latest reading: { provider, model, version, calls, at } (audit)
        crosscheck: j(),
        // encrypted scan (INTAKE_ENCRYPTION): algorithm, KEK name, wrapped data key, chunk size, ciphertext SHA-256 and size; never sent to clients
        encryption: j(),
        escalated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        extractionCostUsd: { type: DataTypes.DECIMAL(12, 6), allowNull: false, defaultValue: 0 },
        extractionError: { type: DataTypes.TEXT },
        claimedById: s(), claimedByName: s(), claimedAt: d(),
        filedDocumentId: { type: DataTypes.UUID }, edrmsNo: s(), filedAt: d(), filedById: s(), filedByName: s(),
        rejectedReason: { type: DataTypes.TEXT },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }
    }, opts({ indexes: [{ fields: ['batchId'] }, { fields: ['status'] }] }));

    // One row per model call: what was asked, what came back, what it cost.
    const Extraction = sequelize.define('extraction', {
        id: { type: DataTypes.UUID, primaryKey: true },
        documentId: { type: DataTypes.UUID, allowNull: false },
        role: { type: DataTypes.ENUM('primary', 'escalation', 'crosscheck'), allowNull: false },
        ok: { type: DataTypes.BOOLEAN, allowNull: false },
        provider: { type: DataTypes.STRING, allowNull: false },
        model: { type: DataTypes.STRING, allowNull: false },
        promptVersion: { type: DataTypes.STRING, allowNull: false },
        answer: j(), usage: j(),
        costUsd: { type: DataTypes.DECIMAL(12, 6) },
        durationMs: { type: DataTypes.INTEGER },
        error: { type: DataTypes.TEXT },
        createdAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['documentId'] }, { fields: ['createdAt'] }] }));

    const Job = sequelize.define('job', {
        id: { type: DataTypes.UUID, primaryKey: true },
        documentId: { type: DataTypes.UUID, allowNull: false },
        type: { type: DataTypes.STRING, allowNull: false },
        options: j({}),
        status: { type: DataTypes.ENUM('queued', 'running', 'done', 'failed', 'cancelled'), allowNull: false },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
        runAfter: { type: DataTypes.DATE, allowNull: false },
        lockedBy: s(), lockedAt: d(),
        lastError: { type: DataTypes.TEXT },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['status', 'runAfter'] }, { fields: ['documentId'] }] }));

    // Append-only history: capture, extraction, every field accept/edit, claim, filing, rejection.
    const Event = sequelize.define('event', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        documentId: { type: DataTypes.UUID, allowNull: false },
        action: { type: DataTypes.STRING, allowNull: false },
        k: s(),
        from: { type: DataTypes.TEXT }, to: { type: DataTypes.TEXT }, detail: { type: DataTypes.TEXT },
        byId: s(), byName: s(),
        at: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['documentId'] }] }));

    const Counter = sequelize.define('counter', {
        key: { type: DataTypes.STRING, primaryKey: true },
        last: { type: DataTypes.INTEGER, allowNull: false }
    }, opts());

    return { Batch, Document, Extraction, Job, Event, Counter };
}
