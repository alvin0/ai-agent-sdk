export const DELIVERY_QUEUE_DEFAULTS = Object.freeze({
  maxEvents: 10_000,
  maxBytes: 16 * 1024 * 1024,
  maxBatchEvents: 256,
  maxBatchBytes: 512 * 1024,
})
