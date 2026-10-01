import { expect } from 'chai';
import { envOneOf, ensureSchema } from '../src/index.js';

describe('envOneOf', () => {
    afterEach(() => { delete process.env.TEST_STORE; });

    it('returns an allowed value or the fallback', () => {
        expect(envOneOf('TEST_STORE', ['postgres', 'memory'], 'postgres')).to.equal('postgres');
        process.env.TEST_STORE = 'memory';
        expect(envOneOf('TEST_STORE', ['postgres', 'memory'], 'postgres')).to.equal('memory');
    });

    it('rejects anything else, hinting when a URL was put in the wrong variable (without echoing it)', () => {
        process.env.TEST_STORE = 'postgres://user:hunter2@db/x';
        const err = (() => { try { envOneOf('TEST_STORE', ['postgres', 'memory']); } catch (e) { return e; } })();
        expect(err.message).to.include('did you mean DB_CONNECTION_STRING').and.not.include('hunter2');
        process.env.TEST_STORE = 'mysql';
        expect(() => envOneOf('TEST_STORE', ['postgres', 'memory'])).to.throw(/"mysql"/);
    });
});

describe('ensureSchema', () => {
    /** Minimal stand-in for a Sequelize instance: records SQL, answers the existence check. */
    function fakeDb({ exists, canCreate = true }) {
        const sql = [];
        return {
            sql,
            async query(q) {
                sql.push(q.split(' ').slice(0, 3).join(' '));
                if (q.startsWith('SELECT')) return [exists ? [{ '?column?': 1 }] : []];
                if (!canCreate) throw Object.assign(new Error('permission denied for database'), { original: { code: '42501' } });
                return [[]];
            }
        };
    }

    it('does not try to create a schema that already exists (works without CREATE privilege)', async () => {
        const db = fakeDb({ exists: true, canCreate: false });
        await ensureSchema(db, 'edrms');
        expect(db.sql).to.deep.equal(['SELECT 1 FROM']);
    });

    it('creates a missing schema', async () => {
        const db = fakeDb({ exists: false });
        await ensureSchema(db, 'edrms');
        expect(db.sql).to.deep.equal(['SELECT 1 FROM', 'CREATE SCHEMA "edrms"']);
    });

    it('explains what the DBA must run when it may not create it', async () => {
        const db = fakeDb({ exists: false, canCreate: false });
        try {
            await ensureSchema(db, 'bpm');
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.message).to.include('CREATE SCHEMA bpm AUTHORIZATION');
        }
    });

    it('refuses unsafe schema names', async () => {
        try {
            await ensureSchema(fakeDb({ exists: false }), 'x"; drop table y; --');
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.message).to.include('Invalid schema name');
        }
    });
});
