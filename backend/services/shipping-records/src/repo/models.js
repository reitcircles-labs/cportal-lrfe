import {DataTypes} from 'sequelize';

/** The PostgreSQL schema of shipping-records. */
export const SCHEMA = 'shipping_records';

/**
 * Sequelize models for the `shipping_records` schema (README.md). Every attribute gets its own
 * definition object (Sequelize writes the column name into it).
 * @param {import('sequelize').Sequelize} sequelize
 * @return {{Record: object, Version: object, Title: object}}
 */
export function defineModels(sequelize) {
  /**
   * A table's options in this schema.
   * @param {object} [extra] more options, e.g. indexes
   * @return {object}
   */
  const tableOptions = (extra = {}) => ({
    schema: SCHEMA,
    freezeTableName: true,
    timestamps: false,
    ...extra,
  });
  /**
   * A text column that may be empty.
   * @return {{type: object}}
   */
  const text = () => ({type: DataTypes.STRING});
  /**
   * A date column that may be empty.
   * @return {{type: object}}
   */
  const date = () => ({type: DataTypes.DATE});

  // One per B/L of an organisation: a carrier's transport document reference.
  const Record = sequelize.define(
    'bill_of_lading',
    {
      id: {type: DataTypes.UUID, primaryKey: true},
      // the document's transportDocumentReference
      recordNo: {type: DataTypes.STRING, allowNull: false},
      carrierCode: {type: DataTypes.STRING, allowNull: false},
      label: {type: DataTypes.STRING, allowNull: false},
      // the owner: the organisation of the user who created it (CB-18)
      organisationId: {type: DataTypes.STRING, allowNull: false},
      // draft = never committed; committed = has a current version (a change may be in progress)
      status: {type: DataTypes.ENUM('draft', 'committed'), allowNull: false},
      currentVersion: {type: DataTypes.INTEGER},
      draftVersion: {type: DataTypes.INTEGER},
      draftState: {type: DataTypes.ENUM('draft', 'in_review')}, // state of the open draft, for lists
      createdAt: {type: DataTypes.DATE, allowNull: false},
      createdById: text(),
      createdByName: text(),
      updatedAt: {type: DataTypes.DATE, allowNull: false},
    },
    tableOptions({
      indexes: [
        // A reference is unique per organisation, not on the platform: drafts are private, so a
        // second organisation's draft with the same reference must never be refused (that would
        // reveal the first). One issued B/L per carrier reference on the platform is a rule of
        // issuing (L3/L4), not of drafts.
        {unique: true, fields: ['organisationId', 'carrierCode', 'recordNo']},
        {fields: ['organisationId', 'createdAt']},
      ],
    }),
  );

  // One row per version. Committed versions are never changed again.
  const Version = sequelize.define(
    'bl_version',
    {
      id: {type: DataTypes.UUID, primaryKey: true},
      recordId: {type: DataTypes.UUID, allowNull: false},
      versionNumber: {type: DataTypes.INTEGER, allowNull: false},
      state: {
        type: DataTypes.ENUM('draft', 'in_review', 'committed'),
        allowNull: false,
      },
      // each change of the version adds one: a change made on an older revision is refused (409)
      revision: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1},
      // the B/L: {schemaVersion, document, partyOrganisations?}
      data: {type: DataTypes.JSONB, allowNull: false},
      // billOfLadingHash(data): the B/L's canonical SHA-256
      documentHash: {type: DataTypes.STRING(64), allowNull: false},
      // [{at, byId, byName, action, via?, comment?}]
      changes: {type: DataTypes.JSONB, allowNull: false, defaultValue: []},
      reviewComment: {type: DataTypes.TEXT},
      createdAt: {type: DataTypes.DATE, allowNull: false},
      createdById: text(),
      createdByName: text(),
      updatedAt: {type: DataTypes.DATE, allowNull: false},
      submittedAt: date(),
      submittedById: text(),
      submittedByName: text(),
      approvedById: text(),
      approvedByName: text(),
      committedAt: date(),
      seal: {type: DataTypes.STRING(64)},
      previousSeal: {type: DataTypes.STRING(64)},
    },
    tableOptions({
      indexes: [
        {unique: true, fields: ['recordId', 'versionNumber']},
        {fields: ['state']},
      ],
    }),
  );

  // The title of an issued B/L (CB-31, the holder ledger): one row per B/L, its primary key the
  // record's id, so a second title of the same B/L is refused by the database. Changed only by the
  // title engine (TitleService), each change adding one to its revision.
  const Title = sequelize.define(
    'bl_title',
    {
      recordId: {
        type: DataTypes.UUID,
        primaryKey: true,
        references: {model: Record, key: 'id'},
      },
      // negotiable, straight or waybill (@lrfe/domain-shipping/title)
      kind: {type: DataTypes.STRING, allowNull: false},
      state: {type: DataTypes.STRING, allowNull: false},
      // organisation ids: the issuer, the holder (negotiable only), the consignee (the other kinds)
      carrier: {type: DataTypes.STRING, allowNull: false},
      holder: text(),
      // none, named or blank
      endorsement: {type: DataTypes.STRING, allowNull: false},
      consignee: text(),
      // while the carrier holds the B/L for an amendment, the holder it goes back to
      returnTo: text(),
      // the committed version issued, and its billOfLadingHash
      issuedVersion: {type: DataTypes.INTEGER, allowNull: false},
      documentHash: {type: DataTypes.STRING(64), allowNull: false},
      // each change adds one: a change made on an older revision is refused (409)
      revision: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1},
      createdAt: {type: DataTypes.DATE, allowNull: false},
      updatedAt: {type: DataTypes.DATE, allowNull: false},
    },
    tableOptions(),
  );

  return {Record, Version, Title};
}
