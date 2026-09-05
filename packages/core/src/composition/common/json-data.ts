import type { JsonObject, JsonValue } from '../../primitives/index.ts'
import { snapshotJsonObject, snapshotJsonValue } from '../../primitives/json-snapshot.ts'

const JSON_DATA_LIMITS = Object.freeze({ fields: 64, array: 100, depth: 8, nodes: 4_096, keyBytes: 128, bytes: 64 * 1024 })

/** Strict lossless-JSON clone. Accessors, sparse arrays, classes, cycles and non-finite numbers are rejected. */
export function cloneJsonObject(value: unknown): Readonly<JsonObject> {
  return snapshotJsonObject(value, limits())
}

/** Strict bounded clone for a JSON value crossing a public composition boundary. */
export function cloneJsonValue(value: unknown): JsonValue {
  return snapshotJsonValue(value, limits())
}

function limits() {
  return {
    maxObjectFields: JSON_DATA_LIMITS.fields,
    maxArrayItems: JSON_DATA_LIMITS.array,
    maxDepth: JSON_DATA_LIMITS.depth,
    maxNodes: JSON_DATA_LIMITS.nodes,
    maxKeyBytes: JSON_DATA_LIMITS.keyBytes,
    maxBytes: JSON_DATA_LIMITS.bytes,
  }
}
