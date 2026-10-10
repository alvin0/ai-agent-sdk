import type { ModelRegistry } from '../../runtime/registry.ts'
import type { ProviderSelection } from '../provider/types.ts'
import type { RuntimeOperations } from '../lifecycle/operations.ts'
import type { RuntimeObservationPort } from '../observation/port.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import type { RuntimeResources } from '../../platform/resources.ts'

export interface RuntimeAgentHost {
  readonly registry: ModelRegistry
  /**
   * The runtime's captured provider routes.
   *
   * Held so a per-invocation model override resolves against exactly the same
   * configuration the agent binding used, rather than a second view of it.
   */
  readonly selection: ProviderSelection
  readonly operations: RuntimeOperations
  readonly observation: RuntimeObservationPort
  readonly resource: RuntimeObservationResource
  readonly resources: RuntimeResources
}

