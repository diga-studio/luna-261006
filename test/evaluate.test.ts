import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compile,
  evaluate,
  evalExpr,
  type CompiledPolicy,
  type Completion,
  type Evaluation,
  type Expr,
  type Policy,
  type Schema,
  type Snapshot,
} from "../src/index.js";

// ---------- 独立判据：对小字段域穷举全部合法补全 ----------

function domainValues(schema: Schema, field: string): (boolean | number)[] {
  const decl = schema[field];
  if (decl.type === "boolean") return [false, true];
  const values: number[] = [];
  for (let v = decl.min; v <= decl.max; v++) values.push(v);
  return values;
}

/** 穷举所有保留 snapshot 已知值的完整补全。 */
function* allCompletions(schema: Schema, snapshot: Snapshot): Generator<Completion> {
  const fields = Object.keys(schema).sort();
  const domains = fields.map((f) => {
    const known = snapshot[f];
    return known === undefined ? domainValues(schema, f) : [known];
  });
  const current: (boolean | number)[] = new Array(fields.length);
  function* rec(i: number): Generator<Completion> {
    if (i === fields.length) {
      const c: Completion = {};
      for (let k = 0; k < fields.length; k++) c[fields[k]] = current[k];
      yield c;
      return;
    }
    for (const v of domains[i]) {
      current[i] = v;
      yield* rec(i + 1);
    }
  }
  yield* rec(0);
}

/** 用穷举独立推导出结论。 */
function oracleConclusion(
  schema: Schema,
  policy: Policy,
  snapshot: Snapshot,
): "NA" | "Pass" | "Fail" | "Warning" {
  let hasPass = false;
  let hasFail = false;
  for (const c of allCompletions(schema, snapshot)) {
    if (evalExpr(policy.applicable, c)) {
      if (evalExpr(policy.required, c)) hasPass = true;
      else hasFail = true;
    }
  }
  if (hasPass && hasFail) return "Warning";
  if (hasPass) return "Pass";
  if (hasFail) return "Fail";
  return "NA";
}

/** 独立验证：补全本身合法（完整、保留已知值、域内取值）。 */
function assertValidCompletion(
  schema: Schema,
  snapshot: Snapshot,
  c: Completion,
): void {
  for (const [field, decl] of Object.entries(schema)) {
    const v = c[field];
    assert.notEqual(v, undefined, `completion missing field ${field}`);
    if (decl.type === "boolean") {
      assert.equal(typeof v, "boolean", `${field} must be boolean`);
    } else {
      assert.equal(typeof v, "number", `${field} must be number`);
      assert.ok(Number.isInteger(v), `${field} must be integer`);
      assert.ok(v >= decl.min && v <= decl.max, `${field}=${v} out of domain`);
    }
  }
  for (const [field, known] of Object.entries(snapshot)) {
    assert.equal(c[field], known, `completion must keep known ${field}`);
  }
}

/** 独立验证返回的全部见证。 */
function assertWitnesses(
  compiled: CompiledPolicy,
  snapshot: Snapshot,
  result: Evaluation,
): void {
  const { schema, applicable, required } = compiled;
  const checkPass = (w: Completion) => {
    assertValidCompletion(schema, snapshot, w);
    assert.ok(evalExpr(applicable, w), "pass witness must satisfy applicable");
    assert.ok(evalExpr(required, w), "pass witness must satisfy required");
  };
  const checkFail = (w: Completion) => {
    assertValidCompletion(schema, snapshot, w);
    assert.ok(evalExpr(applicable, w), "fail witness must satisfy applicable");
    assert.ok(!evalExpr(required, w), "fail witness must falsify required");
  };
  switch (result.conclusion) {
    case "NA":
      assert.deepEqual(Object.keys(result), ["conclusion"], "NA has no witness");
      break;
    case "Pass":
      checkPass(result.witness);
      break;
    case "Fail":
      checkFail(result.witness);
      break;
    case "Warning":
      checkPass(result.passWitness);
      checkFail(result.failWitness);
      break;
  }
}

function check(schema: Schema, policy: Policy, snapshot: Snapshot): Evaluation {
  const compiled = compile(schema, policy);
  const result = evaluate(compiled, snapshot);
  assert.equal(
    result.conclusion,
    oracleConclusion(schema, policy, snapshot),
    `conclusion mismatch for snapshot ${JSON.stringify(snapshot)}`,
  );
  assertWitnesses(compiled, snapshot, result);
  return result;
}

// ---------- 固定用例 ----------

const bool = { type: "boolean" } as const;
const int = (min: number, max: number) => ({ type: "integer", min, max } as const);

const eq = (field: string, value: boolean | number): Expr => ({ kind: "eq", field, value });
const lt = (field: string, value: number): Expr => ({ kind: "lt", field, value });
const and = (...args: Expr[]): Expr => ({ kind: "and", args });
const or = (...args: Expr[]): Expr => ({ kind: "or", args });
const not = (arg: Expr): Expr => ({ kind: "not", arg });
const cst = (value: boolean): Expr => ({ kind: "const", value });

test("Warning: required 真假补全都存在", () => {
  const schema: Schema = { a: bool };
  const policy: Policy = { applicable: cst(true), required: eq("a", true) };
  const result = check(schema, policy, {});
  assert.equal(result.conclusion, "Warning");
});

test("Pass: applicable 与 required 是同一可满足表达式（全部未知也是 Pass）", () => {
  const schema: Schema = { a: bool, n: int(0, 3) };
  const same = and(eq("a", true), lt("n", 2));
  const result = check(schema, { applicable: same, required: same }, {});
  assert.equal(result.conclusion, "Pass");
});

test("Fail: 适用补全中 required 始终为假（重复引用同一未知量）", () => {
  const schema: Schema = { a: bool };
  const policy: Policy = { applicable: eq("a", true), required: eq("a", false) };
  const result = check(schema, policy, {});
  assert.equal(result.conclusion, "Fail");
});

test("NA: applicable 不可满足", () => {
  const schema: Schema = { n: int(0, 3) };
  const policy: Policy = {
    applicable: and(eq("n", 1), eq("n", 2)),
    required: cst(true),
  };
  const result = check(schema, policy, {});
  assert.equal(result.conclusion, "NA");
});

test("Pass: 重复引用构成恒真 required", () => {
  const schema: Schema = { n: int(0, 3) };
  const policy: Policy = {
    applicable: cst(true),
    required: or(eq("n", 1), not(eq("n", 1))),
  };
  const result = check(schema, policy, {});
  assert.equal(result.conclusion, "Pass");
});

test("否定与已知值固定", () => {
  const schema: Schema = { a: bool, b: bool };
  const policy: Policy = {
    applicable: not(eq("a", true)),
    required: eq("b", false),
  };
  assert.equal(check(schema, policy, {}).conclusion, "Warning");
  assert.equal(check(schema, policy, { b: false }).conclusion, "Pass");
  assert.equal(check(schema, policy, { b: true }).conclusion, "Fail");
  assert.equal(check(schema, policy, { a: true }).conclusion, "NA");
});

test("整数 lt 边界", () => {
  const schema: Schema = { n: int(0, 3) };
  const policy: Policy = { applicable: lt("n", 2), required: lt("n", 1) };
  assert.equal(check(schema, policy, {}).conclusion, "Warning");
  assert.equal(check(schema, policy, { n: 0 }).conclusion, "Pass");
  assert.equal(check(schema, policy, { n: 1 }).conclusion, "Fail");
  assert.equal(check(schema, policy, { n: 2 }).conclusion, "NA");
});

test("嵌套与重复引用混合", () => {
  const schema: Schema = { a: bool, n: int(0, 2), m: int(-1, 1) };
  const policy: Policy = {
    applicable: or(and(eq("a", true), not(lt("n", 1))), and(not(eq("a", true)), eq("m", 0))),
    required: and(or(eq("n", 2), eq("m", -1)), not(and(eq("a", true), eq("n", 0)))),
  };
  const snapshots: Snapshot[] = [{}, { a: true }, { n: 2 }, { a: false, m: 0 }, { n: 0, m: 1 }];
  for (const snapshot of snapshots) {
    check(schema, policy, snapshot);
  }
});

test("大整数域不依赖逐值穷举", () => {
  const schema: Schema = { big: int(0, 1_000_000) };
  const policy: Policy = {
    applicable: and(lt("big", 500_000), not(eq("big", 42))),
    required: lt("big", 100),
  };
  assert.equal(check(schema, policy, {}).conclusion, "Warning");
  assert.equal(check(schema, policy, { big: 42 }).conclusion, "NA");
  assert.equal(check(schema, policy, { big: 7 }).conclusion, "Pass");
});

// ---------- 随机策略对拍：evaluate vs 穷举判据 ----------

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAND_SCHEMA: Schema = { a: bool, b: bool, n: int(0, 2), m: int(-1, 1) };

function randomExpr(rand: () => number, depth: number): Expr {
  const r = rand();
  if (depth <= 0 || r < 0.3) {
    const pick = rand();
    if (pick < 0.2) return cst(rand() < 0.5);
    const field = ["a", "b", "n", "m"][Math.floor(rand() * 4)];
    if (field === "a" || field === "b") return eq(field, rand() < 0.5);
    const values = field === "n" ? [0, 1, 2] : [-1, 0, 1];
    const c = values[Math.floor(rand() * values.length)];
    return rand() < 0.6 ? eq(field, c) : lt(field, c);
  }
  if (r < 0.55) return and(randomExpr(rand, depth - 1), randomExpr(rand, depth - 1));
  if (r < 0.8) return or(randomExpr(rand, depth - 1), randomExpr(rand, depth - 1));
  return not(randomExpr(rand, depth - 1));
}

test("随机策略与穷举判据对拍（含见证独立验证）", () => {
  const rand = mulberry32(20261004);
  for (let i = 0; i < 300; i++) {
    const policy: Policy = {
      applicable: randomExpr(rand, 3),
      required: randomExpr(rand, 3),
    };
    const compiled = compile(RAND_SCHEMA, policy);
    for (let j = 0; j < 3; j++) {
      const snapshot: Snapshot = {};
      for (const field of Object.keys(RAND_SCHEMA)) {
        if (rand() < 0.3) {
          const values = domainValues(RAND_SCHEMA, field);
          snapshot[field] = values[Math.floor(rand() * values.length)];
        }
      }
      const result = evaluate(compiled, snapshot);
      assert.equal(
        result.conclusion,
        oracleConclusion(RAND_SCHEMA, policy, snapshot),
        `policy=${JSON.stringify(policy)} snapshot=${JSON.stringify(snapshot)}`,
      );
      assertWitnesses(compiled, snapshot, result);
    }
  }
});
