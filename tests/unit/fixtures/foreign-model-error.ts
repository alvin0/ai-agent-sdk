/** An Error implementation with no import or nominal relationship to SDK core. */
export class ForeignModelError extends Error {
  readonly code: string
  readonly failure: Readonly<{
    message: string
    code: string
    status?: number
    providerRetryAfterMs?: number
    requestId?: string
  }>

  constructor(
    message: string,
    code: string,
    details: { readonly status?: number; readonly providerRetryAfterMs?: number; readonly requestId?: string } = {},
  ) {
    super(message)
    this.name = 'ForeignModelError'
    this.code = code
    this.failure = Object.freeze({ message, code, ...details })
  }
}
