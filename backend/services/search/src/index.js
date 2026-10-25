import {
  createEventBus,
  createServiceTokenSigner,
  env,
  envInt,
  startService,
} from '@lrfe/common';
import {buildApp} from './app.js';
import {createEdrmsClient, createIntakeClient} from './clients.js';
import {SearchService} from './search.service.js';

const jwtSecret = env('JWT_SECRET');
// it only reads events: its durable consumers resume where they stopped (EVENT_BUS_DRIVER=nats)
const events = createEventBus({
  driver: env('EVENT_BUS_DRIVER', 'log'),
  source: 'search',
});
// the AI's reading of an upload, read from intake with a search service token
const intake = createIntakeClient({
  baseUrl: env('INTAKE_URL', 'http://localhost:3504'),
  serviceToken: createServiceTokenSigner({
    secret: jwtSecret,
    service: 'search',
  }),
});
// filed documents, read from edrms with a search service token
const edrms = createEdrmsClient({
  baseUrl: env('EDRMS_URL', 'http://localhost:3502'),
  serviceToken: createServiceTokenSigner({
    secret: jwtSecret,
    service: 'search',
  }),
});
const service = new SearchService({events, intake, edrms});

const app = await buildApp({
  service,
  logger: {level: env('LOG_LEVEL', 'info')},
});
service.start({logger: app.log});

await startService(app, {
  port: envInt('PORT', 3508),
  onClose: () => events.close(),
});
