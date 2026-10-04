import * as fs from "node:fs";

const CHUNK_SIZE = 64 * 1024;
const COMMA = 0x2c;
const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;
const BOM = 0xefbbbf;

export interface CsvRecord {
  /** 解码后的字段值（除 CSV 解码外不做任何归一化） */
  fields: string[];
  /** 下一条逻辑记录的起始字节偏移 */
  nextOffset: number;
}

/** 测试专用：观测解析器对源文件的实际读取范围。 */
export type ReadObserver = (position: number, length: number) => void;
let readObserver: ReadObserver | null = null;
export function setReadObserver(observer: ReadObserver | null): void {
  readObserver = observer;
}

const enum S {
  FieldStart,
  Unquoted,
  Quoted,
  QuoteSeen,
  CrSeen,
}

/**
 * 可恢复的字节偏移流式 CSV 解析器。
 * 从指定字节偏移（记录边界）开始解析，逐条产出逻辑记录。
 * 预读不会丢数据：nextOffset 始终是逻辑消费位置，恢复时从该偏移重新打开即可。
 */
export class CsvParser {
  private fd: number;
  private buf: Buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  private pos = 0;
  private end = 0;
  private base: number;
  private fileSize: number;
  private state: S = S.FieldStart;
  private fields: string[] = [];
  private fieldParts: Buffer[] = [];
  private closed = false;

  constructor(path: string, startOffset: number) {
    this.fd = fs.openSync(path, "r");
    this.fileSize = fs.fstatSync(this.fd).size;
    this.base = startOffset;
    if (startOffset === 0) {
      this.fill();
      if (this.end - this.pos >= 3 && this.buf.readUIntBE(this.pos, 3) === BOM) {
        this.pos += 3;
      }
    }
  }

  /** 当前逻辑消费位置（绝对文件偏移）。 */
  get offset(): number {
    return this.base + this.pos;
  }

  private fill(): boolean {
    if (this.pos >= this.end) {
      this.base = this.offset;
      this.pos = 0;
      this.end = 0;
      if (this.base >= this.fileSize) return false;
      const want = Math.min(CHUNK_SIZE, this.fileSize - this.base);
      this.end = fs.readSync(this.fd, this.buf, 0, want, this.base);
      if (readObserver) readObserver(this.base, this.end);
      return this.end > 0;
    }
    return true;
  }

  private endField(): void {
    this.fields.push(Buffer.concat(this.fieldParts).toString("utf8"));
    this.fieldParts = [];
  }

  private emit(): CsvRecord {
    const rec: CsvRecord = { fields: this.fields, nextOffset: this.offset };
    this.fields = [];
    this.fieldParts = [];
    this.state = S.FieldStart;
    return rec;
  }

  /** 读取下一条逻辑记录；EOF（记录边界）返回 null。 */
  next(): CsvRecord | null {
    for (;;) {
      if (this.pos >= this.end) {
        if (this.fill()) continue;
        // EOF：按当前状态收尾
        switch (this.state) {
          case S.FieldStart:
            if (this.fields.length === 0 && this.fieldParts.length === 0) return null;
            this.endField();
            return this.emit();
          case S.Unquoted:
            this.endField();
            return this.emit();
          case S.Quoted:
            throw new Error("CSV: unexpected EOF inside quoted field");
          case S.QuoteSeen:
            return this.emit();
          case S.CrSeen:
            return this.emit();
        }
      }
      const b = this.buf[this.pos]!;
      switch (this.state) {
        case S.FieldStart:
          if (b === QUOTE) {
            this.pos++;
            this.state = S.Quoted;
          } else if (b === COMMA) {
            this.pos++;
            this.endField();
          } else if (b === CR) {
            this.pos++;
            this.endField();
            this.state = S.CrSeen;
          } else if (b === LF) {
            this.pos++;
            this.endField();
            return this.emit();
          } else {
            this.state = S.Unquoted;
          }
          break;
        case S.Unquoted: {
          if (b === COMMA) {
            this.pos++;
            this.endField();
            this.state = S.FieldStart;
          } else if (b === CR) {
            this.pos++;
            this.endField();
            this.state = S.CrSeen;
          } else if (b === LF) {
            this.pos++;
            this.endField();
            return this.emit();
          } else {
            let i = this.pos;
            const limit = this.end;
            while (i < limit) {
              const c = this.buf[i]!;
              if (c === COMMA || c === CR || c === LF) break;
              i++;
            }
            this.fieldParts.push(this.buf.subarray(this.pos, i));
            this.pos = i;
          }
          break;
        }
        case S.Quoted: {
          const idx = this.buf.indexOf(QUOTE, this.pos);
          if (idx === -1) {
            this.fieldParts.push(this.buf.subarray(this.pos, this.end));
            this.pos = this.end;
          } else {
            if (idx > this.pos) this.fieldParts.push(this.buf.subarray(this.pos, idx));
            this.pos = idx + 1;
            this.state = S.QuoteSeen;
          }
          break;
        }
        case S.QuoteSeen:
          if (b === QUOTE) {
            this.fieldParts.push(Buffer.from([QUOTE]));
            this.pos++;
            this.state = S.Quoted;
          } else if (b === COMMA) {
            this.pos++;
            this.endField();
            this.state = S.FieldStart;
          } else if (b === CR) {
            this.pos++;
            this.endField();
            this.state = S.CrSeen;
          } else if (b === LF) {
            this.pos++;
            this.endField();
            return this.emit();
          } else {
            throw new Error("CSV: unexpected byte after closing quote");
          }
          break;
        case S.CrSeen:
          if (b === LF) this.pos++;
          return this.emit();
      }
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      fs.closeSync(this.fd);
    }
  }
}
