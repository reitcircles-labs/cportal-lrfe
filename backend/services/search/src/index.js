import {createEventBus, env, envInt, startService} from '@lrfe/common';
import {buildApp} from './app.js';
import {createSearchService, prepareIndex} from './setup.js';

// it only reads events: its durable consumers resume where they stopped (EVENT_BUS_DRIVER=nats)
const events = createEventBus({
  driver: env('EVENT_BUS_DRIVER', 'log'),
  source: 'search',
});
const service = createSearchService({events});

const app = await buildApp({
  service,
  logger: {level: env('LOG_LEVEL', 'info')},
});
// the index exists before the first event is written into it
const index = await prepareIndex(service, app.log);
app.log.info(
  {index: index ?? 'none: documents are only logged'},
  'search: index ready',
);
service.start({logger: app.log});

await startService(app, {
  port: envInt('PORT', 3508),
  onClose: () => events.close(),
});
