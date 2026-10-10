import {
  ProviderConformanceError,
  assembleReport,
  createCheckCollector,
  resolveTimeouts,
  type ResolvedConformanceTimeouts,
} from '../report.ts'
import type {
  ProviderConformanceCheck,
  ProviderConformanceOptions,
  ProviderConformanceReport,
} from '../types.ts'
import type {
  EmbeddingConformanceFixture,
} from './types.ts'

import { checkMappingIndexFaithful  } from './mapping-batching-checks.ts'
import { checkMappingInvalidRejected  } from './mapping-batching-checks.ts'
import { checkVectorValidation  } from './mapping-batching-checks.ts'
import { checkBatchLimitsRespected  } from './mapping-batching-checks.ts'
import { checkBatchMemoryBounded  } from './mapping-batching-checks.ts'
import { checkAbortStopsUnsent  } from './lifecycle-retry-checks.ts'
import { checkCloseCoversOperation  } from './lifecycle-retry-checks.ts'
import { checkRetryNoResend  } from './lifecycle-retry-checks.ts'
import { checkTimeoutDispatchUnknown  } from './lifecycle-retry-checks.ts'
import { checkCacheKeyComposition  } from './cache-space-checks.ts'
import { checkSpaceGuard  } from './cache-space-checks.ts'
import { checkNoModelFallback  } from './cache-space-checks.ts'
import { checkPluginGenerationOnly  } from './plugin-observation-checks.ts'
import { checkPluginEmbeddingOnly  } from './plugin-observation-checks.ts'
import { checkUsageHonesty  } from './plugin-observation-checks.ts'
import { checkTracePrivacy  } from './plugin-observation-checks.ts'

export async function collectEmbeddingConformanceChecks(
  fixture: EmbeddingConformanceFixture, timeouts: ResolvedConformanceTimeouts,
): Promise<readonly ProviderConformanceCheck[]> {
  const collector = createCheckCollector()
  const context = { fixture, timeouts, check: collector.check, budget: timeouts.caseTimeoutMs }
  await checkMappingIndexFaithful(context)
  await checkMappingInvalidRejected(context)
  await checkVectorValidation(context)
  await checkBatchLimitsRespected(context)
  await checkBatchMemoryBounded(context)
  await checkAbortStopsUnsent(context)
  await checkCloseCoversOperation(context)
  await checkRetryNoResend(context)
  await checkTimeoutDispatchUnknown(context)
  await checkCacheKeyComposition(context)
  await checkSpaceGuard(context)
  await checkNoModelFallback(context)
  await checkPluginGenerationOnly(context)
  await checkPluginEmbeddingOnly(context)
  await checkUsageHonesty(context)
  await checkTracePrivacy(context)
  return collector.checks
}

/**
 * Execute the embedding contract on its own.
 *
 * For a provider whose embedding capability ships separately from its generation
 * capability — which is the normal shape, since `Embedding_Provider_Plugin` is
 * its own plugin kind. The report is the same structure, with the embedding
 * checks in `checks`.
 */
export async function runEmbeddingConformanceSuite(
  fixture: EmbeddingConformanceFixture,
  options: ProviderConformanceOptions = {},
): Promise<ProviderConformanceReport> {
  const checks = await collectEmbeddingConformanceChecks(fixture, resolveTimeouts(options))
  const report = assembleReport(checks)
  if (report.failed > 0) throw new ProviderConformanceError(report)
  return report
}
