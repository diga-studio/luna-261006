export type LocalDockErrorCode =
  | 'NO_SERVING_VERSION'
  | 'DEPLOY_FAILED'
  | 'DEPLOY_SUPERSEDED'
  | 'DEPLOY_INVALIDATED'
  | 'UNIT_EXITED';

export class LocalDockError extends Error {
  readonly code: LocalDockErrorCode;
  constructor(code: LocalDockErrorCode, message: string) {
    super(message);
    this.name = 'LocalDockError';
    this.code = code;
  }
}
