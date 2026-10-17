// Diagnostic-only scanner: JSON.parse owns acceptance. Native parse errors do not
// consistently provide offsets (notably V8's "Unexpected token" diagnostics).
// Use an iterative grammar walk so even deeply nested failures need no recursion.
type State = 'value' | 'end' | 'array-first' | 'array-value' | 'array-end'
  | 'object-first' | 'object-key' | 'object-colon' | 'object-end'

const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/uy
const PRIMITIVE = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/uy
const SPACE = /[\t\n\r ]*/uy
const KEYS = new Set<State>(['object-first', 'object-key'])
const VALUES = new Set<State>(['value', 'array-first', 'array-value'])
const CLOSING: Partial<Record<State, string>> = {
  'array-first': ']', 'array-end': ']', 'object-first': '}', 'object-end': '}',
}
const TRANSITIONS: Partial<Record<State, { char: string; next: State[] }>> = {
  'array-end': { char: ',', next: ['array-value'] },
  'object-end': { char: ',', next: ['object-key'] },
  'object-colon': { char: ':', next: ['object-end', 'value'] },
}

function tokenEnd(pattern: RegExp, text: string, offset: number): number {
  pattern.lastIndex = offset
  return pattern.exec(text) === null ? offset : pattern.lastIndex
}

function valueEnd(text: string, offset: number, stack: State[]): number {
  const char = text[offset]
  if (char === '[' || char === '{') {
    stack.push(char === '[' ? 'array-first' : 'object-first')
    return offset + 1
  }
  return tokenEnd(char === '"' ? STRING : PRIMITIVE, text, offset)
}

function literalErrorOffset(text: string, offset: number): number {
  const literal = ['true', 'false', 'null'].find(value => value[0] === text[offset])
  if (literal === undefined) return offset
  let index = 0
  while (index < literal.length && text[offset + index] === literal[index]) index++
  return offset + index
}

function advance(state: State, char: string | undefined, stack: State[]): boolean {
  if (char !== undefined && CLOSING[state] === char) return true
  const transition = TRANSITIONS[state]
  if (transition !== undefined && transition.char === char) {
    stack.push(...transition.next)
    return true
  }
  return false
}

function readToken(state: State, text: string, offset: number, stack: State[]): number {
  if (KEYS.has(state)) {
    stack.push('object-colon')
    return tokenEnd(STRING, text, offset)
  }
  if (VALUES.has(state)) {
    if (state !== 'value') stack.push('array-end')
    return valueEnd(text, offset, stack)
  }
  return offset
}

/** Locate the first syntax failure in text already rejected by JSON.parse. */
export function jsonErrorOffset(text: string): number {
  const stack: State[] = ['end', 'value']
  let offset = 0
  while (stack.length > 0) {
    offset = tokenEnd(SPACE, text, offset)
    const state = stack.pop()!
    if (advance(state, text[offset], stack)) { offset++; continue }
    const end = readToken(state, text, offset, stack)
    if (end === offset) return VALUES.has(state) ? literalErrorOffset(text, offset) : offset
    offset = end
  }
  return offset
}
