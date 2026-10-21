/** Public error types deliberately never embed credentials, URLs or response bodies. */
export class ScopehatchError extends Error {
  constructor(message: string, public readonly kind: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class ScopehatchConfigurationError extends ScopehatchError {
  constructor(message: string) { super(message, 'configuration'); }
}
export class ScopehatchAuthenticationError extends ScopehatchError {
  constructor() { super('A valid access token is required', 'authentication'); }
}
export class ScopehatchHttpError extends ScopehatchError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly requestId?: string,
    public readonly retryAfterMs?: number,
  ) { super(`Scopehatch API rejected request (${status}: ${code})`, 'http'); }
}
export class ScopehatchTimeoutError extends ScopehatchError {
  constructor() { super('Scopehatch request timed out', 'timeout'); }
}
export class ScopehatchAbortError extends ScopehatchError {
  constructor() { super('Scopehatch request cancelled', 'abort'); }
}
export class ScopehatchNetworkError extends ScopehatchError {
  constructor() { super('Scopehatch request failed at the transport layer', 'network'); }
}
export class ScopehatchProtocolError extends ScopehatchError {
  constructor() { super('Scopehatch API returned an invalid JSON response', 'protocol'); }
}
