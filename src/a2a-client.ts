export {
  A2AAgentLink,
  createA2AAgentLink,
  linkA2AAgent,
  type A2AAgentLinkOptions,
  type LinkA2AAgentOptions,
} from './a2a/client.ts'

export {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
  type RequestOptions,
} from '@a2a-js/sdk/client'
export type {
  AgentCard,
  Message,
  Part,
  SendMessageRequest,
  StreamResponse,
  Task,
} from '@a2a-js/sdk'
