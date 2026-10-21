export class ExtractionError extends Error {
  constructor(code, message, { provider = null, requestId = null, status = null } = {}) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
    this.provider = provider;
    this.requestId = requestId;
    this.status = status;
    // Do not attach raw model output, HTTP response bodies, prompts, or wrapped causes.
  }
}

export function fail(code, message, details) {
  throw new ExtractionError(code, message, details);
}
