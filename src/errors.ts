/** Error types thrown by the library. */

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Manifest or key does not match the stored record for this batch id. */
export class BatchConflictError extends VaultError {
  constructor(message: string) {
    super("BATCH_CONFLICT", message);
  }
}

/** Input validation failed (limits, paths, key size, ...). */
export class ValidationError extends VaultError {
  constructor(message: string) {
    super("VALIDATION", message);
  }
}

/** Integrity or authenticity check failed while reading back a file. */
export class IntegrityError extends VaultError {
  constructor(message: string) {
    super("INTEGRITY", message);
  }
}
