import {DataTypes} from 'sequelize';

/** The PostgreSQL schema of shipping-records. */
export const SCHEMA = 'shipping_records';

/**
 * Sequelize models for the `shipping_records` schema (README.md). Every attribute gets its own
 * definition object (Sequelize writes the column name into it).
 * @param {import('sequelize').Sequelize} sequelize
 * @return {{Record: object, Version: object, Title: object, TitleEntry: object}}
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
      // draft = never committed; committed = has a current version; archived = discarded draft (CB-71)
      status: {
        type: DataTypes.ENUM('draft', 'committed', 'archived'),
        allowNull: false,
      },
      currentVersion: {type: DataTypes.INTEGER},
      draftVersion: {type: DataTypes.INTEGER},
      draftState: {type: DataTypes.ENUM('draft', 'in_review')}, // state of the open draft, for lists
      createdAt: {type: DataTypes.DATE, allowNull: false},
      createdById: text(),
      createdByName: text(),
      updatedAt: {type: DataTypes.DATE, allowNull: false},
    },
    tableOptions({
      indexes: [{fields: ['organisationId', 'createdAt']}],
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
      // cross-platform transfer metadata (CB-55)
      externalPlatform: text(),
      externalParty: text(),
      previousState: text(),
      previousEndorsement: text(),
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

  // The chain of title of a B/L (CB-32, docs/chain-of-title.md of the shipping pack): one entry
  // per command applied to its title, written in the same transaction as the title. Entries are
  // never changed: each holds the hash of the one before and the platform's signature (JWS).
  // Its primary key (recordId, seq) refuses a second entry with the same number.
  const TitleEntry = sequelize.define(
    'bl_title_entry',
    {
      recordId: {
        type: DataTypes.UUID,
        primaryKey: true,
        references: {model: Record, key: 'id'},
      },
      // 1, 2, ... per B/L
      seq: {type: DataTypes.INTEGER, primaryKey: true},
      command: {type: DataTypes.STRING, allowNull: false},
      // the person who ran the command: {id, name, org}
      actor: {type: DataTypes.JSONB, allowNull: false},
      // the holder before and after the command (organisation ids)
      from: text(),
      to: text(),
      endorsement: {type: DataTypes.STRING, allowNull: false},
      // the billOfLadingHash of the issued version
      documentHash: {type: DataTypes.STRING(64), allowNull: false},
      at: {type: DataTypes.DATE, allowNull: false},
      // the entryHash of the entry before; null for a B/L's first entry
      previousHash: {type: DataTypes.STRING(64)},
      // SHA-256 of the canonical JSON of the entry without entryHash and signature
      entryHash: {type: DataTypes.STRING(64), allowNull: false},
      // the platform's key that signed it, and its compact JWS over the same content
      kid: {type: DataTypes.STRING, allowNull: false},
      signature: {type: DataTypes.TEXT, allowNull: false},
      // Verbatim signed entry from a peer platform (CB-55), preserving its original recordId/hash
      rawEntry: {type: DataTypes.JSONB},
    },
    tableOptions(),
  );

  // Connected eBL platforms directory (CB-55, DCSA PINT).
  const Platform = sequelize.define(
    'bl_platform',
    {
      code: {type: DataTypes.STRING(50), primaryKey: true},
      name: {type: DataTypes.STRING, allowNull: false},
      baseUrl: {type: DataTypes.STRING, allowNull: false},
      jwks: {type: DataTypes.JSONB, allowNull: false},
      agreementDate: {type: DataTypes.STRING},
      status: {
        type: DataTypes.ENUM('Active', 'Suspended'),
        allowNull: false,
        defaultValue: 'Active',
      },
      createdAt: {type: DataTypes.DATE, allowNull: false},
      updatedAt: {type: DataTypes.DATE, allowNull: false},
    },
    tableOptions(),
  );

  // Outgoing and incoming DCSA PINT transfer envelopes (CB-55).
  const PintTransfer = sequelize.define(
    'bl_pint_transfer',
    {
      id: {type: DataTypes.UUID, primaryKey: true},
      recordId: {type: DataTypes.UUID, allowNull: false},
      direction: {type: DataTypes.ENUM('out', 'in'), allowNull: false},
      envelopeId: {type: DataTypes.UUID, allowNull: false, unique: true},
      platformCode: {type: DataTypes.STRING(50), allowNull: false},
      partyCode: {type: DataTypes.STRING, allowNull: false},
      status: {
        type: DataTypes.ENUM('pending', 'accepted', 'refused'),
        allowNull: false,
      },
      responseCode: text(),
      envelope: {type: DataTypes.JSONB, allowNull: false},
      attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1},
      createdAt: {type: DataTypes.DATE, allowNull: false},
      updatedAt: {type: DataTypes.DATE, allowNull: false},
    },
    tableOptions({indexes: [{fields: ['recordId']}]}),
  );

  return {Record, Version, Title, TitleEntry, Platform, PintTransfer};
}
