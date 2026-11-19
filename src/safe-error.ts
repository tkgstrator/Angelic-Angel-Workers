/** An error whose message is safe to return to the admin caller. */
export class SafeError extends Error {
  readonly status: number
  readonly code: 'cancelled' | 'backoff' | undefined

  constructor(status: number, message: string, code?: 'cancelled' | 'backoff') {
    super(message)
    this.status = status
    this.code = code
  }
}

export const cancelled = (): SafeError =>
  new SafeError(409, 'The operation was cancelled', 'cancelled')
export const isCode = (error: unknown, code: 'cancelled' | 'backoff'): boolean =>
  error instanceof SafeError && error.code === code
export const safeMessage = (error: unknown): string =>
  error instanceof SafeError ? error.message : 'Internal error'
