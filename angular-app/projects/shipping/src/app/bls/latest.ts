/**
 * Which of a screen's requests is the latest (CB-42 review): an answer to an earlier request that
 * arrives after a later one began is ignored, so a slower older answer never overwrites a newer
 * one (what switchMap does for observables).
 */
export class LatestRequest {
  private last = 0;

  /**
   * Begins a request, which becomes the latest.
   * @return its number
   */
  begin(): number {
    this.last += 1;
    return this.last;
  }

  /**
   * Whether a request is still the latest begun.
   * @param request its number, from begin()
   * @return true when no later request has begun
   */
  isCurrent(request: number): boolean {
    return request === this.last;
  }
}
