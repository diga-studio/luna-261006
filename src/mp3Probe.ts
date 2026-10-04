import { Mp3ProbeError } from './errors';
import { parseFrameHeader, SAMPLES_PER_FRAME } from './frameHeader';
import { parseXing, XingInfo } from './xing';
import { parseId3v2Header, checkId3v2Footer, checkId3v1, Id3v2Header } from './id3';

export interface Mp3ProbeResult {
  sampleRate: number;
  audioFrames: number;
  playableSamples: number;
  inRange: boolean;
}

const MIN_PLAYABLE_SECONDS = 30;
const MAX_PLAYABLE_SECONDS = 600;

type State =
  | 'start'
  | 'id3v2Header'
  | 'id3v2Body'
  | 'id3v2Footer'
  | 'frameHeader'
  | 'frameBody'
  | 'id3v1'
  | 'end';

export class Mp3Probe {
  private state: State = 'start';
  private token = new Uint8Array(3);
  private tokenLen = 0;
  private tokenNeed = 3;
  private skipRemaining = 0;

  private id3Header: Id3v2Header | null = null;
  private sampleRate = 0;
  private channels = 0;
  private mpegFrames = 0;
  private mpegBytes = 0;
  private audioFrames = 0;
  private xing: XingInfo | null = null;
  private closed = false;

  push(chunk: Uint8Array): void {
    this.ensureOpen();
    if (chunk.length === 0) {
      return;
    }
    let pos = 0;
    while (pos < chunk.length) {
      if (this.state === 'id3v2Body' || this.state === 'frameBody') {
        pos = this.consumeSkip(chunk, pos);
      } else if (this.state === 'end') {
        throw new Mp3ProbeError('UNEXPECTED_DATA_AFTER_ID3V1', 'data after ID3v1 tag');
      } else {
        pos = this.consumeToken(chunk, pos);
      }
    }
  }

  finish(): Mp3ProbeResult {
    this.ensureOpen();
    this.closed = true;
    this.checkCleanEnd();
    if (this.mpegFrames === 0 || this.audioFrames === 0) {
      throw new Mp3ProbeError('NO_AUDIO_FRAMES', 'no audio frames found');
    }
    let playableSamples: number;
    if (this.xing !== null) {
      if (this.xing.declaredFrames !== null && this.xing.declaredFrames !== this.audioFrames) {
        throw new Mp3ProbeError('XING_COUNT_MISMATCH', 'Xing frame count mismatch');
      }
      if (this.xing.declaredBytes !== null && this.xing.declaredBytes !== this.mpegBytes) {
        throw new Mp3ProbeError('XING_COUNT_MISMATCH', 'Xing byte count mismatch');
      }
      playableSamples = this.audioFrames * SAMPLES_PER_FRAME - this.xing.encoderDelay - this.xing.endPadding;
      if (playableSamples < 0) {
        throw new Mp3ProbeError('NEGATIVE_PLAYABLE', 'encoder delay/padding exceed audio');
      }
    } else {
      playableSamples = this.audioFrames * SAMPLES_PER_FRAME;
    }
    const lower = MIN_PLAYABLE_SECONDS * this.sampleRate;
    const upper = MAX_PLAYABLE_SECONDS * this.sampleRate;
    return {
      sampleRate: this.sampleRate,
      audioFrames: this.audioFrames,
      playableSamples,
      inRange: playableSamples >= lower && playableSamples <= upper,
    };
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Mp3ProbeError('TRAILING_GARBAGE', 'probe already finished');
    }
  }

  private consumeSkip(chunk: Uint8Array, pos: number): number {
    const take = Math.min(this.skipRemaining, chunk.length - pos);
    this.skipRemaining -= take;
    const newPos = pos + take;
    if (this.state === 'frameBody' && this.capture !== null) {
      this.capture.set(chunk.subarray(pos, newPos), this.captureLen);
      this.captureLen += take;
    }
    if (this.skipRemaining === 0) {
      if (this.state === 'id3v2Body') {
        this.state = this.id3Header!.hasFooter ? 'id3v2Footer' : 'frameHeader';
        this.beginToken(this.state === 'id3v2Footer' ? 10 : 4);
      } else {
        this.onFrameComplete();
      }
    }
    return newPos;
  }

  private consumeToken(chunk: Uint8Array, pos: number): number {
    const take = Math.min(this.tokenNeed - this.tokenLen, chunk.length - pos);
    this.token.set(chunk.subarray(pos, pos + take), this.tokenLen);
    this.tokenLen += take;
    const newPos = pos + take;
    if (this.tokenLen === this.tokenNeed) {
      const complete = this.token;
      this.token = new Uint8Array(0);
      this.tokenLen = 0;
      this.onToken(complete);
    }
    return newPos;
  }

  private beginToken(need: number, seed?: Uint8Array): void {
    this.token = new Uint8Array(need);
    this.tokenNeed = need;
    this.tokenLen = 0;
    if (seed !== undefined) {
      this.token.set(seed, 0);
      this.tokenLen = seed.length;
    }
  }

  private onToken(t: Uint8Array): void {
    switch (this.state) {
      case 'start': {
        if (t[0] === 0x49 && t[1] === 0x44 && t[2] === 0x33) {
          this.state = 'id3v2Header';
          this.beginToken(7, undefined);
          this.id3Prefix = t;
        } else {
          this.state = 'frameHeader';
          this.beginToken(4, t);
        }
        break;
      }
      case 'id3v2Header': {
        const full = new Uint8Array(10);
        full.set(this.id3Prefix!, 0);
        full.set(t, 3);
        this.id3Prefix = null;
        this.id3Header = parseId3v2Header(full);
        this.state = 'id3v2Body';
        this.skipRemaining = this.id3Header.bodyLength;
        if (this.skipRemaining === 0) {
          this.state = this.id3Header.hasFooter ? 'id3v2Footer' : 'frameHeader';
          this.beginToken(this.state === 'id3v2Footer' ? 10 : 4);
        }
        break;
      }
      case 'id3v2Footer': {
        checkId3v2Footer(t, this.id3Header!);
        this.state = 'frameHeader';
        this.beginToken(4);
        break;
      }
      case 'frameHeader': {
        this.onFrameHeader(t);
        break;
      }
      case 'id3v1': {
        checkId3v1(t);
        this.state = 'end';
        break;
      }
      default:
        throw new Mp3ProbeError('FRAME_HEADER_INVALID', 'unexpected parser state');
    }
  }

  private id3Prefix: Uint8Array | null = null;

  private onFrameHeader(t: Uint8Array): void {
    let header;
    try {
      header = parseFrameHeader(t[0]!, t[1]!, t[2]!, t[3]!);
    } catch (err) {
      if (
        err instanceof Mp3ProbeError &&
        err.code === 'FRAME_HEADER_INVALID' &&
        t[0] === 0x54 && t[1] === 0x41 && t[2] === 0x47 // "TAG"
      ) {
        this.state = 'id3v1';
        this.beginToken(128, t);
        return;
      }
      throw err;
    }
    if (this.mpegFrames === 0) {
      this.sampleRate = header.sampleRate;
      this.channels = header.channels;
    } else if (header.sampleRate !== this.sampleRate || header.channels !== this.channels) {
      throw new Mp3ProbeError('INCONSISTENT_STREAM', 'sample rate or channels changed');
    }
    this.pendingFrameLength = header.frameLength;
    this.pendingFrameHeader = t;
    this.state = 'frameBody';
    this.skipRemaining = header.frameLength - 4;
    if (this.mpegFrames === 0) {
      this.capture = new Uint8Array(header.frameLength);
      this.capture.set(t, 0);
      this.captureLen = 4;
    }
  }

  private pendingFrameLength = 0;
  private pendingFrameHeader: Uint8Array | null = null;
  private capture: Uint8Array | null = null;
  private captureLen = 0;

  private onFrameComplete(): void {
    const frameLength = this.pendingFrameLength;
    this.mpegFrames += 1;
    this.mpegBytes += frameLength;
    if (this.mpegFrames === 1) {
      const captured = this.capture!;
      this.capture = null;
      const xing = parseXing(captured, (this.pendingFrameHeader![3]! >> 6) & 0x3);
      if (xing !== null) {
        this.xing = xing;
      } else {
        this.audioFrames += 1;
      }
    } else {
      this.audioFrames += 1;
    }
    this.pendingFrameHeader = null;
    this.state = 'frameHeader';
    this.beginToken(4);
  }

  private checkCleanEnd(): void {
    switch (this.state) {
      case 'frameHeader':
        if (this.tokenLen !== 0) {
          throw new Mp3ProbeError('FRAME_TRUNCATED', 'partial frame header at end of input');
        }
        return;
      case 'start':
        if (this.tokenLen !== 0) {
          throw new Mp3ProbeError('FRAME_TRUNCATED', 'truncated input');
        }
        return;
      case 'frameBody':
        throw new Mp3ProbeError('FRAME_TRUNCATED', 'truncated frame body');
      case 'id3v2Header':
      case 'id3v2Body':
        throw new Mp3ProbeError('ID3V2_INVALID', 'truncated ID3v2 tag');
      case 'id3v2Footer':
        throw new Mp3ProbeError('ID3V2_FOOTER_MISMATCH', 'truncated ID3v2 footer');
      case 'id3v1':
        throw new Mp3ProbeError('ID3V1_INVALID', 'truncated ID3v1 tag');
      case 'end':
        return;
    }
  }
}
