#!/usr/bin/env python3
"""Independent reference implementation (written from the consensus rules,
not from the TypeScript sources) used to generate test/vectors.json.

This script is NOT part of `npm test`; it only regenerates the committed
known-answer vectors. Run: python3 test/gen_vectors.py > test/vectors.json
"""
import hashlib
import json
import struct

ZERO32 = b"\x00" * 32
SEP = 0xAB


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


def subscript(script: bytes, last_sep, legacy: bool) -> bytes:
    start = 0 if last_sep is None else last_sep + 1
    if not legacy:
        return script[start:]
    out = bytearray()
    i = start
    while i < len(script):
        op = script[i]
        if op == SEP:
            i += 1
            continue
        if 1 <= op <= 0x4B:
            end = i + 1 + op
        elif op in (0x4C, 0x4D, 0x4E):
            llen = {0x4C: 1, 0x4D: 2, 0x4E: 4}[op]
            dlen = int.from_bytes(script[i + 1 : i + 1 + llen], "little")
            end = i + 1 + llen + dlen
        else:
            end = i + 1
        assert end <= len(script)
        out += script[i:end]
        i = end
    return bytes(out)


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
        return (b"\x01" + b"\x00" * 31).hex()
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
        ser += varbytes(inp["scriptSig"]) + struct.pack("<I", inp["sequence"])
    ser += varint(len(outputs))
    for val, spk in outputs:
        ser += struct.pack("<Q", val) + varbytes(spk)
    ser += struct.pack("<I", tx["locktime"]) + struct.pack("<I", hashtype)
    return sha256d(ser).hex()


def bip143_sighash(tx, idx, script, value, hashtype):
    base = hashtype & 0x1F
    acp = bool(hashtype & 0x80)
    hp = ZERO32 if acp else sha256d(
        b"".join(inp["prev"] + struct.pack("<I", inp["vout"]) for inp in tx["inputs"]))
    hs = ZERO32 if (acp or base in (2, 3)) else sha256d(
        b"".join(struct.pack("<I", inp["sequence"]) for inp in tx["inputs"]))
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
    return sha256d(pre).hex()


P2PKH = bytes.fromhex("76a914" + "33" * 20 + "88ac")
SEP_SCRIPT = bytes([0x51, 0xAB, 0x03, 0xAB, 0xAB, 0xAB, 0xAB, 0x52])

TX2 = {  # 2 inputs, 2 outputs
    "version": 2,
    "inputs": [
        {"prev": b"\x11" * 32, "vout": 0, "scriptSig": b"", "sequence": 0xFFFFFFFD},
        {"prev": b"\x22" * 32, "vout": 1, "scriptSig": b"\x6a", "sequence": 0xFFFFFFFF},
    ],
    "outputs": [(100000, P2PKH), (200000, b"\x6a")],
    "locktime": 0,
}
TX1 = {  # 2 inputs, 1 output: SINGLE on input 1 misses its output
    "version": 1,
    "inputs": [
        {"prev": b"\x33" * 32, "vout": 2, "scriptSig": b"\x51", "sequence": 0xFFFFFFFE},
        {"prev": b"\x44" * 32, "vout": 3, "scriptSig": b"", "sequence": 0xFFFFFFFF},
    ],
    "outputs": [(70000, P2PKH)],
    "locktime": 900000,
}
TXW = {  # witness serialization, huge 64-bit output value
    "version": 2,
    "inputs": [
        {"prev": b"\x55" * 32, "vout": 0, "scriptSig": b"", "sequence": 0xFFFFFFFF},
    ],
    "outputs": [(0xFFFFFFFFFFFFFFFF, P2PKH)],
    "locktime": 500000,
}
WIT = [[bytes.fromhex("deadbeef"), b"\x01\x02"]]

vectors = []

def add(name, tx, witnesses, idx, mode, script, value, hashtype, last_sep):
    raw = serialize(tx, witnesses).hex()
    sub = subscript(script, last_sep, legacy=(mode == "legacy"))
    if mode == "legacy":
        expected = legacy_sighash(tx, idx, sub, hashtype)
    else:
        expected = bip143_sighash(tx, idx, sub, value, hashtype)
    vectors.append({
        "name": name,
        "rawTransaction": raw,
        "inputIndex": idx,
        "mode": mode,
        "scriptCode": script.hex(),
        "prevOutValue": str(value),
        "sigHashType": hashtype,
        "lastCodeSeparatorOffset": last_sep,
        "expected": expected,
    })


TYPES = [0x01, 0x02, 0x03, 0x81, 0x82, 0x83]
for mode in ("legacy", "bip143"):
    for ht in TYPES:
        for idx in (0, 1):
            add(f"{mode}-tx2-in{idx}-ht{ht:#04x}", TX2, None, idx, mode,
                P2PKH, 100000, ht, None)
    for ht in (0x03, 0x83):  # SINGLE missing its output
        add(f"{mode}-single-missing-ht{ht:#04x}", TX1, None, 1, mode,
            P2PKH, 70000, ht, None)
    for offset in (None, 1, 6):
        add(f"{mode}-sepscript-off{offset}", TX2, None, 0, mode,
            SEP_SCRIPT, 100000, 0x01, offset)
    add(f"{mode}-witness-ht01", TXW, WIT, 0, mode, P2PKH, 0xFFFFFFFFFFFFFFFF, 0x01, None)

print(json.dumps(vectors, indent=1))
