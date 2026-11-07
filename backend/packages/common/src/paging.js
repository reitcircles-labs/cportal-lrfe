/**
 * The `offset` of a paged list, the same in every service. Its maximum keeps a number the database
 * cannot hold (PostgreSQL integer and bigint) from reaching a query: such a request is a 400, not a
 * server error (API-820, found by the penetration tests).
 */
export const OFFSET_SCHEMA = Object.freeze({
  type: 'integer',
  minimum: 0,
  maximum: 2_147_483_647,
  default: 0,
});
