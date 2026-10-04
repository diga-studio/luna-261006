#!/usr/bin/env python3
"""Independent reference implementation used to generate test/vectors.ts
(expected digests + fixtures). Not part of `npm test`."""
import hashlib
import struct

ZERO32 = b"\x00" * 32


def sha256d(b: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()


def varint(n: int) -> bytes:
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def varbytes(b: bytes) -> bytes:
    return varint(len(b)) + b


SEP = 0xAB


def subscript(script: bytes, last_sep, mode: str) -> bytes:
    start = 0
    if last_sep is not None:
        assert script[last_sep] == SEP
        start = last_sep + 1
    if mode == "bip143":
        return script[start:]
    out = bytearray()
    i = start
    while i < len(script):
        op = script[i]
        if op == SEP:
            i += 1
            continue
        dlen, llen = 0, 0
        if 1 <= op <= 0x4B:
            dlen = op
        elif op == 0x4C:
            llen = 1
        elif op == 0x4D:
            llen = 2
        elif op == 0x4E:
            llen = 4
        if llen:
            dlen = int.from_bytes(script[i + 1 : i + 1 + llen], "little")
        end = i + 1 + llen + dlen
        assert end <= len(script)
        out += script[i:end]
        i = end
    return bytes(out)


def make_tx(version, inputs, outputs, locktime):
    return {"version": version, "inputs": inputs,
            "outputs": outputs, "locktime": locktime}


def serialize(tx, witnesses=None):
    out = struct.pack("<i", tx["version"])
    if witnesses is not None:
        out += b"\x00\x01"
    out += varint(len(tx["inputs"]))
    for inp in tx["inputs"]:
        out += inp["prev"] + struct.pack("<I", inp["vout"])
        out += varbytes(inp["scriptSig"])
        out += struct.pack("<I", inp["sequence"])
    out += varint(len(tx["outputs"]))
    for val, spk in tx["outputs"]:
        out += struct.pack("<Q", val) + varbytes(spk)
    if witnesses is not None:
        for stack in witnesses:
            out += varint(len(stack))
            for item in stack:
                out += varbytes(item)
    out += struct.pack("<I", tx["locktime"])
    return out


def legacy_sighash(tx, idx, script, hashtype):
    base = hashtype & 0x1F
    if base == 3 and idx >= len(tx["outputs"]):
        return b"\x01" + b"\x00" * 31
    inputs = [dict(inp, scriptSig=b"") for inp in tx["inputs"]]
    inputs[idx]["scriptSig"] = script
    outputs = list(tx["outputs"])
    if base == 2:
        outputs = []
        inputs = [inp if i == idx else dict(inp, sequence=0)
                  for i, inp in enumerate(inputs)]
    elif base == 3:
        outputs = [outputs[i] if i == idx else (0xFFFFFFFFFFFFFFFF, b"")
                   for i in range(idx + 1)]
        inputs = [inp if i == idx else dict(inp, sequence=0)
                  for i, inp in enumerate(inputs)]
    if hashtype & 0x80:
        inputs = [inputs[idx]]
    ser = struct.pack("<i", tx["version"]) + varint(len(inputs))
    for inp in inputs:
        ser += inp["prev"] + struct.pack("<I", inp["vout"])
        ser += varbytes(inp["scriptSig"])
        ser += struct.pack("<I", inp["sequence"])
    ser += varint(len(outputs))
    for val, spk in outputs:
        ser += struct.pack("<Q", val) + varbytes(spk)
    ser += struct.pack("<I", tx["locktime"]) + struct.pack("<I", hashtype)
    return sha256d(ser)


def bip143_sighash(tx, idx, script, value, hashtype):
    base = hashtype & 0x1F
    acp = bool(hashtype & 0x80)
    hp = ZERO32 if acp else sha256d(b"".join(
        inp["prev"] + struct.pack("<I", inp["vout"]) for inp in tx["inputs"]))
    hs = ZERO32 if (acp or base in (2, 3)) else sha256d(b"".join(
        struct.pack("<I", inp["sequence"]) for inp in tx["inputs"]))
    if base == 1:
        ho = sha256d(b"".join(struct.pack("<Q", v) + varbytes(s)
                              for v, s in tx["outputs"]))
    elif base == 3 and idx < len(tx["outputs"]):
        v, s = tx["outputs"][idx]
        ho = sha256d(struct.pack("<Q", v) + varbytes(s))
    else:
        ho = ZERO32
    inp = tx["inputs"][idx]
    pre = (struct.pack("<i", tx["version"]) + hp + hs
           + inp["prev"] + struct.pack("<I", inp["vout"])
           + varbytes(script) + struct.pack("<Q", value)
           + struct.pack("<I", inp["sequence"]) + ho
           + struct.pack("<I", tx["locktime"]) + struct.pack("<I", hashtype))
    return sha256d(pre)


P2PKH_SPK = bytes.fromhex("76a914" + "03" * 20 + "88ac")

TX_A = make_tx(
    1,
    [{"prev": b"\x11" * 32, "vout": 0, "scriptSig": bytes([0x51, 0x52]),
      "sequence": 0xFFFFFFFE},
     {"prev": b"\x22" * 32, "vout": 1, "scriptSig": b"",
      "sequence": 0xFFFFFFFF}],
    [(50000, P2PKH_SPK), (100000, bytes([0x6A]))],
    0,
)
TX_C = make_tx(
    2,
    [{"prev": b"\x33" * 32, "vout": 2, "scriptSig": bytes([0x51]),
      "sequence": 0xFFFFFFFD},
     {"prev": b"\x44" * 32, "vout": 3, "scriptSig": b"",
      "sequence": 0xFFFFFFFF}],
    [(70000, P2PKH_SPK)],
    900000,
)
TX_W = make_tx(
    2,
    [{"prev": b"\x55" * 32, "vout": 0, "scriptSig": b"",
      "sequence": 0xFFFFFFFF}],
    [(123456789, P2PKH_SPK)],
    500000,
)
WITNESSES = [[bytes.fromhex("deadbeef"), bytes([0x01, 0x02])]]

CODESEP_SCRIPT = bytes([SEP, 0x02, SEP, SEP, 0x51, SEP, 0x52])
PLAIN_SCRIPT = P2PKH_SPK

ALL, NONE, SINGLE, ACP = 1, 2, 3, 0x80

CASES = [
    # name, mode, tx, idx, script, last_sep, value, hashtype
    ("legacyAllTxAIn0", "legacy", TX_A, 0, PLAIN_SCRIPT, None, 0, ALL),
    ("legacyNoneTxAIn1", "legacy", TX_A, 1, PLAIN_SCRIPT, None, 0, NONE),
    ("legacySingleTxAIn1", "legacy", TX_A, 1, PLAIN_SCRIPT, None, 0, SINGLE),
    ("legacyAllAcpTxAIn1", "legacy", TX_A, 1, PLAIN_SCRIPT, None, 0, ALL | ACP),
    ("legacyNoneAcpTxAIn0", "legacy", TX_A, 0, PLAIN_SCRIPT, None, 0, NONE | ACP),
    ("legacySingleAcpTxAIn1", "legacy", TX_A, 1, PLAIN_SCRIPT, None, 0, SINGLE | ACP),
    ("legacySingleMissingTxCIn1", "legacy", TX_C, 1, PLAIN_SCRIPT, None, 0, SINGLE),
    ("legacySingleAcpMissingTxCIn1", "legacy", TX_C, 1, PLAIN_SCRIPT, None, 0, SINGLE | ACP),
    ("legacyCodesepAt0TxAIn0", "legacy", TX_A, 0, CODESEP_SCRIPT, 0, 0, ALL),
    ("legacyCodesepAt5TxAIn0", "legacy", TX_A, 0, CODESEP_SCRIPT, 5, 0, ALL),
    ("legacyCodesepNullTxAIn0", "legacy", TX_A, 0, CODESEP_SCRIPT, None, 0, ALL),
    ("bip143AllTxAIn0", "bip143", TX_A, 0, PLAIN_SCRIPT, None, 50000, ALL),
    ("bip143NoneTxAIn1", "bip143", TX_A, 1, PLAIN_SCRIPT, None, 100000, NONE),
    ("bip143SingleTxAIn1", "bip143", TX_A, 1, PLAIN_SCRIPT, None, 100000, SINGLE),
    ("bip143AllAcpTxAIn1", "bip143", TX_A, 1, PLAIN_SCRIPT, None, 100000, ALL | ACP),
    ("bip143NoneAcpTxAIn0", "bip143", TX_A, 0, PLAIN_SCRIPT, None, 50000, NONE | ACP),
    ("bip143SingleAcpTxAIn1", "bip143", TX_A, 1, PLAIN_SCRIPT, None, 100000, SINGLE | ACP),
    ("bip143SingleMissingTxCIn1", "bip143", TX_C, 1, PLAIN_SCRIPT, None, 70000, SINGLE),
    ("bip143SingleAcpMissingTxCIn1", "bip143", TX_C, 1, PLAIN_SCRIPT, None, 70000, SINGLE | ACP),
    ("bip143CodesepAt0TxAIn0", "bip143", TX_A, 0, CODESEP_SCRIPT, 0, 50000, ALL),
    ("bip143CodesepAt5TxAIn0", "bip143", TX_A, 0, CODESEP_SCRIPT, 5, 50000, ALL),
    ("bip143CodesepNullTxAIn0", "bip143", TX_A, 0, CODESEP_SCRIPT, None, 50000, ALL),
    ("bip143AllTxWMaxUint64", "bip143", TX_W, 0, PLAIN_SCRIPT, None,
     0xFFFFFFFFFFFFFFFF, ALL),
]

TX_HEX = {
    "TX_A": serialize(TX_A).hex(),
    "TX_C": serialize(TX_C).hex(),
    "TX_W": serialize(TX_W, WITNESSES).hex(),
    "TX_W_STRIPPED": serialize(TX_W).hex(),
}


def digest_of(mode, tx, idx, script, last_sep, value, hashtype):
    sub = subscript(script, last_sep, mode)
    if mode == "legacy":
        return legacy_sighash(tx, idx, sub, hashtype)
    return bip143_sighash(tx, idx, sub, value, hashtype)


def main():
    lines = []
    lines.append("// Generated by test/gen_vectors.py. Do not edit by hand.")
    lines.append("export const TX_HEX = {")
    for name, h in TX_HEX.items():
        lines.append(f'  {name}: "{h}",')
    lines.append("} as const;")
    lines.append("")
    lines.append(f'export const CODESEP_SCRIPT_HEX = "{CODESEP_SCRIPT.hex()}";')
    lines.append(f'export const PLAIN_SCRIPT_HEX = "{PLAIN_SCRIPT.hex()}";')
    lines.append("")
    lines.append("export interface Vector {")
    lines.append("  name: string;")
    lines.append('  mode: "legacy" | "bip143";')
    lines.append("  tx: keyof typeof TX_HEX;")
    lines.append("  inputIndex: number;")
    lines.append("  script: string;")
    lines.append("  lastCodeSeparatorOffset: number | null;")
    lines.append("  prevOutValue: bigint;")
    lines.append("  hashType: number;")
    lines.append("  expected: string;")
    lines.append("}")
    lines.append("")
    lines.append("export const VECTORS: Vector[] = [")
    for name, mode, tx, idx, script, last_sep, value, ht in CASES:
        txname = {id(TX_A): "TX_A", id(TX_C): "TX_C", id(TX_W): "TX_W"}[id(tx)]
        d = digest_of(mode, tx, idx, script, last_sep, value, ht).hex()
        sep = "null" if last_sep is None else str(last_sep)
        script_hex = script.hex()
        lines.append("  {")
        lines.append(f'    name: "{name}",')
        lines.append(f'    mode: "{mode}",')
        lines.append(f'    tx: "{txname}",')
        lines.append(f"    inputIndex: {idx},")
        lines.append(f'    script: "{script_hex}",')
        lines.append(f"    lastCodeSeparatorOffset: {sep},")
        lines.append(f"    prevOutValue: {value}n,")
        lines.append(f"    hashType: {ht},")
        lines.append(f'    expected: "{d}",')
        lines.append("  },")
    lines.append("];")
    lines.append("")
    with open("test/vectors.ts", "w") as f:
        f.write("\n".join(lines))
    print("wrote test/vectors.ts")


if __name__ == "__main__":
    main()
