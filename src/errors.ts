/** 版本冲突：携带的 baseVersion 已不是当前版本，整批拒绝。 */
export class VersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`version conflict: expected ${expected}, current is ${actual}`);
    this.name = 'VersionConflictError';
  }
}

/** 批量编辑不合法，整批拒绝。 */
export class BatchValidationError extends Error {
  readonly code = 'BATCH_VALIDATION' as const;
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'BatchValidationError';
  }
}

/** 导图不存在或已存在等元信息错误。 */
export class MapNotFoundError extends Error {
  readonly code = 'MAP_NOT_FOUND' as const;
  constructor(readonly mapId: string) {
    super(`mind map not found: ${mapId}`);
    this.name = 'MapNotFoundError';
  }
}

export class MapAlreadyExistsError extends Error {
  readonly code = 'MAP_ALREADY_EXISTS' as const;
  constructor(readonly mapId: string) {
    super(`mind map already exists: ${mapId}`);
    this.name = 'MapAlreadyExistsError';
  }
}
