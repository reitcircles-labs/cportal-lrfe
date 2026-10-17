import {expect} from 'chai';
import {setUpDatabase, waitForDatabase} from '../src/index.js';

/** Stand-in for a Sequelize instance: fails `failures` connection attempts, records what is done. */
function fakeDb(
  steps,
  {failures = 0, failureCode = 'ECONNREFUSED', schemaExists = false} = {},
) {
  let attempts = 0;
  return {
    async authenticate() {
      attempts++;
      if (attempts <= failures) {
        throw Object.assign(new Error('connect ECONNREFUSED'), {
          original: {code: failureCode},
        });
      }
      steps.push('connected');
    },
    async query(sql) {
      if (sql.startsWith('SELECT')) return [schemaExists ? [{}] : []];
      steps.push(sql);
      return [[]];
    },
    define: name => ({
      sync: async () => {
        steps.push(`sync ${name}`);
      },
    }),
    async close() {
      steps.push('closed');
    },
    get attempts() {
      return attempts;
    },
  };
}

const service = (name, steps, options = {}) => ({
  name,
  schema: name,
  createRepo: () => ({
    sync: async () => {
      if (options.fail) throw new Error('boom');
      steps.push(`sync ${name} tables`);
    },
  }),
});

describe('waitForDatabase', () => {
  it('retries until the database answers', async () => {
    const db = fakeDb([], {failures: 2});
    const retries = [];
    await waitForDatabase(db, {
      intervalMs: 1,
      onRetry: err => retries.push(err.message),
    });
    expect(db.attempts).to.equal(3);
    expect(retries).to.deep.equal([
      'connect ECONNREFUSED',
      'connect ECONNREFUSED',
    ]);
  });

  it('gives up after the time limit with the last error', async () => {
    const db = fakeDb([], {failures: Infinity});
    try {
      await waitForDatabase(db, {timeoutMs: 20, intervalMs: 5});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).to.equal(
        'Database connection failed: connect ECONNREFUSED',
      );
    }
  });

  it('fails at once on a wrong password or database name: waiting cannot fix those', async () => {
    for (const code of ['28P01', '28000', '3D000']) {
      const db = fakeDb([], {failures: Infinity, failureCode: code});
      try {
        await waitForDatabase(db, {intervalMs: 1});
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.message).to.match(/^Database connection failed/);
      }
      expect(db.attempts).to.equal(1);
    }
  });
});

describe('setUpDatabase', () => {
  it('waits for the database, then sets up each service in turn: schema, tables, outbox, on its own connection', async () => {
    const steps = [];
    await setUpDatabase([service('identity', steps), service('edrms', steps)], {
      connect: () => fakeDb(steps),
    });
    expect(steps).to.deep.equal([
      'connected',
      'closed',
      'CREATE SCHEMA "identity"',
      'sync identity tables',
      'sync outbox',
      'closed',
      'CREATE SCHEMA "edrms"',
      'sync edrms tables',
      'sync outbox',
      'closed',
    ]);
  });

  it('leaves an existing schema alone (a second run, or one a DBA created)', async () => {
    const steps = [];
    await setUpDatabase([service('bpm', steps)], {
      connect: () => fakeDb(steps, {schemaExists: true}),
    });
    expect(steps).to.deep.equal([
      'connected',
      'closed',
      'sync bpm tables',
      'sync outbox',
      'closed',
    ]);
  });

  it('logs a retry once while its message stays the same', async () => {
    const steps = [];
    const logged = [];
    await setUpDatabase([service('audit', steps)], {
      connect: () => fakeDb(steps, {failures: 3}),
      wait: {intervalMs: 1},
      log: m => logged.push(m),
    });
    expect(logged).to.deep.equal([
      'waiting for the database: connect ECONNREFUSED',
      'audit: schema "audit" ready',
    ]);
  });

  it('a database that does not answer fails before any service, without naming one', async () => {
    const steps = [];
    try {
      await setUpDatabase([service('identity', steps)], {
        connect: () => fakeDb(steps, {failures: Infinity}),
        wait: {timeoutMs: 10, intervalMs: 5},
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).to.equal(
        'Database connection failed: connect ECONNREFUSED',
      );
    }
    expect(steps).to.deep.equal(['closed']);
  });

  it('stops at the first failure, naming the service, and closes its connection', async () => {
    const steps = [];
    try {
      await setUpDatabase(
        [service('intake', steps, {fail: true}), service('audit', steps)],
        {connect: () => fakeDb(steps)},
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).to.equal('intake: boom');
    }
    expect(steps).to.deep.equal([
      'connected',
      'closed',
      'CREATE SCHEMA "intake"',
      'closed',
    ]);
  });
});
