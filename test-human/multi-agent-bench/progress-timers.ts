/** Match the timer creator in the built progress scheduler, never the smoke caller path. */
export function isProgressTimer(stack: string): boolean {
  return stack.split(/\n| \| /).some(frame =>
    /\bat .*packages\/core\/dist\/agent\/team\/managed-progress\.js:\d+:\d+/.test(frame))
}
