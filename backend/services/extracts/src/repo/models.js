import {DataTypes} from 'sequelize';

export const SCHEMA = 'extracts';

/**
 * Sequelize models for the `extracts` Postgres schema (README.md). Every attribute gets its own
 * definition object (Sequelize writes the column name into it).
 */
export function defineModels(sequelize) {
  const s = () => ({type: DataTypes.STRING});

  // The register: one row per extract issued. A row is never deleted; a revoked extract stays.
  const Extract = sequelize.define(
    'extract',
    {
      id: {type: DataTypes.UUID, primaryKey: true},
      // EX-<country>-<year>-<nnnnnn>, printed on the extract (API-692); from the yearly counter
      extractNo: {type: DataTypes.STRING},
      // 12 characters for typing in on the check page, printed on the extract next to the QR code
      checkCode: {type: DataTypes.STRING(12)},
      recordId: {type: DataTypes.UUID, allowNull: false},
      recordNo: {type: DataTypes.STRING, allowNull: false},
      // the land record's committed version the extract shows
      versionNumber: {type: DataTypes.INTEGER, allowNull: false},
      issuedById: {type: DataTypes.STRING, allowNull: false},
      issuedByName: s(),
      // the owner it was issued for: their place among the version's owners and their name; of
      // their ID number (checked against the identity document shown) only the last four characters
      ownerIndex: {type: DataTypes.INTEGER, allowNull: false},
      ownerName: {type: DataTypes.STRING, allowNull: false},
      ownerIdLast4: {type: DataTypes.STRING(4), allowNull: false},
      // the staff member confirmed seeing the owner's identity document
      documentSeen: {type: DataTypes.BOOLEAN, allowNull: false},
      issuedAt: {type: DataTypes.DATE, allowNull: false},
      // random and unguessable: the public check of an extract (its QR code) finds it by this
      token: {type: DataTypes.STRING, allowNull: false, unique: true},
      status: {type: DataTypes.ENUM('valid', 'revoked'), allowNull: false},
      revokedAt: {type: DataTypes.DATE},
      revokedById: s(),
      revokedByName: s(),
      revokeReason: {type: DataTypes.TEXT},
      // the sealed PDF as issued: its SHA-256 (also in the issued event) and where it is stored
      pdfSha256: {type: DataTypes.STRING(64), allowNull: false},
      pdfKey: {type: DataTypes.STRING, allowNull: false},
      // how the stored PDF is encrypted, with its wrapped key; null when stored plain (API-780)
      pdfEncryption: {type: DataTypes.JSONB, allowNull: true},
    },
    {
      schema: SCHEMA,
      freezeTableName: true,
      timestamps: false,
      // the unique indexes on extractNo and checkCode are made in repo.sync() (fixed names)
      indexes: [{fields: ['recordId', 'issuedAt']}],
    },
  );

  // The last extract number used per year: a number is used only when its extract is saved.
  const Counter = sequelize.define(
    'counter',
    {
      year: {type: DataTypes.INTEGER, primaryKey: true},
      last: {type: DataTypes.INTEGER, allowNull: false},
    },
    {schema: SCHEMA, freezeTableName: true, timestamps: false},
  );

  return {Extract, Counter};
}
