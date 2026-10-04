/** SIGHASH base types. */
export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;

export type SigHashType =
  | typeof SIGHASH_ALL
  | typeof SIGHASH_NONE
  | typeof SIGHASH_SINGLE
  | 0x81 // ALL | ANYONECANPAY
  | 0x82 // NONE | ANYONECANPAY
  | 0x83; // SINGLE | ANYONECANPAY

/** Digest algorithm mode. */
export enum SignatureMode {
  /** Pre-SegWit legacy algorithm. */
  Legacy = "legacy",
  /** BIP143 algorithm for SegWit v0 inputs. */
  Bip143 = "bip143",
}

export interface TxInput {
  /** Previous transaction hash, 32 bytes, internal (little-endian) order. */
  prevTxId: Buffer;
  /** Previous output index. */
  prevOutIndex: number;
  /** scriptSig as present in the transaction (not committed by new digests). */
  scriptSig: Buffer;
  sequence: number;
}

export interface TxOutput {
  /** Value in satoshis, full 64-bit width preserved. */
  value: bigint;
  scriptPubKey: Buffer;
}

export interface Transaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** Per-input witness stacks (empty array when the tx has no witness). */
  witnesses: Buffer[][];
  locktime: number;
}

export interface SighashContext {
  /** Serialized transaction, legacy or witness format. */
  rawTransaction: Buffer;
  /** Index of the input being signed. */
  inputIndex: number;
  /** Digest algorithm. */
  mode: SignatureMode;
  /** Full signature script (scriptCode), already resolved by the caller. */
  scriptCode: Buffer;
  /** Value of the previous output in satoshis (used by BIP143 only). */
  prevOutValue: bigint;
  /** One of the six supported sighash combinations. */
  sigHashType: SigHashType;
  /**
   * Byte offset within `scriptCode` of the last executed OP_CODESEPARATOR
   * before this signature check, or null if none was executed.
   */
  lastCodeSeparatorOffset: number | null;
}
