import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface ExportTarget { readonly types: string; readonly default: string }

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  readonly name: string
  readonly version: string
  readonly exports: Readonly<Record<string, ExportTarget | string>>
}

const entries: Record<string, { exports: string[]; typesSha256: string }> = {}
for (const [subpath, target] of Object.entries(packageJson.exports)) {
  if (subpath === './package.json' || typeof target === 'string') continue
  const runtimePath = resolve(root, target.default)
  const typesPath = resolve(root, target.types)
  const runtime = await import(pathToFileURL(runtimePath).href)
  const types = await readFile(typesPath)
  entries[subpath] = {
    exports: Object.keys(runtime).sort(),
    typesSha256: createHash('sha256').update(types).digest('hex'),
  }
}

const rootRuntime = await import(pathToFileURL(resolve(root, 'dist/index.js')).href) as {
  readonly MODEL_ERROR_CODES: Readonly<Record<string, string>>
  readonly REGISTRY_ERROR_CODES: Readonly<Record<string, string>>
  readonly TOOL_ERROR_CODES: Readonly<Record<string, string>>
  readonly TOOL_REGISTRY_ERROR_CODES: Readonly<Record<string, string>>
  readonly CONTEXT_WINDOW_EXCEEDED_CODE: string
  readonly QUOTA_EXCEEDED_CODE: string
  readonly EMPTY_RESPONSE_CODE: string
  readonly MISSING_CREDENTIAL_CODE: string
  readonly INVALID_CREDENTIAL_CODE: string
}

const output = {
  schemaVersion: 1,
  package: { name: packageJson.name, version: packageJson.version },
  entries,
  errorCodes: {
    model: Object.values(rootRuntime.MODEL_ERROR_CODES).sort(),
    registry: Object.values(rootRuntime.REGISTRY_ERROR_CODES).sort(),
    tool: Object.values(rootRuntime.TOOL_ERROR_CODES).sort(),
    toolRegistry: Object.values(rootRuntime.TOOL_REGISTRY_ERROR_CODES).sort(),
    standalone: [
      rootRuntime.CONTEXT_WINDOW_EXCEEDED_CODE,
      rootRuntime.QUOTA_EXCEEDED_CODE,
      rootRuntime.EMPTY_RESPONSE_CODE,
      rootRuntime.MISSING_CREDENTIAL_CODE,
      rootRuntime.INVALID_CREDENTIAL_CODE,
    ].sort(),
  },
  jsonFormats: {
    historySnapshot: 1,
    memorySnapshot: 1,
    agentSessionSnapshot: 1,
  },
}

const destination = resolve(root, 'tests/fixtures/public-api/baseline.json')
await mkdir(dirname(destination), { recursive: true })
await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`${destination}\n`)
