import dns from 'node:dns';
import { createEventBus, createSequelize, createServiceTokenSigner, ensureSchema, env, envBool, envInt, envOneOf, healthCheck } from '@lrfe/common';
import { createEncryptingStore, createLocalStore, createMemoryStore, createS3Store, keyringFromEnv } from '@lrfe/storage';
import { IntakeService } from './intake.service.js';
import { createEdrmsClient } from './edrms-client.js';
import { createChecker } from './extraction/checks.js';
import { createGeminiProvider, createMockProvider } from './extraction/providers.js';
import { createFakeJev, createJevClient } from './extraction/jev.js';
import { ExtractionWorker } from './worker.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';

/** Build everything the intake service and the worker need, from the environment. */
export function setupFromEnv({ logger = console } = {}) {
    // An API key restricted to this host's IPv4 address is refused when Node happens to connect
    // over IPv6. NETWORK_PREFER_IPV4=true makes outgoing calls (Gemini, EDRMS) try IPv4 first.
    if (envBool('NETWORK_PREFER_IPV4', false)) dns.setDefaultResultOrder('ipv4first');
    const checks = [];
    let repo, sequelize;
    if (envOneOf('INTAKE_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
        repo = createMemoryRepo();
    } else {
        sequelize = createSequelize();
        repo = createSequelizeRepo(sequelize);
        checks.push(() => healthCheck(sequelize));
        if (envBool('DB_SYNC', false)) checks.push(async () => { await ensureSchema(sequelize, SCHEMA); await repo.sync(); });
    }

    const storage = envOneOf('INTAKE_STORAGE', ['s3', 'local', 'memory'], 'local');
    const plainStore = storage === 'memory' ? createMemoryStore()
        : storage === 'local' ? createLocalStore({ root: env('INTAKE_LOCAL_DIR', './tmp/intake-store') })
        : createS3Store({ bucket: env('AWS_BUCKET_NAME'), region: env('AWS_BUCKET_REGION'), accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY });
    // INTAKE_ENCRYPTION=bao (or fake): scans are encrypted under intake-files (packages/storage/README.md)
    const keyring = keyringFromEnv({ setting: 'INTAKE_ENCRYPTION', defaultKeyName: 'intake-files' });
    const store = keyring ? createEncryptingStore(plainStore, keyring) : plainStore;
    // With INTAKE_ENCRYPTION=bao, start only once the vault answers (waits up to a minute while it starts)
    if (keyring?.check) checks.push(() => keyring.check());

    const jwtSecret = env('JWT_SECRET');
    const edrms = createEdrmsClient({ baseUrl: env('EDRMS_URL', 'http://localhost:3502'), serviceToken: createServiceTokenSigner({ secret: jwtSecret, service: 'intake' }) });
    const checker = createChecker({ edrms });

    // Default: mock — nothing is sent to Google (and nothing is spent) unless explicitly configured.
    const providerKind = envOneOf('EXTRACTION_PROVIDER', ['gemini', 'mock'], 'mock');
    let primary, escalation = null;
    if (providerKind === 'gemini') {
        const common = {
            apiKey: process.env.GEMINI_API_KEY, vertex: envBool('GEMINI_VERTEX', false),
            project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION,
            transcribe: envBool('GEMINI_TRANSCRIBE', true),
            thinkingLevel: envOneOf('GEMINI_THINKING_LEVEL', ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], 'LOW'),
            mediaResolution: envOneOf('GEMINI_MEDIA_RESOLUTION', ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM')
        };
        primary = createGeminiProvider({ ...common, model: env('GEMINI_MODEL', 'gemini-3.1-flash-lite') });
        const esc = env('GEMINI_ESCALATION_MODEL', 'gemini-3.1-pro-preview');
        // The second reading only needs the fields: the first reading's transcription is kept.
        if (esc !== 'none') escalation = createGeminiProvider({ ...common, model: esc, transcribe: false });
    } else {
        primary = createMockProvider();
    }

    const { jev, jevConfig } = jevFromEnv({ logger });

    const service = new IntakeService({
        repo, store, edrms, checker,
        events: createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'intake', logger }),
        config: { registry: env('INTAKE_REGISTRY_CODE', 'WDH') }
    });
    const budget = env('EXTRACTION_MONTHLY_BUDGET_USD', '50');
    const worker = new ExtractionWorker({
        repo, service, store, primary, escalation, checker, logger, jev, jevConfig,
        monthlyBudgetUsd: budget === 'none' ? null : Number(budget),
        maxEscalationPages: envInt('EXTRACTION_ESCALATE_MAX_PAGES', 10)
    });
    logger.info?.({ provider: providerKind, model: primary.model, escalation: escalation?.model ?? null, jev: jev ? `${jev.name}:${jev.model}` : null, budgetUsd: budget, storage }, 'intake extraction configured');
    return { repo, store, service, worker, checks, sequelize, jwtSecret };
}

const probability = (name, fallback) => {
    const raw = env(name, String(fallback)), p = Number(raw);
    if (!(p >= 0 && p <= 1)) throw new Error(`${name} must be a probability between 0 and 1, got "${raw}"`);
    return p;
};

/**
 * Jev (TypeSafe) judges what Gemini read. Off unless JEV_ENABLED=true; when enabled without a key it
 * stays off (with a warning) so that documents are handled exactly as without Jev.
 * JEV_PROVIDER=fake answers from fixed rules (tests, demo stacks): nothing is sent anywhere.
 */
export function jevFromEnv({ logger = console } = {}) {
    // Thresholds on Jev's probabilities, from the measurement on the sample documents (API-621):
    // planted mistakes scored ≥ 0.86, correct values ≤ 0.72. Check again on real documents.
    const jevConfig = {
        flagAt: probability('JEV_FLAG_AT', 0.8),          // a field is marked "check" from here
        escalateAt: probability('JEV_ESCALATE_AT', 0.9)    // the document gets the second reading from here
    };
    if (!envBool('JEV_ENABLED', false)) return { jev: null, jevConfig };
    if (envOneOf('JEV_PROVIDER', ['typesafe', 'fake'], 'typesafe') === 'fake') return { jev: createFakeJev(), jevConfig };
    if (!process.env.TYPESAFE_API_KEY) {
        logger.warn?.('JEV_ENABLED=true but TYPESAFE_API_KEY is not set: documents are not checked by Jev');
        return { jev: null, jevConfig };
    }
    const jev = createJevClient({
        apiKey: process.env.TYPESAFE_API_KEY,
        model: env('JEV_MODEL', 'jev-latest'),
        baseUrl: env('JEV_BASE_URL', 'https://api.typesafe.ai'),
        timeoutMs: envInt('JEV_TIMEOUT_MS', 5000)
    });
    return { jev, jevConfig };
}
