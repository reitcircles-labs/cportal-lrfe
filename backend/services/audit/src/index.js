import { createEventBus, createSequelizeOutbox, createRevocationList, createSequelize, createServiceTokenSigner, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { TrailService } from './trail.service.js';
import { TreeService } from './tree.service.js';
import { cardanoFromEnv } from './cardano/adapter.js';
import { AnchorService, parsePeriod } from './anchor.service.js';
import { BackfillService, createSealSources } from './backfill.service.js';
import { createVerifySources, ProofService } from './proof.service.js';
import { createSignoffClients, SignoffService } from './signoff.service.js';
import { createEvidenceSources, EvidenceService } from './evidence.service.js';
import { AuditListService, createListSources } from './audit-list.service.js';
import { AnchoringsService, createCoverageSources } from './anchorings.service.js';
import { AnchorLookupService, createLookupSources } from './lookup.service.js';
import { TestAnchorings } from './test-anchorings.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';

const checks = [];
let repo, sequelize, outbox;

if (envOneOf('AUDIT_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
    // Dev only: lost on restart.
    repo = createMemoryRepo();
} else {
    sequelize = createSequelize();
    repo = createSequelizeRepo(sequelize);
    // sign-offs and findings are published in the transaction that stores them (API-613, API-659)
    outbox = createSequelizeOutbox(sequelize, SCHEMA);
    checks.push(() => healthCheck(sequelize));
    if (envBool('DB_SYNC', false)) {
        // Dev/UAT convenience only. Replace with real migrations before production.
        checks.push(async () => { await ensureSchema(sequelize, SCHEMA); await repo.sync(); await outbox.sync(); });
    }
}

const events = createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'audit', outbox });
const service = new TrailService({ repo });
// the app's logger, for what is made before the app (used only once it runs)
const log = { info: (...a) => app.log.info(...a), warn: (...a) => app.log.warn(...a), error: (...a) => app.log.error(...a) };
const tree = new TreeService({ repo, logger: log });
// anchoring on Cardano (README.md section 3), when CARDANO_PROVIDER is set; a wrong setting stops the start
const cardano = cardanoFromEnv(process.env, { logger: log, events });
const serviceToken = createServiceTokenSigner({ secret: env('JWT_SECRET'), service: 'audit' });
const recordsUrl = env('RECORDS_URL', 'http://localhost:3505');
const edrmsUrl = env('EDRMS_URL', 'http://localhost:3502');
// proofs and verification (README.md section 4): the owning services recompute the seals
const proofs = new ProofService({ repo, tree, cardano, logger: log, sources: createVerifySources({ recordsUrl, edrmsUrl, serviceToken }) });
// sign-off and findings (README.md section 5): versions read from land-records and edrms, checked
// against the blockchain (proofs), findings and re-review tasks sent to bpm
const signoffs = new SignoffService({ repo, events, proofs, logger: log, ...createSignoffClients({ recordsUrl, edrmsUrl, bpmUrl: env('BPM_URL', 'http://localhost:3503'), serviceToken }) });

// the evidence pack (README.md section 6): versions, documents and files read from land-records and edrms
const evidence = new EvidenceService({ trail: service, proofs, signoffs, events, cardano, logger: log, sources: createEvidenceSources({ recordsUrl, edrmsUrl, serviceToken }) });

// the land records list of the Audit screen (API-661)
const auditList = new AuditListService({ repo, proofs, sources: createListSources({ recordsUrl, serviceToken }) });

// the Anchorings screens (API-671): the job's settings, to say when the next batch is due
const anchoringConfig = { periodMs: parsePeriod(process.env.ANCHOR_PERIOD), retryMs: 5 * 60_000, confirmations: envInt('ANCHOR_CONFIRMATIONS', 10) };
const anchorings = new AnchoringsService({ repo, tree, anchoring: !!cardano, config: anchoringConfig, sources: createCoverageSources({ recordsUrl, serviceToken }) });
// "Is it on the blockchain?" (API-697)
const lookup = new AnchorLookupService({ repo, proofs, anchorings, sources: createLookupSources({ recordsUrl, edrmsUrl, serviceToken }) });

// made-up anchorings for the end-to-end tests only (API-698); never next to a real blockchain
let testAnchorings = null;
if (envBool('AUDIT_TEST_ANCHORINGS', false)) {
    if (process.env.NODE_ENV !== 'test' || cardano) throw new Error('AUDIT_TEST_ANCHORINGS needs NODE_ENV=test and no CARDANO_PROVIDER');
    testAnchorings = new TestAnchorings({ repo, tree });
}

const app = await buildApp({
    service,
    proofs,
    signoffs,
    evidence,
    auditList,
    anchorings,
    lookup,
    testAnchorings,
    jwtSecret: env('JWT_SECRET'),
    revocations: createRevocationList({ events }),
    logger: { level: env('LOG_LEVEL', 'info') }
});

await startService(app, { port: envInt('PORT', 3506), checks, onClose: async () => { await events.close(); await sequelize?.close(); } });

// every durable event of every service becomes one trail entry (README.md section 1), and a
// committed land record version or a filed document version also a leaf of the tree (section 2).
// Acknowledged once both are written, so an event published while the audit service is down is
// recorded when it is back; both steps skip what they already have. Started once the tables exist.
// A newer reviewed version also resolves the open findings on older ones (section 5).
events.consume('>', async (event) => {
    await service.record(event);
    await tree.fromEvent(event);
    await signoffs.onEvent(event);
}, { durable: 'audit-trail' });

// events the stream dropped while the audit service was down too long: at start and every hour
const checkGap = () => service.checkGap(events).catch(err => app.log.warn({ err: err.message }, 'audit: could not check the trail for gaps'));
setTimeout(checkGap, 15_000).unref();
setInterval(checkGap, 3_600_000).unref();

// the wallet at start: its address, and a warning when it is low (an outage is only logged);
// then the hourly anchoring (README.md section 3)
if (cardano) {
    const anchoring = new AnchorService({
        repo, tree, cardano, events, logger: app.log,
        config: anchoringConfig
    });
    // a new installation (decided once, at start): the seals from before the audit service go into the
    // tree before the first anchoring (README.md section 1). Retried every minute until it has gone
    // through both lists completely, also after a partial run; anchoring starts only then.
    const backfill = new BackfillService({
        trail: service, tree, logger: app.log,
        sources: createSealSources({ recordsUrl, edrmsUrl, serviceToken })
    });
    const startAnchoring = async () => {
        let empty;
        try { empty = (await tree.size()) === 0; } catch (err) {
            app.log.warn({ err: err.message }, 'audit: could not read the tree; anchoring starts in a minute');
            setTimeout(() => startAnchoring().catch(() => {}), 60_000).unref();
            return;
        }
        if (empty) {
            await backfill.untilDone({ onRetry: (err) => app.log.warn({ err: err.message }, 'audit: backfill of earlier seals not finished; anchoring waits, trying again in a minute') });
        }
        anchoring.start();
    };
    startAnchoring().catch(err => app.log.error({ err: err.message }, 'audit: anchoring could not start'));
    cardano.address()
        .then(async (address) => app.log.info({ network: cardano.network, provider: cardano.provider, address, ...(await cardano.balance()) }, 'audit: anchoring wallet'))
        .catch(err => app.log.warn({ err: err.message, code: err.code }, 'audit: the anchoring wallet could not be read yet'));
}
