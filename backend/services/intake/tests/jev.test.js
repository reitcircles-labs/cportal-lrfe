import { expect } from 'chai';
import { createJevClient, createFakeJev, JevError, noul, choice, score } from '../src/extraction/jev.js';
import { jevFromEnv } from '../src/setup.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status, text = '') => ({ ok: false, status, json: async () => { throw new Error('no json'); }, text: async () => text });
const ANSWER = { model: 'jev-1.13.0', answers: { wrongParty: { type: 'noul', noul: 0.86 } }, usage: { input_tokens: 296, output_tokens: 3 } };
const QUESTIONS = { wrongParty: noul('Does `field.value` describe a different party than `field.label` asks for?', { true: 'Another party', false: 'The party asked for' }) };

/** A fetch that answers from `replies` in order and records each request. */
function fakeFetch(...replies) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const r = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(init) : r;
    };
    fn.calls = calls;
    return fn;
}
const noSleep = async () => {};

describe('Jev client', () => {
    it('sends model, state and questions with the key, and maps the answer', async () => {
        const fetch = fakeFetch(ok(ANSWER));
        const jev = createJevClient({ apiKey: 'k-123', fetch, sleep: noSleep });
        const r = await jev.ask({ state: { page: 'text' }, questions: QUESTIONS });
        expect(fetch.calls[0].url).to.equal('https://api.typesafe.ai/v1/systemone');
        expect(fetch.calls[0].init.method).to.equal('POST');
        expect(fetch.calls[0].init.headers.Authorization).to.equal('Bearer k-123');
        expect(fetch.calls[0].body).to.deep.equal({ model: 'jev-latest', state: { page: 'text' }, questions: QUESTIONS });
        expect(r.answers.wrongParty.noul).to.equal(0.86);
        expect(r.usage).to.deep.equal({ inputTokens: 296, outputTokens: 3 });
        expect(r.model).to.equal('jev-1.13.0');
        expect(r.durationMs).to.be.a('number');
    });

    it('builds the three question types in the API shape', () => {
        expect(noul('Q?')).to.deep.equal({ type: 'noul', instructions: 'Q?' });
        expect(choice('Which?', { a: 'A', b: null })).to.deep.equal({ type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: null } });
        expect(score('How?', ['low', 'high'])).to.deep.equal({ type: 'score', instructions: 'How?', criteria: ['low', 'high'] });
    });

    it('retries when Jev is overloaded or rate-limited, with backoff', async () => {
        const waits = [];
        const fetch = fakeFetch(fail(529), fail(429), ok(ANSWER));
        const jev = createJevClient({ apiKey: 'k', fetch, sleep: async (ms) => { waits.push(ms); }, backoffMs: 100 });
        const r = await jev.ask({ state: 's', questions: QUESTIONS });
        expect(fetch.calls).to.have.length(3);
        expect(waits).to.deep.equal([100, 400]);
        expect(r.answers.wrongParty.noul).to.equal(0.86);
    });

    it('does not retry a rejected request (422) or a bad key (401)', async () => {
        for (const status of [422, 401]) {
            const fetch = fakeFetch(fail(status, '{"detail":"criteria missing"}'));
            const jev = createJevClient({ apiKey: 'k', fetch, sleep: noSleep });
            const err = await jev.ask({ state: 's', questions: QUESTIONS }).catch(e => e);
            expect(err).to.be.instanceOf(JevError);
            expect(err.status).to.equal(status);
            expect(err.retryable).to.equal(false);
            expect(err.message).to.contain(String(status));
            expect(fetch.calls).to.have.length(1);
        }
    });

    it('gives up after the retries with the last error', async () => {
        const fetch = fakeFetch(fail(503));
        const jev = createJevClient({ apiKey: 'k', fetch, sleep: noSleep, retries: 2 });
        const err = await jev.ask({ state: 's', questions: QUESTIONS }).catch(e => e);
        expect(err).to.be.instanceOf(JevError);
        expect(err.retryable).to.equal(true);
        expect(fetch.calls).to.have.length(3);
    });

    it('times out a call that does not answer', async () => {
        const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
        const jev = createJevClient({ apiKey: 'k', fetch: fakeFetch(hang), sleep: noSleep, timeoutMs: 20, retries: 0 });
        const err = await jev.ask({ state: 's', questions: QUESTIONS }).catch(e => e);
        expect(err).to.be.instanceOf(JevError);
        expect(err.message).to.contain('did not answer within 20 ms');
    });

    it('reports a network failure as retryable', async () => {
        const jev = createJevClient({ apiKey: 'k', fetch: fakeFetch(new TypeError('fetch failed')), sleep: noSleep, retries: 0 });
        const err = await jev.ask({ state: 's', questions: QUESTIONS }).catch(e => e);
        expect(err.message).to.contain('Jev unreachable: fetch failed');
        expect(err.retryable).to.equal(true);
    });

    it('refuses an answer without answers, and a request without questions', async () => {
        const jev = createJevClient({ apiKey: 'k', fetch: fakeFetch(ok({ model: 'x' })), sleep: noSleep });
        expect((await jev.ask({ state: 's', questions: QUESTIONS }).catch(e => e)).message).to.contain('no answers');
        expect((await jev.ask({ state: 's', questions: {} }).catch(e => e)).message).to.contain('No questions');
    });

    it('needs a key', () => {
        expect(() => createJevClient({})).to.throw('TYPESAFE_API_KEY');
    });
});

describe('fake Jev', () => {
    it('answers every question with a default, or as told', async () => {
        const jev = createFakeJev({ respond: ({ state }) => (state.field === 'marital' ? { wrongParty: 0.9 } : {}) });
        const questions = { ...QUESTIONS, kind: choice('Which kind?', { deed: null, other: null }), level: score('How clear?', ['poor', 'good']) };
        const a = await jev.ask({ state: { field: 'marital' }, questions });
        expect(a.answers.wrongParty.noul).to.equal(0.9);
        expect(a.answers.kind).to.include({ choice: 'deed', confidence: 1 });
        expect(a.answers.level.score).to.equal(0);
        const b = await jev.ask({ state: { field: 'tee1' }, questions: QUESTIONS });
        expect(b.answers.wrongParty.noul).to.equal(0.02);
        expect(jev.calls).to.have.length(2);
        expect(b.usage.inputTokens).to.be.greaterThan(0);
    });
});

describe('Jev settings', () => {
    const KEYS = ['JEV_ENABLED', 'JEV_PROVIDER', 'TYPESAFE_API_KEY', 'JEV_MODEL', 'JEV_FLAG_AT', 'JEV_ESCALATE_AT'];
    let saved;
    beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); KEYS.forEach(k => delete process.env[k]); });
    afterEach(() => KEYS.forEach(k => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));
    const quiet = { warn() {} };

    it('is off by default, with provisional thresholds', () => {
        const { jev, jevConfig } = jevFromEnv({ logger: quiet });
        expect(jev).to.equal(null);
        expect(jevConfig).to.deep.equal({ flagAt: 0.5, escalateAt: 0.7 });
    });

    it('stays off, with a warning, when enabled without a key', () => {
        process.env.JEV_ENABLED = 'true';
        const warnings = [];
        expect(jevFromEnv({ logger: { warn: (m) => warnings.push(m) } }).jev).to.equal(null);
        expect(warnings[0]).to.contain('TYPESAFE_API_KEY is not set');
    });

    it('uses TypeSafe with a key, or the fake on request', () => {
        process.env.JEV_ENABLED = 'true';
        process.env.TYPESAFE_API_KEY = 'k';
        process.env.JEV_MODEL = 'jev-preview';
        expect(jevFromEnv({ logger: quiet }).jev).to.include({ name: 'typesafe', model: 'jev-preview' });
        process.env.JEV_PROVIDER = 'fake';
        expect(jevFromEnv({ logger: quiet }).jev.name).to.equal('fake');
    });

    it('refuses a threshold that is not a probability', () => {
        process.env.JEV_FLAG_AT = '70';
        expect(() => jevFromEnv({ logger: quiet })).to.throw('JEV_FLAG_AT must be a probability');
    });
});
