/**
 * The search service's routes. `GET /health/events` is for the readiness check: it says no
 * document's content, only counts and the consumers' lag. The service is reached on the internal
 * network only; the gateway does not route to it.
 */
export async function searchRoutes(app, {service}) {
  app.get('/health/events', async () => service.status());
}
