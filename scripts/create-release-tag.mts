import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface TagOptions {
  readonly repository: string
  readonly sha: string
  readonly version: string
  readonly token: string
  readonly publishedAny: boolean
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

type TagResult = {
  readonly tag: string
  readonly sha: string
  readonly status: 'created' | 'already-current' | 'already-tagged'
}

type GitObject = { readonly type: 'commit' | 'tag'; readonly sha: string }

function objectOf(value: unknown): GitObject {
  if (typeof value !== 'object' || value === null || !('object' in value)) {
    throw new Error('GitHub returned an invalid Git reference')
  }
  const object = value.object
  if (typeof object !== 'object' || object === null || !('type' in object) || !('sha' in object)
    || (object.type !== 'commit' && object.type !== 'tag') || typeof object.sha !== 'string') {
    throw new Error('GitHub returned an invalid Git object')
  }
  return object as GitObject
}

/** Create a lightweight version tag only after the complete npm publish step. */
export async function ensureReleaseTag(options: TagOptions): Promise<TagResult> {
  const { repository, sha, version, token, publishedAny, fetchImpl = fetch } = options
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid GitHub repository')
  if (!/^[a-fA-F0-9]{40}$/.test(sha)) throw new Error('invalid release commit SHA')
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) throw new Error('invalid release version')
  if (token.length === 0) throw new Error('GH_TOKEN is required to create a release tag')

  const tag = `v${version}`
  const base = `https://api.github.com/repos/${repository}/git`
  const request = (path: string, method = 'GET', body?: unknown): Promise<Response> => fetchImpl(`${base}/${path}`, {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...body === undefined ? {} : { 'Content-Type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const getRef = async (): Promise<GitObject | undefined> => {
    const response = await request(`ref/tags/${encodeURIComponent(tag)}`)
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`GitHub tag lookup failed (HTTP ${response.status})`)
    return objectOf(await response.json())
  }
  const commitOf = async (initial: GitObject): Promise<string> => {
    let object = initial
    for (let depth = 0; depth < 8; depth++) {
      if (object.type === 'commit') return object.sha
      const response = await request(`tags/${object.sha}`)
      if (!response.ok) throw new Error(`GitHub annotated tag lookup failed (HTTP ${response.status})`)
      object = objectOf(await response.json())
    }
    throw new Error(`GitHub tag ${tag} has too many nested tag objects`)
  }

  const existing = await getRef()
  if (existing !== undefined) {
    const committed = await commitOf(existing)
    if (committed === sha) return { tag, sha, status: 'already-current' }
    // A later main-branch push at the same version must retain the original
    // release tag. If this run actually uploaded packages, that mismatch is a
    // release conflict rather than permission to move a historical tag.
    if (!publishedAny) return { tag, sha: committed, status: 'already-tagged' }
    throw new Error(`Release tag ${tag} already points to ${committed}, not uploaded commit ${sha}`)
  }

  const created = await request('refs', 'POST', { ref: `refs/tags/${tag}`, sha })
  if (created.status === 201) return { tag, sha, status: 'created' }
  if (created.status === 422) {
    // A concurrent run may have created the same tag after our lookup.
    const raced = await getRef()
    if (raced !== undefined && await commitOf(raced) === sha) return { tag, sha, status: 'already-current' }
  }
  throw new Error(`GitHub tag creation failed (HTTP ${created.status})`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const published = process.env.PUBLISHED_ANY
  if (published !== 'true' && published !== 'false') throw new Error('PUBLISHED_ANY must be true or false')
  const manifest = JSON.parse(readFileSync(new URL('../packages/core/package.json', import.meta.url), 'utf8')) as { version: string }
  const result = await ensureReleaseTag({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    version: manifest.version,
    token: process.env.GH_TOKEN ?? '',
    publishedAny: published === 'true',
  })
  console.log(`Release tag ${result.tag}: ${result.status} at ${result.sha}`)
}
