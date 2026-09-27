import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { grade } from '../../test-human/multi-agent/quality-grading.ts'

const expected = { status: 'completed', sourceIds: ['a|b', 'c'], totalObserved: 2, totalBaseline: 1, changePercent: 100 }
const raw = (sourceIds: unknown) => ({ status: 'completed', text: JSON.stringify({ ...expected, sourceIds }) })

describe('multi-agent quality primary oracle', () => {
  it('rejects different source IDs that share a delimiter-joined representation', () => {
    expect(grade(raw(['a', 'b|c']), expected)).toMatchObject({ correct: false, exactSourceIdentity: false, falseCompletion: true })
  })
  it('keeps identity order-independent and requires exact multiplicity', () => {
    expect(grade(raw(['c', 'a|b']), expected).correct).toBe(true)
    expect(grade(raw(['c', 'a|b', 'c']), expected).correct).toBe(false)
    expect(grade(raw(['']), { ...expected, sourceIds: [] }).correct).toBe(false)
  })
  it('uses the same lossless identity comparison in the Python analyzer', () => {
    // Run the actual function body without launching the analyzer's cohort IO.
    const result = execFileSync('python3', ['-c', `
import ast,json,pathlib,re,math
source=pathlib.Path('test-human/multi-agent/quality-analyze.py').read_text()
function=next(node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name=='strict_grade')
oracle={'test':json.loads(${JSON.stringify(JSON.stringify(expected))})}
exec(compile(ast.Module(body=[function],type_ignores=[]),'quality-analyze.py','exec'))
wrong=dict(oracle['test'],sourceIds=['a','b|c'])
correct=dict(oracle['test'],sourceIds=['c','a|b'])
print(json.dumps([strict_grade({'id':'test','result':{'status':'completed','text':json.dumps(value)}}) for value in [wrong,correct]]))
`], { encoding: 'utf8' })
    expect(JSON.parse(result).map((row: { correct: boolean }) => row.correct)).toEqual([false, true])
  })
})
