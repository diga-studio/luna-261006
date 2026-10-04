import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, evaluate, parse } from '../src/index.js';
import type { BoolExpr, Program, Stmt } from '../src/index.js';

// --- Seeded RNG (mulberry32) ------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Random program generator ------------------------------------------------

const ALL_KEYS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'];
const CONST_NAMES = ['DISALLOW_FILE_EDIT', 'FORCE_SSL_ADMIN', 'H1', 'H2', 'H3'];

function genExpr(rng: () => number, keys: string[], depth: number): string {
  const pick = rng();
  if (depth <= 0 || pick < 0.4) {
    const leaf = rng();
    if (leaf < 0.15) return 'true';
    if (leaf < 0.3) return 'false';
    if (leaf < 0.65) {
      const key = keys[Math.floor(rng() * keys.length)]!;
      return `(getenv('${key}') === '1')`;
    }
    const name = CONST_NAMES[Math.floor(rng() * CONST_NAMES.length)]!;
    return `defined('${name}')`;
  }
  const op = rng();
  if (op < 0.25) return `!(${genExpr(rng, keys, depth - 1)})`;
  const left = genExpr(rng, keys, depth - 1);
  const right = genExpr(rng, keys, depth - 1);
  return op < 0.625 ? `(${left} && ${right})` : `(${left} || ${right})`;
}

function genStmts(rng: () => number, keys: string[], depth: number): string[] {
  const count = 1 + Math.floor(rng() * 4);
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (depth < 3 && rng() < 0.45) {
      const cond = genExpr(rng, keys, 3);
      lines.push(`if (${cond}) {`);
      lines.push(...genStmts(rng, keys, depth + 1));
      if (rng() < 0.6) {
        lines.push('} else {');
        lines.push(...genStmts(rng, keys, depth + 1));
      }
      lines.push('}');
    } else {
      const name = CONST_NAMES[Math.floor(rng() * CONST_NAMES.length)]!;
      lines.push(`define('${name}', ${genExpr(rng, keys, 3)});`);
    }
  }
  return lines;
}

function genProgram(rng: () => number): string {
  const keyCount = 1 + Math.floor(rng() * ALL_KEYS.length);
  const keys = ALL_KEYS.slice(0, keyCount);
  return `<?php\n${genStmts(rng, keys, 0).join('\n')}\n`;
}

// --- Independent reference executor (never calls production evaluate) -------

function refEvalExpr(e: BoolExpr, defined: ReadonlySet<string>, values: ReadonlyMap<string, boolean>, env: Record<string, boolean>): boolean {
  switch (e.kind) {
    case 'const':
      return e.value;
    case 'not':
      return !refEvalExpr(e.operand, defined, values, env);
    case 'and':
      return refEvalExpr(e.left, defined, values, env) && refEvalExpr(e.right, defined, values, env);
    case 'or':
      return refEvalExpr(e.left, defined, values, env) || refEvalExpr(e.right, defined, values, env);
    case 'defined':
      return defined.has(e.name);
    case 'env':
      return env[e.key]!;
  }
}

function refRun(program: Program, env: Record<string, boolean>): Map<string, boolean> {
  const values = new Map<string, boolean>();
  const run = (stmts: readonly Stmt[]): void => {
    for (const stmt of stmts) {
      if (stmt.kind === 'define') {
        if (!values.has(stmt.name)) {
          values.set(stmt.name, refEvalExpr(stmt.value, new Set(values.keys()), values, env));
        }
      } else {
        const branch = refEvalExpr(stmt.cond, new Set(values.keys()), values, env)
          ? stmt.then
          : stmt.else;
        if (branch !== null) run(branch);
      }
    }
  };
  run(program.stmts);
  return values;
}

function refCompliant(values: ReadonlyMap<string, boolean>): boolean {
  return values.get('DISALLOW_FILE_EDIT') === true && values.get('FORCE_SSL_ADMIN') === true;
}

function collectKeys(program: Program): string[] {
  const keys = new Set<string>();
  const walkExpr = (e: BoolExpr): void => {
    switch (e.kind) {
      case 'env':
        keys.add(e.key);
        break;
      case 'not':
        walkExpr(e.operand);
        break;
      case 'and':
      case 'or':
        walkExpr(e.left);
        walkExpr(e.right);
        break;
      default:
        break;
    }
  };
  const walkStmts = (stmts: readonly Stmt[]): void => {
    for (const stmt of stmts) {
      if (stmt.kind === 'define') {
        walkExpr(stmt.value);
      } else {
        walkExpr(stmt.cond);
        walkStmts(stmt.then);
        if (stmt.else !== null) walkStmts(stmt.else);
      }
    }
  };
  walkStmts(program.stmts);
  return [...keys].sort();
}

// --- Cross-check --------------------------------------------------------------

test('random programs: analyze matches exhaustive reference execution', () => {
  const rng = mulberry32(0xc0ffee);
  const iterations = 400;
  for (let iter = 0; iter < iterations; iter += 1) {
    const source = genProgram(rng);
    const program = parse(source);
    const keys = collectKeys(program);
    assert.ok(keys.length <= 6);

    const total = 1 << keys.length;
    let passCount = 0;
    for (let mask = 0; mask < total; mask += 1) {
      const env: Record<string, boolean> = {};
      keys.forEach((key, i) => {
        env[key] = (mask & (1 << i)) !== 0;
      });
      const expected = refCompliant(refRun(program, env));
      // Production evaluate must agree with the reference on every point.
      assert.equal(evaluate(source, env).compliant, expected, `env=${JSON.stringify(env)}\n${source}`);
      if (expected) passCount += 1;
    }

    const expectedVerdict = passCount === total ? 'PASS' : passCount === 0 ? 'FAIL' : 'CONDITIONAL';
    const result = analyze(source);
    assert.equal(
      result.result,
      expectedVerdict,
      `verdict mismatch (pass ${passCount}/${total})\n${source}`,
    );

    const checkWitness = (witness: Record<string, boolean> | undefined, compliant: boolean): void => {
      assert.ok(witness !== undefined, `missing witness\n${source}`);
      for (const key of keys) {
        assert.ok(key in witness, `witness misses env key '${key}'\n${source}`);
      }
      const actual = refCompliant(refRun(program, witness));
      assert.equal(actual, compliant, `witness does not reproduce outcome\n${source}`);
    };
    if (expectedVerdict !== 'FAIL') checkWitness(result.compliantWitness, true);
    if (expectedVerdict !== 'PASS') checkWitness(result.nonCompliantWitness, false);
    if (expectedVerdict === 'PASS') assert.equal(result.nonCompliantWitness, undefined);
    if (expectedVerdict === 'FAIL') assert.equal(result.compliantWitness, undefined);
  }
});
