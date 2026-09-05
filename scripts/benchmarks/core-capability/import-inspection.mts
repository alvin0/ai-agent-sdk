/** Inspect emitted JavaScript imports with the parser used by the audit bundler. */

import { parseSync, Visitor } from 'rolldown/utils'

export function importSpecifiers(source: string): string[] {
  const result = new Set<string>()
  const add = (value: string): void => {
    if (!value.startsWith('.') && !value.startsWith('/')) result.add(value)
  }
  const parsed = parseSync('emitted-bundle.js', source)
  if (parsed.errors.length > 0) throw new Error(`could not parse emitted bundle: ${parsed.errors[0]?.message}`)
  new Visitor({
    ImportDeclaration(node) { add(node.source.value) },
    ExportAllDeclaration(node) { add(node.source.value) },
    ExportNamedDeclaration(node) { if (node.source !== null) add(node.source.value) },
    ImportExpression(node) {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') add(node.source.value)
    },
    CallExpression(node) {
      const first = node.arguments[0]
      if (node.callee.type === 'Identifier' && node.callee.name === 'require'
        && first?.type === 'Literal' && typeof first.value === 'string') add(first.value)
    },
  }).visit(parsed.program)
  return [...result].sort()
}

export function assertImportInspection(): void {
  const observed = importSpecifiers([
    'import"side-effect";',
    'import{a as b}from"minified-static";',
    "export*from'export-all';",
    'const lazy=import("dynamic-import");',
    'const legacy=require("legacy-require");',
    'const ignored="import{notCode}from\\\"string-literal\\\"";',
    'import "./relative.js";',
  ].join(''))
  const expected = ['dynamic-import', 'export-all', 'legacy-require', 'minified-static', 'side-effect']
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`emitted import inspection self-test failed: ${JSON.stringify(observed)}`)
  }
}
