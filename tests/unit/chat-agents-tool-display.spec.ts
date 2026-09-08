import { describe, expect, it } from 'vitest'

const { opensByDefault, showsLiveOutput, webGroupSummary, webVisitsOf } =
  await import('../../samples/chat-agents/web/src/ui/chat/toolDisplay.ts')

/**
 * What a tool row shows, and when.
 *
 * Reported from the running app: commands ran, but neither their output nor
 * their progress was ever visible. The backend was sending everything — a
 * `terminal` card on the result and a `tool-output` chunk per burst, both
 * confirmed against the live server — so nothing was missing from the data.
 * The row simply decided there was nothing to draw.
 */
describe('which tool rows open themselves', () => {
  it('opens a shell call, because its output is its result', () => {
    // A collapsed row reduces a build log to a chevron: the user is asked to
    // click to find out whether their build passed.
    expect(opensByDefault('run_command')).toBe(true)
  })

  it('leaves the rest collapsed', () => {
    // These already say what happened in their one-line summary, and opening
    // all of them turns the transcript into a wall of JSON.
    for (const name of ['read_file', 'edit_file', 'list_directory', 'write_todos', 'search_files']) {
      expect(opensByDefault(name)).toBe(false)
    }
  })
})

describe('when the live terminal view is drawn', () => {
  it('draws it from the first moment a command runs, not its first byte', () => {
    // `npm install` prints nothing for half a minute. Requiring output first
    // left the row blank through exactly the wait the live view exists for.
    expect(showsLiveOutput({ name: 'run_command', state: 'running' })).toBe(true)
    expect(showsLiveOutput({ name: 'run_command', state: 'running', liveOutput: '' })).toBe(true)
  })

  it('draws it for any other tool that is actually streaming', () => {
    expect(showsLiveOutput({ name: 'fetch_url', state: 'running', liveOutput: 'chunk' })).toBe(true)
    expect(showsLiveOutput({ name: 'fetch_url', state: 'running' })).toBe(false)
  })

  it('stops once the call has settled, so the card takes over', () => {
    // The settled result carries the server's own capped copy in a terminal
    // card; two views of the same output would disagree the moment one of them
    // was truncated differently.
    expect(showsLiveOutput({ name: 'run_command', state: 'ok', liveOutput: 'done' })).toBe(false)
    expect(showsLiveOutput({ name: 'run_command', state: 'error', liveOutput: 'boom' })).toBe(false)
  })
})

/**
 * What a run of web fetches shows.
 *
 * Reported from the running app: a research step drew eight rows of full URLs,
 * five of them carrying a paragraph of red error text about an
 * investor-relations page that 404s. The calls were all correct; the question
 * a reader asks of a research step is which sources it consulted, and a list of
 * calls is a poor way to answer it.
 */
describe('folding a run of web calls into its sources', () => {
  const ok = (url: string) => ({ name: 'fetch_url', state: 'ok' as const, args: '{}', card: { kind: 'web', url } })
  const failed = (url: string) =>
    ({ name: 'fetch_url', state: 'error' as const, args: JSON.stringify({ url }) })

  it('reads a settled call from its card and a failed one from its arguments', () => {
    // A failed fetch has no card. Reading only cards would drop it from the
    // rail, and a run whose failures are invisible reads as one that found
    // everything it went looking for.
    expect(webVisitsOf([
      ok('https://cafef.vn/a'),
      failed('https://www.ssi.com.vn/en/investor-relations'),
    ]).map(visit => [visit.host, visit.failed])).toEqual([
      ['cafef.vn', false],
      ['www.ssi.com.vn', true],
    ])
  })

  it('keeps one entry per host, in the order each was first reached', () => {
    const visits = webVisitsOf([
      failed('https://www.hdbank.com.vn/quan-he-nha-dau-tu'),
      ok('https://cafef.vn/a'),
      failed('https://www.hdbank.com.vn/vi/quan-he-nha-dau-tu'),
    ])
    expect(visits.map(visit => visit.host)).toEqual(['www.hdbank.com.vn', 'cafef.vn'])
    expect(visits[0]?.count).toBe(2)
  })

  it('calls a host failed only when nothing it was asked for answered', () => {
    // Two tries and one page is a source that answered, however many 404s it
    // took to find the right path.
    const visits = webVisitsOf([
      failed('https://www.mbbank.com.vn/quan-he-co-dong'),
      ok('https://www.mbbank.com.vn/InvestorRelations/FinancialInformation'),
    ])
    expect(visits[0]).toMatchObject({ host: 'www.mbbank.com.vn', failed: false, count: 2 })
  })

  it('ignores a call with no usable URL rather than inventing a source', () => {
    expect(webVisitsOf([{ name: 'fetch_url', state: 'error', args: 'not json' }])).toEqual([])
    expect(webVisitsOf([{ name: 'fetch_url', state: 'error', args: '{"url":"nonsense"}' }])).toEqual([])
  })

  it('says how many pages came from how many sites, and stays quiet when they match', () => {
    expect(webGroupSummary(1, 1)).toBe('Read 1 page')
    expect(webGroupSummary(8, 8)).toBe('Read 8 pages')
    expect(webGroupSummary(8, 5)).toBe('Read 8 pages from 5 sites')
  })
})
