const QUOTE = 0x22;
const COMMA = 0x2c;
const CR = 0x0d;
const LF = 0x0a;
const QUOTE_BUF = Buffer.from([QUOTE]);
const EMPTY = Buffer.alloc(0);

export interface ParsedRecord {
  fields: string[];
  bytesConsumed: number;
}

const enum State {
  FieldStart,
  InUnquoted,
  InQuoted,
  QuoteInQuoted,
}

export class CsvParser {
  private buf: Buffer = EMPTY;
  private eof = false;
  private first = true;

  feed(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  setEof(): void {
    this.eof = true;
  }

  nextRecord(): ParsedRecord | null {
    let start = 0;
    if (this.first) {
      if (this.buf.length >= 3) {
        if (this.buf[0] === 0xef && this.buf[1] === 0xbb && this.buf[2] === 0xbf) {
          start = 3;
        }
        this.first = false;
      } else if (this.buf.length > 0 && !this.eof) {
        return null;
      } else {
        this.first = false;
      }
    }

    const buf = this.buf;
    const fields: string[] = [];
    const parts: Buffer[] = [];
    let segStart = start;
    let state = State.FieldStart;
    let i = start;

    const pushField = (end: number): void => {
      if (end > segStart) parts.push(buf.subarray(segStart, end));
      fields.push(
        parts.length === 0
          ? ""
          : parts.length === 1
            ? parts[0].toString("utf8")
            : Buffer.concat(parts).toString("utf8"),
      );
      parts.length = 0;
    };

    while (i < buf.length) {
      const b = buf[i];
      if (state === State.FieldStart) {
        if (b === QUOTE) {
          state = State.InQuoted;
          i++;
          segStart = i;
        } else if (b === COMMA) {
          pushField(i);
          i++;
          segStart = i;
        } else if (b === CR || b === LF) {
          pushField(i);
          return this.finish(buf, fields, i);
        } else {
          state = State.InUnquoted;
          i++;
        }
      } else if (state === State.InUnquoted) {
        if (b === COMMA) {
          pushField(i);
          i++;
          segStart = i;
          state = State.FieldStart;
        } else if (b === CR || b === LF) {
          pushField(i);
          return this.finish(buf, fields, i);
        } else {
          i++;
        }
      } else if (state === State.InQuoted) {
        if (b === QUOTE) {
          if (i > segStart) parts.push(buf.subarray(segStart, i));
          state = State.QuoteInQuoted;
          i++;
          segStart = i;
        } else {
          i++;
        }
      } else {
        if (b === QUOTE) {
          parts.push(QUOTE_BUF);
          i++;
          segStart = i;
          state = State.InQuoted;
        } else if (b === COMMA) {
          pushField(i);
          i++;
          segStart = i;
          state = State.FieldStart;
        } else if (b === CR || b === LF) {
          pushField(i);
          return this.finish(buf, fields, i);
        } else {
          state = State.InUnquoted;
          i++;
        }
      }
    }

    if (!this.eof) return null;
    if (i === start && fields.length === 0 && parts.length === 0) return null;
    if (state !== State.InQuoted) pushField(i);
    this.buf = buf.subarray(i);
    return { fields, bytesConsumed: i };
  }

  private finish(
    buf: Buffer,
    fields: string[],
    termIdx: number,
  ): ParsedRecord | null {
    let end = termIdx + 1;
    if (buf[termIdx] === CR) {
      if (end === buf.length) {
        if (!this.eof) return null;
      } else if (buf[end] === LF) {
        end++;
      }
    }
    this.buf = buf.subarray(end);
    return { fields, bytesConsumed: end };
  }
}
