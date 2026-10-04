/** Base signature hash types (low 5 bits). */
export enum HashTypeBase {
  ALL = 0x01,
  NONE = 0x02,
  SINGLE = 0x03,
}

export const SIGHASH_ANYONECANPAY = 0x80;

/** The six supported hash type combinations. */
export type HashType =
  | HashTypeBase.ALL
  | HashTypeBase.NONE
  | HashTypeBase.SINGLE
  | 0x81 // ALL | ANYONECANPAY
  | 0x82 // NONE | ANYONECANPAY
  | 0x83; // SINGLE | ANYONECANPAY

export type SigHashMode = "legacy" | "bip143";

export interface TxInput {
  /** Previous transaction hash, 32 bytes in internal (little-endian) order. */
  prevTxHash: Uint8Array;
  prevOutIndex: number;
  scriptSig: Uint8Array;
  sequence: number;
}

export interface TxOutput {
  /** Value in satoshis; full 64-bit width preserved. */
  value: bigint;
  scriptPubKey: Uint8Array;
}

export interface Transaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** Witness stacks per input; empty arrays when the tx has no witness. */
  witnesses: Uint8Array[][];
  locktime: number;
  /** True if the serialization carried the segwit marker/flag. */
  hasWitness: boolean;
}

export interface DigestRequest {
  /** Fully serialized transaction (legacy or witness format). */
  serializedTx: Uint8Array;
  /** Index of the input being signed. */
  inputIndex: number;
  mode: SigHashMode;
  /** Complete signature script (scriptCode), already resolved by the caller. */
  scriptCode: Uint8Array;
  /** Value of the previous output in satoshis (required for bip143). */
  prevOutValue: bigint;
  hashType: HashType;
  /**
   * Byte offset within scriptCode of the last executed OP_CODESEPARATOR
   * before this signature check, or null if none was executed.
   */
  lastCodeSeparatorOffset: number | null;
}
