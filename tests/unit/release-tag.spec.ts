import { describe, expect, it } from 'vitest'
import { ensureReleaseTag } from '../../scripts/create-release-tag.mts'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)
const ref = (sha: string, type: 'commit' | 'tag' = 'commit') => ({ object: { type, sha } })
const response = (status: number, value: unknown = {}) => new Response(JSON.stringify(value), { status })

function fixture(replies: Response[], publishedAny = true) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', ...init.body === undefined ? {} : { body: JSON.parse(String(init.body)) } })
    const next = replies.shift()
    if (next === undefined) throw new Error('unexpected GitHub request')
    return next
  }
  return {
    calls,
    run: () => ensureReleaseTag({ repository: 'owner/sdk', sha: SHA, version: '0.1.6',
      token: 'fixture-token', publishedAny, fetchImpl }),
  }
}

describe('release tag after npm publication', () => {
  it('creates v<package version> at the published commit after all uploads succeeded', async () => {
    const api = fixture([response(404), response(201, ref(SHA))])
    expect(await api.run()).toEqual({ tag: 'v0.1.6', sha: SHA, status: 'created' })
    expect(api.calls.map(call => call.method)).toEqual(['GET', 'POST'])
    expect(api.calls[1]?.url).toBe('https://api.github.com/repos/owner/sdk/git/refs')
    expect(api.calls[1]?.body).toEqual({ ref: 'refs/tags/v0.1.6', sha: SHA })
  })

  it('can finish a retried release whose packages were already on npm but tag was missing', async () => {
    const api = fixture([response(404), response(201, ref(SHA))], false)
    expect((await api.run()).status).toBe('created')
  })

  it('does not recreate a lightweight tag already pointing at this commit', async () => {
    const api = fixture([response(200, ref(SHA))])
    expect((await api.run()).status).toBe('already-current')
    expect(api.calls).toHaveLength(1)
  })

  it('resolves an existing annotated tag to its commit', async () => {
    const api = fixture([response(200, ref(TAG_OBJECT, 'tag')), response(200, ref(SHA))])
    expect((await api.run()).status).toBe('already-current')
    expect(api.calls[1]?.url).toBe(`https://api.github.com/repos/owner/sdk/git/tags/${TAG_OBJECT}`)
  })

  it('preserves the older tag when a later main commit has no new package upload', async () => {
    const api = fixture([response(200, ref(OTHER))], false)
    expect(await api.run()).toEqual({ tag: 'v0.1.6', sha: OTHER, status: 'already-tagged' })
    expect(api.calls).toHaveLength(1)
  })

  it('rejects a version collision if this run uploaded packages from another commit', async () => {
    const api = fixture([response(200, ref(OTHER))])
    await expect(api.run()).rejects.toThrow(/already points to/)
    expect(api.calls).toHaveLength(1)
  })

  it('does not treat a permission or API failure as a missing tag', async () => {
    const api = fixture([response(403)])
    await expect(api.run()).rejects.toThrow(/lookup failed.*403/)
    expect(api.calls).toHaveLength(1)
  })

  it('accepts another run creating the same tag during the POST', async () => {
    const api = fixture([response(404), response(422), response(200, ref(SHA))])
    expect((await api.run()).status).toBe('already-current')
    expect(api.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET'])
  })
})
