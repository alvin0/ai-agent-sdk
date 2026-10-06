import { builtinRules } from 'eslint/use-at-your-own-risk'

// ESLint is pinned in the catalog. Reuse its exact counting behavior; tests
// protect this adapter when the pinned version is upgraded.
const baseRule = builtinRules.get('max-lines-per-function')
const frameworks = new Set(['vitest', '@jest/globals', 'node:test'])
const modifiers = new Set(['only', 'skip', 'each', 'skipIf', 'runIf', 'concurrent', 'sequential', 'todo'])

function binding(identifier, sourceCode) {
  for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name)
    if (variable) return variable
  }
  return undefined
}

function isImportedSuite(identifier, sourceCode, namespace = false) {
  const variable = binding(identifier, sourceCode)
  if (!variable) return !namespace && identifier.name === 'describe'
  const definition = variable.defs[0]
  if (definition?.type !== 'ImportBinding' || !frameworks.has(definition.parent.source.value)) return false
  if (namespace) return definition.node.type === 'ImportNamespaceSpecifier'
  if (definition.node.type !== 'ImportSpecifier') return false
  return ['describe', 'suite'].includes(definition.node.imported.name)
}

function isSuiteCallee(node, sourceCode) {
  if (node.type === 'Identifier') return isImportedSuite(node, sourceCode)
  if (node.type === 'CallExpression') return isSuiteCallee(node.callee, sourceCode)
  if (node.type === 'TaggedTemplateExpression') return isSuiteCallee(node.tag, sourceCode)
  if (node.type !== 'MemberExpression' || node.computed) return false
  if (modifiers.has(node.property.name)) return isSuiteCallee(node.object, sourceCode)
  return ['describe', 'suite'].includes(node.property.name)
    && node.object.type === 'Identifier'
    && isImportedSuite(node.object, sourceCode, true)
}

function isSuiteCallback(node, sourceCode) {
  const call = node.parent
  return call?.type === 'CallExpression'
    && call.arguments.length >= 2
    && call.arguments.at(-1) === node
    && isSuiteCallee(call.callee, sourceCode)
}

export default {
  meta: { ...baseRule.meta },
  create(context) {
    const visitors = baseRule.create(context)
    return Object.fromEntries(Object.entries(visitors).map(([selector, visit]) => [selector, node => {
      if (!isSuiteCallback(node, context.sourceCode)) visit(node)
    }]))
  },
}
