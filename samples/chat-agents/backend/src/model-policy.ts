/** Keep recently verified Codex capabilities through a temporary catalogue outage.
 * Fresh successful discovery still replaces this data immediately. */
export const CODEX_CATALOG_POLICY = Object.freeze({ catalogStaleTtlMs: 30 * 60_000 })
