import { envCredential as rootCredential } from '@ai-agent-sdk/auth-node'
import { envCredential as pathCredential } from '@ai-agent-sdk/auth-node/env'

if (rootCredential !== pathCredential) throw new Error('root and /env credential factories differ')
process.env.PACKED_ENV_ONLY_KEY = 'env-only-secret'
const credential = rootCredential('PACKED_ENV_ONLY_KEY')
if (credential() !== 'env-only-secret') throw new Error('callable compatibility view failed')
if (credential.kind !== 'credential-source' || credential.apiVersion !== 1) {
  throw new Error('versioned credential marker missing')
}
console.log('auth-node-env-only:pass')
