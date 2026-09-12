/**
 * The HTTP-to-taxonomy mapping, re-exported at its original path.
 *
 * The table itself moved to {@link ../transport/errors} when the transport was
 * split out: both pipelines map statuses identically, so the mapping belongs to the
 * shared layer rather than beside SSE decoding. This module stays so existing
 * importers of `base/http-errors.ts` keep working, and so the package's public
 * surface is unchanged.
 *
 * @module ai-agent-sdk/providers/base/http-errors
 */

export {
  httpErrorCode,
  parseErrorBody,
  requestIdFrom,
  retryAfterMs,
  type ParsedErrorBody,
} from '../transport/errors.ts'
