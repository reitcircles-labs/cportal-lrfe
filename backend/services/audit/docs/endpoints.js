// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export default {
    title: 'audit',
    description: 'Audit: a tamper-evident trail with one hash-chained entry per domain event of every service. Proofs anchored on Cardano, sign-off and evidence packs follow. Design: services/audit/README.md.',
    tags: {
        Trail: 'The audit trail and its hash chain.',
        Service: 'Health and metadata.'
    },
    routes: {
        'GET /health': { tag: 'Service', summary: 'Health check', auth: 'public' },
        'GET /audit/trail': {
            tag: 'Trail', summary: 'Trail entries, oldest first',
            description: '`{ total, subjects, entries }`. Each entry has `seq`, `eventId`, `type`, `source`, `time`, `actor`, `subjects`, `data`, `prevHash`, `contentHash` and `hash`. `subject` is `record:<id>`, `document:<id>`, `edrmsNo:<number>`, `intake:<id>`, `process:<id>` or `user:<id>`. A land record or document also brings in the steps of what it is made of: its documents\' capture, filing and amendments, and its review processes. Other records\' steps are left out; `subjects` lists what was included. `type` is an event type, or a prefix ending in a dot (`intake.`). `from` and `to` are dates on the event\'s time (`to` is exclusive).'
        },
        'GET /audit/trail/verify': {
            tag: 'Trail', summary: 'Recompute the trail\'s hash chain',
            description: '`{ intact: true, entries, head: { seq, hash, time } }`, or `{ intact: false, entries, brokenAt, problem }`, where `problem` is `changed`, `missing`, `out of order` or `does not follow the entry before it`. `entries` is how many entries were checked before the break.'
        }
    }
};
