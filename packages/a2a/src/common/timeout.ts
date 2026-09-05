export class A2ATeardownTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new A2ATeardownTimeoutError(message)), timeoutMs)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
