import { Mp3ProbeError } from "./errors";
import { SAMPLES_PER_FRAME, FrameHeader } from "./tables";
import { parseFrameHeader, xingOffset } from "./frame";
import { parseId3v2Header, checkId3v2Footer, Id3v2Header } from "./id3";
import { parseXing, xingBodyLength } from "./xing";

export interface Mp3ProbeResult {
  sampleRate: number;
  audioFrames: number;
  playableSamples: number;
  inRange: boolean;
}

const enum State {
  Start,
  Id3v2Header,
  Id3v2Body,
  Id3v2Footer,
  FrameHeader,
  XingProbe,
  FrameBody,
  Id3v1,
  Done,
}

const MIN_PLAYABLE_PER_SECOND = 30;
const MAX_PLAYABLE_PER_SECOND = 600;
const BUF_CAPACITY = 256;

export class Mp3Probe {
  private state: State = State.Start;
  private buf = new Uint8Array(BUF_CAPACITY);
  private len = 0;
  private need = 3;
  private skipRemaining = 0;
  private finished = false;

  private id3v2: Id3v2Header | null = null;
  private currentFrame: FrameHeader | null = null;
  private isFirstFrame = true;

  private sampleRate = 0;
  private channels = 0;
  private audioFrames = 0;
  private totalMpegBytes = 0;

  private hasXing = false;
  private encoderDelay = 0;
  private endPadding = 0;
  private declaredFrames: number | null = null;
  private declaredBytes: number | null = null;

  /** Bytes currently retained by the probe (bounded, well under 64 KiB). */
  get bufferedBytes(): number {
    return this.len;
  }

  push(chunk: Uint8Array): void {
    if (this.finished) {
      throw new Mp3ProbeError("ERR_PUSH_AFTER_FINISH", "push after finish");
    }
    let off = 0;
    for (;;) {
      if (this.state === State.Done) {
        if (off < chunk.length) {
          throw new Mp3ProbeError("ERR_TRAILING_GARBAGE", "bytes after ID3v1 tag");
        }
        return;
      }
      if (this.skipRemaining > 0) {
        if (off < chunk.length) {
          const take = Math.min(this.skipRemaining, chunk.length - off);
          off += take;
          this.skipRemaining -= take;
          if (this.skipRemaining === 0) this.onSkipDone();
          continue;
        }
        return;
      }
      if (this.len < this.need) {
        const avail = chunk.length - off;
        if (avail <= 0) return;
        const take = Math.min(this.need - this.len, avail);
        this.buf.set(chunk.subarray(off, off + take), this.len);
        this.len += take;
        off += take;
        if (this.len < this.need) return;
      }
      this.process();
    }
  }

  finish(): Mp3ProbeResult {
    if (this.finished) {
      throw new Mp3ProbeError("ERR_PUSH_AFTER_FINISH", "finish called twice");
    }
    this.finished = true;
    switch (this.state) {
      case State.Start:
        if (this.len === 0) throw new Mp3ProbeError("ERR_NO_AUDIO", "empty input");
        throw new Mp3ProbeError("ERR_UNEXPECTED_EOF", "truncated input");
      case State.Id3v2Header:
      case State.Id3v2Body:
      case State.Id3v2Footer:
        throw new Mp3ProbeError("ERR_UNEXPECTED_EOF", "truncated ID3v2 tag");
      case State.FrameHeader:
        if (this.len !== 0) {
          // A partial header that cannot start a frame or ID3v1 tag is
          // trailing garbage; a plausible prefix is a truncation.
          const b0 = this.buf[0]!;
          const looksLikeFrame = b0 === 0xff;
          const looksLikeTag =
            b0 === 0x54 && (this.len < 2 || this.buf[1] === 0x41) &&
            (this.len < 3 || this.buf[2] === 0x47);
          if (looksLikeFrame || looksLikeTag) {
            throw new Mp3ProbeError("ERR_UNEXPECTED_EOF", "truncated frame header");
          }
          throw new Mp3ProbeError("ERR_FRAME_HEADER", "trailing garbage after last frame");
        }
        break;
      case State.XingProbe:
      case State.FrameBody:
        throw new Mp3ProbeError("ERR_FRAME_TRUNCATED", "truncated frame body");
      case State.Id3v1:
        throw new Mp3ProbeError("ERR_ID3V1", "truncated ID3v1 tag");
      case State.Done:
        break;
    }
    if (this.audioFrames === 0) {
      throw new Mp3ProbeError("ERR_NO_AUDIO", "no audio frames");
    }
    if (this.hasXing) {
      if (this.declaredFrames !== null && this.declaredFrames !== this.audioFrames) {
        throw new Mp3ProbeError(
          "ERR_XING_MISMATCH",
          `Xing declares ${this.declaredFrames} frames, found ${this.audioFrames}`,
        );
      }
      if (this.declaredBytes !== null && this.declaredBytes !== this.totalMpegBytes) {
        throw new Mp3ProbeError(
          "ERR_XING_MISMATCH",
          `Xing declares ${this.declaredBytes} bytes, found ${this.totalMpegBytes}`,
        );
      }
    }
    const trim = this.hasXing ? this.encoderDelay + this.endPadding : 0;
    const playableSamples = this.audioFrames * SAMPLES_PER_FRAME - trim;
    if (playableSamples < 0) {
      throw new Mp3ProbeError("ERR_NO_AUDIO", "encoder delay/padding exceed total samples");
    }
    const inRange =
      playableSamples >= MIN_PLAYABLE_PER_SECOND * this.sampleRate &&
      playableSamples <= MAX_PLAYABLE_PER_SECOND * this.sampleRate;
    return {
      sampleRate: this.sampleRate,
      audioFrames: this.audioFrames,
      playableSamples,
      inRange,
    };
  }

  private consume(count: number): void {
    this.buf.copyWithin(0, count, this.len);
    this.len -= count;
  }

  private onSkipDone(): void {
    switch (this.state) {
      case State.Id3v2Body:
        if (this.id3v2!.footerPresent) {
          this.state = State.Id3v2Footer;
          this.need = 10;
        } else {
          this.state = State.FrameHeader;
          this.need = 4;
        }
        break;
      case State.FrameBody:
        this.state = State.FrameHeader;
        this.need = 4;
        break;
      default:
        throw new Mp3ProbeError("ERR_UNEXPECTED_EOF", "internal skip state error");
    }
  }

  private process(): void {
    switch (this.state) {
      case State.Start:
        if (this.buf[0] === 0x49 && this.buf[1] === 0x44 && this.buf[2] === 0x33) {
          this.state = State.Id3v2Header;
          this.need = 10;
        } else {
          this.state = State.FrameHeader;
          this.need = 4;
        }
        break;
      case State.Id3v2Header: {
        this.id3v2 = parseId3v2Header(this.buf, 0);
        this.consume(10);
        this.state = State.Id3v2Body;
        this.skipRemaining = this.id3v2.bodySize;
        if (this.skipRemaining === 0) this.onSkipDone();
        break;
      }
      case State.Id3v2Footer:
        checkId3v2Footer(this.buf, 0, this.id3v2!);
        this.consume(10);
        this.state = State.FrameHeader;
        this.need = 4;
        break;
      case State.FrameHeader:
        this.processFrameHeader();
        break;
      case State.XingProbe:
        this.processXingProbe();
        break;
      case State.Id3v1:
        this.consume(128);
        this.state = State.Done;
        break;
      default:
        throw new Mp3ProbeError("ERR_UNEXPECTED_EOF", "internal state error");
    }
  }

  private processFrameHeader(): void {
    if (this.buf[0] !== 0xff) {
      if (this.buf[0] === 0x54 && this.buf[1] === 0x41 && this.buf[2] === 0x47) {
        this.state = State.Id3v1;
        this.need = 128;
        return;
      }
      throw new Mp3ProbeError("ERR_FRAME_HEADER", "expected frame sync");
    }
    const header = parseFrameHeader(this.buf, 0);
    if (this.isFirstFrame) {
      this.sampleRate = header.sampleRate;
      this.channels = header.channels;
    } else if (header.sampleRate !== this.sampleRate || header.channels !== this.channels) {
      throw new Mp3ProbeError(
        "ERR_INCONSISTENT_FORMAT",
        "sample rate or channel count changed mid-stream",
      );
    }
    this.consume(4);
    this.totalMpegBytes += header.frameLength;
    this.currentFrame = header;
    if (this.isFirstFrame) {
      this.state = State.XingProbe;
      this.need = xingOffset(header) + 8 - 4;
    } else {
      this.audioFrames += 1;
      this.state = State.FrameBody;
      this.skipRemaining = header.frameLength - 4;
      if (this.skipRemaining === 0) this.onSkipDone();
    }
  }

  private processXingProbe(): void {
    const header = this.currentFrame!;
    const markerOff = xingOffset(header) - 4;
    const isXing =
      (this.buf[markerOff] === 0x58 && this.buf[markerOff + 1] === 0x69 &&
        this.buf[markerOff + 2] === 0x6e && this.buf[markerOff + 3] === 0x67) || // Xing
      (this.buf[markerOff] === 0x49 && this.buf[markerOff + 1] === 0x6e &&
        this.buf[markerOff + 2] === 0x66 && this.buf[markerOff + 3] === 0x6f); // Info
    if (!isXing) {
      this.isFirstFrame = false;
      this.audioFrames += 1;
      this.consume(this.need);
      this.state = State.FrameBody;
      this.skipRemaining = header.frameLength - 4 - this.need;
      if (this.skipRemaining === 0) this.onSkipDone();
      return;
    }
    if (this.need === xingOffset(header) + 8 - 4) {
      const flags =
        ((this.buf[markerOff + 4]! << 24) |
          (this.buf[markerOff + 5]! << 16) |
          (this.buf[markerOff + 6]! << 8) |
          this.buf[markerOff + 7]!) >>>
        0;
      const total = xingOffset(header) + 4 + xingBodyLength(flags);
      if (total > header.frameLength) {
        throw new Mp3ProbeError("ERR_XING", "Xing block exceeds frame length");
      }
      this.need = total - 4;
      return;
    }
    const info = parseXing(this.buf, markerOff);
    this.hasXing = true;
    this.encoderDelay = info.encoderDelay;
    this.endPadding = info.endPadding;
    this.declaredFrames = info.declaredFrames;
    this.declaredBytes = info.declaredBytes;
    this.isFirstFrame = false;
    this.consume(this.need);
    this.state = State.FrameBody;
    this.skipRemaining = header.frameLength - 4 - this.need;
    if (this.skipRemaining === 0) this.onSkipDone();
  }
}

export { Mp3ProbeError } from "./errors";
export type { Mp3ProbeErrorCode } from "./errors";
