import {
  domain,
  env,
  envInt,
  envList,
  recordServiceOf,
  startService,
} from '@lrfe/common';
import {PUBLIC_RATE_LIMIT, buildApp} from './app.js';

// the product's record service (CB-4): land-records at RECORDS_URL for land, shipping-records at
// SHIPPING_RECORDS_URL for shipping (CB-28)
const recordService = recordServiceOf(domain);
const recordUpstream = recordService
  ? {[recordService.name]: recordService.url}
  : {};

const app = await buildApp({
  upstreams: {
    identity: env('IDENTITY_URL', 'http://localhost:3501'),
    edrms: env('EDRMS_URL', 'http://localhost:3502'),
    bpm: env('BPM_URL', 'http://localhost:3503'),
    intake: env('INTAKE_URL', 'http://localhost:3504'),
    ...recordUpstream,
    audit: env('AUDIT_URL', 'http://localhost:3506'),
    extracts: env('EXTRACTS_URL', 'http://localhost:3507'),
  },
  corsOrigins: envList('CORS_ORIGINS', 'http://localhost:4200'),
  // the public check of an extract: requests per client address per window (API-693)
  publicRateLimit: {
    max: envInt('PUBLIC_RATE_LIMIT_MAX', PUBLIC_RATE_LIMIT.max),
    timeWindow: envInt(
      'PUBLIC_RATE_LIMIT_WINDOW_MS',
      PUBLIC_RATE_LIMIT.timeWindow,
    ),
  },
  logger: {level: env('LOG_LEVEL', 'info')},
});

await startService(app, {port: envInt('PORT', 3500)});
