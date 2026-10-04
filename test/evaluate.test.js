import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, evaluate } from "../dist/src/index.js";

// ---------- 独立实现：普通布尔求值（不依赖库内代码，用于核验见证与穷举判据） ----------
function evalPlain(expr, assignment) {
  switch (expr.op) {
    case "const": return expr.value;
    case "and": return expr.args.every((a) => evalPlain(a, assignment));
    case "or": return expr.args.some((a) => evalPlain(a, assignment));
    case "not": return !evalPlain(expr.arg, assignment);
    case "eq": return assignment[expr.field] === expr.value;
    case "lt": return assignment[expr.field] < expr.value;
    default: throw new Error("bad expr " + JSON.stringify(expr));
  }
}

function domainOf(type) {
  if (type.kind === "bool") return [false, true];
  const out = [];
  for (let i = type.min; i <= type.max; i++) out.push(i);
  return out;
}

function* allCompletions(schema, snapshot) {
  const fields = Object.keys(schema.fields);
  const unknown = fields.filter((f) => !(f in snapshot));
  const domains = unknown.map((f) => domainOf(schema.fields[f]));
  const idx = new Array(unknown.length).fill(0);
  while (true) {
    const c = { ...snapshot };
    unknown.forEach((f, i) => { c[f] = domains[i][idx[i]]; });
    yield c;
    let p = 0;
    while (p < unknown.length) {
      idx[p]++;
      if (idx[p] < domains[p].length) break;
      idx[p] = 0;
      p++;
    }
    if (p === unknown.length) return;
  }
}

// ---------- 独立判据：对小字段域穷举全部合法补全 ----------
function oracleConclusion(schema, policy, snapshot) {
  let applicableCount = 0, reqTrue = 0, reqFalse = 0;
  for (const c of allCompletions(schema, snapshot)) {
    if (!evalPlain(policy.applicable, c)) continue;
    applicableCount++;
    if (evalPlain(policy.required, c)) reqTrue++; else reqFalse++;
  }
  if (applicableCount === 0) return "NA";
  if (reqTrue > 0 && reqFalse > 0) return "Warning";
  return reqTrue > 0 ? "Pass" : "Fail";
}

// ---------- 独立见证核验 ----------
function checkCompleteAssignment(schema, snapshot, assignment) {
  for (const [f, t] of Object.entries(schema.fields)) {
    assert.ok(f in assignment, `witness missing field ${f}`);
    const v = assignment[f];
    if (t.kind === "bool") assert.ok(typeof v === "boolean");
    else assert.ok(Number.isInteger(v) && v >= t.min && v <= t.max);
  }
  for (const [f, v] of Object.entries(snapshot)) {
    assert.equal(assignment[f], v, `witness must preserve known ${f}`);
  }
}

function checkResult(schema, policy, snapshot, result) {
  const expected = oracleConclusion(schema, policy, snapshot);
  assert.equal(result.conclusion, expected,
    `conclusion mismatch: got ${result.conclusion}, oracle ${expected}`);
  const { witnesses } = result;
  if (expected === "NA") {
    assert.deepEqual(witnesses, {});
    return;
  }
  if (expected === "Pass" || expected === "Warning") {
    assert.ok(witnesses.pass, "pass witness required");
    checkCompleteAssignment(schema, snapshot, witnesses.pass);
    assert.equal(evalPlain(policy.applicable, witnesses.pass), true);
    assert.equal(evalPlain(policy.required, witnesses.pass), true);
  } else {
    assert.ok(!("pass" in witnesses) || witnesses.pass === undefined);
  }
  if (expected === "Fail" || expected === "Warning") {
    assert.ok(witnesses.fail, "fail witness required");
    checkCompleteAssignment(schema, snapshot, witnesses.fail);
    assert.equal(evalPlain(policy.applicable, witnesses.fail), true);
    assert.equal(evalPlain(policy.required, witnesses.fail), false);
  } else {
    assert.ok(!("fail" in witnesses) || witnesses.fail === undefined);
  }
}

function run(schema, policy, snapshot) {
  const compiled = compile(schema, policy);
  const result = evaluate(compiled, snapshot);
  checkResult(schema, policy, snapshot, result);
  return result;
}

// ---------- 定向用例 ----------
const BOOL = { kind: "bool" };

test("applicable 与 required 相同且可满足：全部未知也是 Pass", () => {
  const schema = { fields: { a: BOOL, b: BOOL } };
  const expr = { op: "or", args: [
    { op: "eq", field: "a", value: true },
    { op: "eq", field: "b", value: true },
  ] };
  const r = run(schema, { applicable: expr, required: expr }, {});
  assert.equal(r.conclusion, "Pass");
});

test("不可满足的适用条件 → NA", () => {
  const schema = { fields: { a: BOOL } };
  const policy = {
    applicable: { op: "and", args: [
      { op: "eq", field: "a", value: true },
      { op: "eq", field: "a", value: false },
    ] },
    required: { op: "const", value: true },
  };
  const r = run(schema, policy, {});
  assert.equal(r.conclusion, "NA");
  assert.deepEqual(r.witnesses, {});
});

test("适用性不确定不等于 Warning：not(applicable) 永假时 required 同真", () => {
  // applicable = a, required = a ∨ b。a 假时不适用；适用补全中 required 恒真 → Pass
  const schema = { fields: { a: BOOL, b: BOOL } };
  const policy = {
    applicable: { op: "eq", field: "a", value: true },
    required: { op: "or", args: [
      { op: "eq", field: "a", value: true },
      { op: "eq", field: "b", value: true },
    ] },
  };
  const r = run(schema, policy, {});
  assert.equal(r.conclusion, "Pass");
});

test("required 真假都可能 → Warning，且返回两个见证", () => {
  const schema = { fields: { a: BOOL } };
  const policy = {
    applicable: { op: "const", value: true },
    required: { op: "eq", field: "a", value: true },
  };
  const r = run(schema, policy, {});
  assert.equal(r.conclusion, "Warning");
  assert.equal(r.witnesses.pass.a, true);
  assert.equal(r.witnesses.fail.a, false);
});

test("required 恒假 → Fail", () => {
  const schema = { fields: { a: BOOL } };
  const policy = {
    applicable: { op: "const", value: true },
    required: { op: "and", args: [
      { op: "eq", field: "a", value: true },
      { op: "not", arg: { op: "eq", field: "a", value: true } },
    ] },
  };
  const r = run(schema, policy, {});
  assert.equal(r.conclusion, "Fail");
});

test("重复引用同一字段是同一个未知量（矛盾引用 → NA）", () => {
  const schema = { fields: { x: { kind: "int", min: 0, max: 3 } } };
  const policy = {
    applicable: { op: "and", args: [
      { op: "lt", field: "x", value: 1 },
      { op: "lt", field: "x", value: 3 },
      { op: "not", arg: { op: "lt", field: "x", value: 2 } },
    ] },
    required: { op: "const", value: true },
  };
  // x<1 ∧ x<3 ∧ ¬(x<2)：x<1 蕴含 x<2，矛盾 → NA
  const r = run(schema, policy, {});
  assert.equal(r.conclusion, "NA");
});

test("整数 lt 与快照共同决定结论", () => {
  const schema = { fields: { x: { kind: "int", min: 0, max: 5 } } };
  const policy = {
    applicable: { op: "const", value: true },
    required: { op: "lt", field: "x", value: 2 },
  };
  assert.equal(run(schema, policy, {}).conclusion, "Warning");
  assert.equal(run(schema, policy, { x: 1 }).conclusion, "Pass");
  assert.equal(run(schema, policy, { x: 4 }).conclusion, "Fail");
});

test("否定与嵌套：not 作用于复合表达式", () => {
  const schema = { fields: { a: BOOL, b: BOOL } };
  const policy = {
    applicable: { op: "not", arg: { op: "and", args: [
      { op: "eq", field: "a", value: true },
      { op: "eq", field: "b", value: true },
    ] } },
    required: { op: "or", args: [
      { op: "eq", field: "a", value: true },
      { op: "eq", field: "b", value: true },
    ] },
  };
  // 适用：¬(a∧b)。required = a∨b：a=true,b=false 真；a=false,b=false 假 → Warning
  assert.equal(run(schema, policy, {}).conclusion, "Warning");
  // 固定 a=true：适用补全要求 b=false，required 恒真 → Pass
  assert.equal(run(schema, policy, { a: true }).conclusion, "Pass");
});

test("混合类型与 eq 常量比较", () => {
  const schema = { fields: {
    flag: BOOL,
    level: { kind: "int", min: 1, max: 3 },
  } };
  const policy = {
    applicable: { op: "eq", field: "flag", value: true },
    required: { op: "and", args: [
      { op: "eq", field: "level", value: 2 },
      { op: "eq", field: "flag", value: true },
    ] },
  };
  assert.equal(run(schema, policy, {}).conclusion, "Warning");
  assert.equal(run(schema, policy, { flag: false }).conclusion, "NA");
  assert.equal(run(schema, policy, { flag: true, level: 2 }).conclusion, "Pass");
  assert.equal(run(schema, policy, { flag: true, level: 1 }).conclusion, "Fail");
});

// ---------- 随机交叉核对：结论对穷举判据、见证独立核验 ----------
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAND_SCHEMA = { fields: {
  p: BOOL,
  q: BOOL,
  m: { kind: "int", min: 0, max: 2 },
  n: { kind: "int", min: -1, max: 1 },
} };

function randExpr(rand, depth) {
  const r = rand();
  if (depth <= 0 || r < 0.35) {
    const leaf = rand();
    if (leaf < 0.15) return { op: "const", value: rand() < 0.5 };
    const field = ["p", "q", "m", "n"][Math.floor(rand() * 4)];
    const t = RAND_SCHEMA.fields[field];
    if (t.kind === "bool") return { op: "eq", field, value: rand() < 0.5 };
    const dom = domainOf(t);
    const v = dom[Math.floor(rand() * dom.length)];
    return rand() < 0.5 ? { op: "eq", field, value: v } : { op: "lt", field, value: v };
  }
  if (r < 0.55) return { op: "not", arg: randExpr(rand, depth - 1) };
  const n = 2 + Math.floor(rand() * 2);
  const args = Array.from({ length: n }, () => randExpr(rand, depth - 1));
  return { op: r < 0.8 ? "and" : "or", args };
}

test("随机策略与快照：结论与见证对穷举判据交叉核对", () => {
  const rand = mulberry32(20261004);
  const fieldNames = Object.keys(RAND_SCHEMA.fields);
  for (let i = 0; i < 400; i++) {
    const policy = { applicable: randExpr(rand, 3), required: randExpr(rand, 3) };
    const snapshot = {};
    for (const f of fieldNames) {
      if (rand() < 0.4) {
        const dom = domainOf(RAND_SCHEMA.fields[f]);
        snapshot[f] = dom[Math.floor(rand() * dom.length)];
      }
    }
    run(RAND_SCHEMA, policy, snapshot);
  }
});
