// npm serves the provenance it verified during publication on its own registry.
interface Provenance {
  predicateType?: string
  subject?: { name: string; digest?: { sha512?: string } }[]
  predicate?: { buildDefinition?: {
    externalParameters?: { workflow?: { repository?: string; path?: string; ref?: string } }
    resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[]
  } }
}

const SLSA = 'https://slsa.dev/provenance/v1'

export async function verifyReleaseSource(name: string, version: string, digest: string, head: string,
  repository: string, fetchImpl = fetch): Promise<void> {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok) throw new Error(`Cannot verify npm provenance for ${name} (HTTP ${response.status})`)
  const record = await response.json() as { attestations?: {
    predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } }
  }[] }
  const source = `https://github.com/${repository}`
  const subjectName = `pkg:npm/${name.replace('@', '%40')}@${version}`
  const verified = record.attestations?.some(attestation => {
    const payload = attestation.bundle?.dsseEnvelope?.payload
    if (attestation.predicateType !== SLSA || !payload) return false
    const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Provenance
    const build = statement.predicate?.buildDefinition
    const workflow = build?.externalParameters?.workflow
    return statement.predicateType === SLSA
      && statement.subject?.some(subject => subject.name === subjectName && subject.digest?.sha512 === digest)
      && workflow?.repository === source && workflow.path === '.github/workflows/release.yml' && workflow.ref
      && build?.resolvedDependencies?.some(dep => dep.uri === `git+${source}@${workflow.ref}` && dep.digest?.gitCommit === head)
  })
  if (!verified) throw new Error(`Published ${name}@${version} has no matching release provenance at ${head}`)
}
