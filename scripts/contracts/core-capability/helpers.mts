import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseSync, Visitor } from 'rolldown/utils'
import type { Runtime } from './types.mts'
import type { Topology } from './topology.mts'

export function makeHelpers(workspace: string, topology: Topology) {
  const relative = (file: string): string => file.startsWith(`${workspace}/`) ? file.slice(workspace.length + 1) : file
  const fail = (message: string): never => {
    throw new Error(message)
  }
  const runtimeRank = (runtime: Runtime): number => {
    if (runtime === 'universal') return 0
    if (runtime === 'browser') return 1
    return 2
  }

  const assertSameSet = (label: string, actual: ReadonlySet<string>, expected: ReadonlySet<string>): void => {
    const missing = [...expected].filter(value => !actual.has(value)).sort()
    const extra = [...actual].filter(value => !expected.has(value)).sort()
    if (missing.length > 0 || extra.length > 0) {
      fail(`${label} differs; missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`)
    }
  }

  const parseImports = (file: string, source: string): readonly string[] => {
    const imports = new Set<string>()
    const parsed = parseSync(file, source)
    if (parsed.errors.length > 0) {
      fail(`could not parse ${relative(file)}: ${parsed.errors[0]?.message}`)
    }
    new Visitor({
      ImportDeclaration(node) {
        imports.add(node.source.value)
      },
      ExportAllDeclaration(node) {
        imports.add(node.source.value)
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) imports.add(node.source.value)
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          imports.add(node.source.value)
        }
      },
    }).visit(parsed.program)
    return [...imports].sort()
  }
  const importsOf = (file: string): readonly string[] => parseImports(file, readFileSync(file, 'utf8'))

  const assertParser = (): void => {
    const observed = parseImports('contract-import-self-test.ts', [
      "import type { A } from 'type-only'",
      "import { b } from 'static-import'",
      "export * from 'export-all'",
      "const lazy = import('dynamic-import')",
      "const ignored = \"import { fake } from 'string-decoy'\"",
      "import './relative.js'",
    ].join('\n')).filter(value => !value.startsWith('.'))
    const expected = ['dynamic-import', 'export-all', 'static-import', 'type-only']
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      fail(`contract import parser self-test failed: ${JSON.stringify(observed)}`)
    }
    const targetExports = parseTargetDeclarationExports('target-export-self-test.d.ts', [
      'export interface A {}',
      'export type B = string',
      'export declare const C: 1',
      "export { D as E, type F } from './source.js'",
      "const decoy = 'export interface StringDecoy {}'",
      '// export interface CommentDecoy {}',
    ].join('\n'))
    assertSameSet('target declaration export parser self-test', targetExports, new Set(['A', 'B', 'C', 'E', 'F']))
  }

  const parseTargetDeclarationExports = (file: string, source: string): ReadonlySet<string> => {
    const names = new Set<string>()
    const parsed = parseSync(file, source)
    if (parsed.errors.length > 0) {
      fail(`could not parse ${relative(file)}: ${parsed.errors[0]?.message}`)
    }
    const addIdentifier = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return
      const name = Reflect.get(value, 'name')
      if (typeof name === 'string') names.add(name)
      else {
        const literal = Reflect.get(value, 'value')
        if (typeof literal === 'string') names.add(literal)
      }
    }
    new Visitor({
      ExportNamedDeclaration(node) {
        const declaration = node.declaration
        if (declaration !== null) {
          addIdentifier(Reflect.get(declaration, 'id'))
          const declarations = Reflect.get(declaration, 'declarations')
          if (Array.isArray(declarations)) for (const item of declarations) addIdentifier(Reflect.get(item, 'id'))
        }
        for (const specifier of node.specifiers) addIdentifier(specifier.exported)
      },
      ExportAllDeclaration() {
        fail(`target API parity declaration cannot use unresolved export-all in ${relative(file)}`)
      },
    }).visit(parsed.program)
    return names
  }
  const targetDeclarationExportsOf = (file: string): ReadonlySet<string> =>
    parseTargetDeclarationExports(file, readFileSync(file, 'utf8'))
  const publicExportsOf = (file: string): ReadonlySet<string> => {
    const source = readFileSync(file, 'utf8')
    const clauses = [...source.matchAll(/export\s*\{([\s\S]*?)\};/g)]
    const body = clauses.at(-1)?.[1]
    if (body === undefined) {
      throw new Error(`could not find public export clause in ${relative(file)}`)
    }
    const names = new Set<string>()
    for (const entry of body.split(',')) {
      const normalized = entry.trim().replace(/^type\s+/, '')
      if (normalized.length === 0) continue
      const name = normalized.split(/\s+as\s+/).at(-1)
      if (name === undefined || !/^[A-Za-z_$][\w$]*$/.test(name)) {
        throw new Error(`could not parse public export '${normalized}' in ${relative(file)}`)
      }
      if (names.has(name)) {
        throw new Error(`duplicate public export '${name}' in ${relative(file)}`)
      }
      names.add(name)
    }
    return names
  }
  const listFiles = (directory: string, suffix: string): readonly string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return listFiles(path, suffix)
      return entry.isFile() && entry.name.endsWith(suffix) ? [path] : []
    })
  const listCodeFiles = (directory: string): readonly string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.isDirectory() && ['node_modules', 'dist', 'artifacts', '.temp'].includes(entry.name)) return []
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return listCodeFiles(path)
      return entry.isFile() && /\.(?:ts|mts|js|mjs)$/.test(entry.name) ? [path] : []
    })
  const markdownExampleSpecifiers = (file: string): readonly string[] => {
    const selected: string[] = []
    let fenced = false
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*```/.test(line)) {
        fenced = !fenced
        continue
      }
      if (fenced || /\b(?:pnpm add|npm install|npm i|yarn add)\b/.test(line)) {
        selected.push(line)
      }
      for (const match of line.matchAll(/`([^`]+)`/g)) selected.push(match[1] ?? '')
    }
    return [...selected.join('\n').matchAll(
      /@ai-agent-sdk\/[a-z0-9-]+(?:\/[a-z0-9-]+)?|(?<!@)\bai-agent-sdk(?:\/[a-z0-9-]+)?(?![a-z0-9-])/g,
    )].map(match => match[0])
  }
  const externalPackageName = (selection: string): string => {
    const separator = selection.lastIndexOf('@')
    if (separator <= 0) {
      throw new Error(`invalid exact external selection '${selection}'`)
    }
    return selection.slice(0, separator)
  }
  const packageNameOf = (specifier: string): string => {
    const segments = specifier.split('/')
    if (!specifier.startsWith('@') || segments.length < 2) {
      throw new Error(`invalid scoped package specifier '${specifier}'`)
    }
    return `${segments[0]}/${segments[1]}`
  }
  const externalImportOwner = (specifier: string): string => specifier.startsWith('@')
    ? packageNameOf(specifier)
    : specifier.split('/')[0] ?? specifier
  const externalClosure = (workspacePackages: ReadonlySet<string>): ReadonlySet<string> => {
    const closure = new Set<string>()
    for (const packageName of workspacePackages) {
      const rule = topology.packages[packageName]
      for (const dependency of [
        ...(rule?.externalRuntimeDependencies ?? []),
        ...(rule?.requiredExternalRuntimePeers ?? []),
      ]) {
        closure.add(dependency)
      }
    }
    return closure
  }
  const workspaceClosure = (selected: ReadonlySet<string>): ReadonlySet<string> => {
    const closure = new Set(selected)
    const pending = [...selected]
    while (pending.length > 0) {
      const packageName = pending.pop()
      if (packageName === undefined) continue
      for (const dependency of topology.packages[packageName]?.normalWorkspaceDependencies ?? []) {
        if (closure.has(dependency)) continue
        closure.add(dependency)
        pending.push(dependency)
      }
    }
    return closure
  }
  return {
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf, assertParser,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
  }
}

export type ContractHelpers = ReturnType<typeof makeHelpers>
