export const RUNTIME_TEAM_LIMITS = Object.freeze({
  members: 8,
  idBytes: 1_024,
  metadataBytes: 8 * 1_024,
})

export const RUNTIME_TEAM_ERROR_CODES = Object.freeze({
  invalid: 'TEAM_OPTIONS_INVALID',
  memberConflict: 'TEAM_MEMBER_CONFLICT',
  ownership: 'TEAM_AGENT_OWNERSHIP_INVALID',
  closed: 'TEAM_CLOSED',
})
