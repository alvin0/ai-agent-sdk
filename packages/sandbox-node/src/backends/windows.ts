/**
 * Windows backend placeholder.
 *
 * Confining a child process on Windows means building a restricted token and
 * workspace ACEs through Win32 (`CreateRestrictedToken`, `SetNamedSecurityInfo`),
 * which has no pure-JavaScript path. That rung ships separately so this package
 * stays dependency-free; until it is mounted, `confine()` fails closed here
 * while the in-process fence keeps governing the file effects tools perform
 * themselves — which is every filesystem tool in the SDK.
 *
 * The boundary such a rung can offer is inherently partial: a restricted token
 * must retain `Everyone` for process initialization, and NTFS hard links alias
 * one file object across paths. It would report `partial`, never `full`.
 */

/** Why `win32` has no process-confinement rung in this package. */
export const WINDOWS_UNAVAILABLE_REASON =
  'process confinement on win32 needs a Win32 restricted-token backend, which is not bundled; '
  + 'the in-process fence still applies, so use fence(policy) or run with danger-full-access under explicit approval'
