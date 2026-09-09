/**
 * Package-manager scripts may forward a literal `--`. Harnesses also accept an
 * optional `run` command so copied npm/pnpm invocations behave identically.
 */
export function stripCommandSeparators(argv: readonly string[]): readonly string[] {
  let index = 0
  while (argv[index] === '--') index++
  if (argv[index] === 'run') index++
  while (argv[index] === '--') index++
  return argv.slice(index)
}
