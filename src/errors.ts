export class LateEventError extends Error {
  readonly code = "LATE_EVENT" as const;
  constructor(message: string) {
    super(message);
    this.name = "LateEventError";
  }
}

export class ArchiveCorruptionError extends Error {
  readonly code = "ARCHIVE_CORRUPTION" as const;
  constructor(message: string) {
    super(message);
    this.name = "ArchiveCorruptionError";
  }
}

export class InvalidCursorError extends Error {
  readonly code = "INVALID_CURSOR" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}
