/** 单行检查结果，逐行交给调用方。 */
export interface CheckResult {
  /** 输入行（原样回显，未归一化）。 */
  readonly input: string;
  /** 是否命中一次性邮箱域名表。 */
  readonly disposable: boolean;
  /** 命中的规则（归一化后的表内域名）；未命中为 null。 */
  readonly matchedRule: string | null;
  /** 本次检查使用的规则表修订号。 */
  readonly revision: number;
}

/** 一次整份替换导入的会话。数据可分段到达。 */
export interface ImportSession {
  /** 会话携带的修订号（调用方提供的唯一正整数）。 */
  readonly revision: number;
  /** 追加一段域名数据。 */
  addChunk(domains: Iterable<string>): void;
  /** 完成导入；只有完整提交才可能生效。返回是否成为当前生效修订。 */
  commit(): boolean;
  /** 放弃本次导入。 */
  abort(): void;
  /** 会话是否仍可进行（未提交、未放弃）。 */
  readonly active: boolean;
}

/** 一批名单的处理句柄；受理时已固定修订。 */
export interface Batch {
  /** 受理时固定的规则表修订号。 */
  readonly revision: number;
  /** 检查一行（邮箱域名或完整邮箱地址），逐行返回结果。 */
  checkLine(line: string): CheckResult;
  /** 正常结束批次，释放对旧修订的占用。 */
  close(): void;
  /** 取消批次：已交付结果不撤回，之后不得再交付结果。 */
  cancel(): void;
  /** 批次是否仍可交付结果。 */
  readonly active: boolean;
}
