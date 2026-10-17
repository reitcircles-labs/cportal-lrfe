import {DataTypes, Op} from 'sequelize';
import {inTransaction} from './db.js';

/**
 * Transactional outbox (API-613): a service writes each event to its own `outbox` table in the
 * same database transaction as the change that caused it; the event bus's relay then publishes
 * unsent rows to the JetStream stream and marks them sent. A committed change therefore always
 * produces its event (also after a NATS outage or a restart), and a rolled-back change never does.
 *
 * Both stores have the same interface:
 *   sync()             create the table (with DB_SYNC)
 *   add(event)         store an event; in PostgreSQL it joins the current transaction
 *   unsent(limit)      the oldest events not yet published
 *   markSent(ids)      mark events as published
 *   atomic(fn)         run fn in one transaction (memory: just run it)
 */
export function createSequelizeOutbox(sequelize, schema) {
  const Outbox = sequelize.define(
    'outbox',
    {
      seq: {type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true},
      id: {type: DataTypes.UUID, allowNull: false, unique: true},
      type: {type: DataTypes.STRING, allowNull: false},
      event: {type: DataTypes.JSONB, allowNull: false},
      createdAt: {type: DataTypes.DATE, allowNull: false},
      sentAt: {type: DataTypes.DATE},
    },
    {
      schema,
      freezeTableName: true,
      timestamps: false,
      indexes: [{fields: ['sentAt']}],
    },
  );

  return {
    kind: 'sequelize',
    async sync() {
      await Outbox.sync();
    },
    async add(event) {
      await Outbox.create({
        id: event.id,
        type: event.type,
        event,
        createdAt: new Date(event.time),
      });
    },
    async unsent(limit = 100) {
      const rows = await Outbox.findAll({
        where: {sentAt: null},
        order: [['seq', 'ASC']],
        limit,
      });
      return rows.map(r => r.event);
    },
    async markSent(ids) {
      if (ids.length) {
        await Outbox.update(
          {sentAt: new Date()},
          {where: {id: {[Op.in]: ids}}},
        );
      }
    },
    atomic: fn => inTransaction(sequelize, fn),
  };
}

/** The same interface in memory: for tests (a "restart" is a new bus over the same store). */
export function createMemoryOutbox() {
  const rows = [];
  return {
    kind: 'memory',
    rows,
    async sync() {},
    async add(event) {
      rows.push({event, sentAt: null});
    },
    async unsent(limit = 100) {
      return rows
        .filter(r => !r.sentAt)
        .slice(0, limit)
        .map(r => r.event);
    },
    async markSent(ids) {
      for (const r of rows) if (ids.includes(r.event.id)) r.sentAt = new Date();
    },
    atomic: fn => fn(),
  };
}
