import { describe, expect, it } from 'vitest'

const { opensByDefault, showsLiveOutput } =
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
