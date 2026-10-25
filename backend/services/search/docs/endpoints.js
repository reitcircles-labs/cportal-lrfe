// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export const ENDPOINTS = {
  title: 'search',
  description:
    'Document search: receives intake’s and edrms’ document events and fetches each document for the search index. Reached on the internal network only, not through the gateway. Design: services/search/README.md.',
  tags: {
    Service: 'Health and the event consumers’ lag.',
  },
  routes: {
    'GET /health': {tag: 'Service', summary: 'Health check', auth: 'public'},
    'GET /health/events': {
      tag: 'Service',
      summary: 'The event consumers: counts and lag',
      description:
        '`{ lag, consumers: [{ event, durable, received, fetched, missing, failed, lastHandledAt, pending, unacked }] }`. Counts since the service started; `pending` (not given to the service yet) and `unacked` (being handled) come from the event stream, `lag` is their total, null when the event bus cannot say. No document content.',
      auth: 'public',
    },
  },
};
