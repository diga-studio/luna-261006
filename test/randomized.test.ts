import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, evaluate, parse } from "../src/index.js";
import type { BoolExpr, Statement } from "../src/types.js";

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(private readonly next: () => number) {}
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

interface GenConfig {
  envKeys: string[];
  constNames: string[];
}

function genBoolExpr(rng: Rng, cfg: GenConfig, depth: number): string {
  if (depth === 0) {
    const choice = rng.int(4);
    if (choice === 0) return rng.pick(["true", "false"]);
    if (choice === 1) return `defined('${rng.pick(cfg.constNames)}')`;
    return `getenv('${rng.pick(cfg.envKeys)}') === '1'`;
  }
  const choice = rng.int(5);
  if (choice === 0) return `!${paren(genBoolExpr(rng, cfg, depth - 1))}`;
  if (choice === 1 || choice === 2) {
    return `${paren(genBoolExpr(rng, cfg, depth - 1))} && ${paren(genBoolExpr(rng, cfg, depth - 1))}`;
  }
  if (choice === 3) {
    return `${paren(genBoolExpr(rng, cfg, depth - 1))} || ${paren(genBoolExpr(rng, cfg, depth - 1))}`;
  }
  return genBoolExpr(rng, cfg, 0);
}

function paren(s: string): string {
  return s.startsWith("(") ? s : `(${s})`;
}

function genStatements(rng: Rng, cfg: GenConfig, depth: number): string[] {
  const count = 1 + rng.int(4);
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    if (depth < 2 && rng.chance(0.35)) {
      lines.push(`if (${genBoolExpr(rng, cfg, 2)}) {`);
      lines.push(...genStatements(rng, cfg, depth + 1).map((l) => `  ${l}`));
      lines.push(`}`);
      if (rng.chance(0.6)) {
        lines.push(`else {`);
        lines.push(...genStatements(rng, cfg, depth + 1).map((l) => `  ${l}`));
        lines.push(`}`);
      }
    } else {
      // Small constant pool makes duplicate defines likely.
      lines.push(
        `define('${rng.pick(cfg.constNames)}', ${genBoolExpr(rng, cfg, 2)});`,
      );
    }
  }
  return lines;
}

function genProgram(rng: Rng): { source: string; envKeys: string[] } {
  const keyCount = 1 + rng.int(6);
  const envKeys = Array.from({ length: keyCount }, (_, i) => `K${i}`);
  const constNames = [
    "DISALLOW_FILE_EDIT",
    "FORCE_SSL_ADMIN",
    "H1",
    "H2",
    "H3",
  ];
  const cfg: GenConfig = { envKeys, constNames };
  const lines = ["<?php"];
  const stmtCount = 3 + rng.int(8);
  for (let i = 0; i < stmtCount; i++) {
    lines.push(...genStatements(rng, cfg, 0));
  }
  return { source: lines.join("\n"), envKeys };
}

// ---------------------------------------------------------------------------
// Independent reference executor (test-only). Implements the restricted
// semantics directly on the AST; never calls the production evaluator.
// ---------------------------------------------------------------------------

class ReferenceInterpreter {
  private readonly constants = new Map<string, boolean>();

  constructor(private readonly env: Readonly<Record<string, boolean>>) {}

  run(statements: Statement[]): void {
    for (const stmt of statements) {
      if (stmt.kind === "define") {
        if (!this.constants.has(stmt.name)) {
          this.constants.set(stmt.name, this.evalExpr(stmt.value));
        }
      } else {
        const branch = this.evalExpr(stmt.cond) ? stmt.then : stmt.else;
        if (branch !== null) this.run(branch);
      }
    }
  }

  private evalExpr(expr: BoolExpr): boolean {
    switch (expr.kind) {
      case "const":
        return expr.value;
      case "not":
        return !this.evalExpr(expr.operand);
      case "and":
        return this.evalExpr(expr.left) && this.evalExpr(expr.right);
      case "or":
        return this.evalExpr(expr.left) || this.evalExpr(expr.right);
      case "defined":
        return this.constants.has(expr.name);
      case "env":
        return this.env[expr.key] === true;
    }
  }

  compliant(): boolean {
    return (
      this.constants.get("DISALLOW_FILE_EDIT") === true &&
      this.constants.get("FORCE_SSL_ADMIN") === true
    );
  }
}

function referenceCompliance(
  statements: Statement[],
  env: Readonly<Record<string, boolean>>,
): boolean {
  const interpreter = new ReferenceInterpreter(env);
  interpreter.run(statements);
  return interpreter.compliant();
}

function* assignments(keys: string[]): Generator<Record<string, boolean>> {
  const total = 1 << keys.length;
  for (let mask = 0; mask < total; mask++) {
    const env: Record<string, boolean> = {};
    for (let i = 0; i < keys.length; i++) {
      env[keys[i]!] = (mask & (1 << i)) !== 0;
    }
    yield env;
  }
}

test("random programs match exhaustive reference classification", () => {
  const PROGRAMS = 200;
  for (let seed = 1; seed <= PROGRAMS; seed++) {
    const rng = new Rng(mulberry32(seed * 2654435761));
    const { source } = genProgram(rng);
    const program = parse(source);
    // Only keys actually referenced by the source matter.
    const envKeys = program.envKeys;

    // Exhaustive reference classification over every environment.
    let compliantCount = 0;
    let total = 0;
    for (const env of assignments(envKeys)) {
      total++;
      const ref = referenceCompliance(program.statements, env);
      if (ref) compliantCount++;
      // The production concrete evaluator must agree with the
      // reference executor on every single environment.
      assert.equal(
        evaluate(source, env).compliant,
        ref,
        `seed ${seed}: evaluate disagrees with reference on ${JSON.stringify(env)}\n${source}`,
      );
    }
    const expected =
      compliantCount === total
        ? "PASS"
        : compliantCount === 0
          ? "FAIL"
          : "CONDITIONAL";

    const result = analyze(source);
    assert.equal(
      result.verdict,
      expected,
      `seed ${seed}: analyze=${result.verdict}, reference=${expected} (${compliantCount}/${total})\n${source}`,
    );

    // Every witness must cover all env keys and reproduce its claim
    // under the reference executor.
    if (result.compliantWitness) {
      assert.deepEqual(
        Object.keys(result.compliantWitness.env).sort(),
        [...envKeys].sort(),
        `seed ${seed}: compliant witness keys`,
      );
      assert.equal(
        referenceCompliance(program.statements, result.compliantWitness.env),
        true,
        `seed ${seed}: compliant witness fails reference check`,
      );
    } else {
      assert.equal(compliantCount, 0, `seed ${seed}: missing compliant witness`);
    }
    if (result.nonCompliantWitness) {
      assert.deepEqual(
        Object.keys(result.nonCompliantWitness.env).sort(),
        [...envKeys].sort(),
        `seed ${seed}: non-compliant witness keys`,
      );
      assert.equal(
        referenceCompliance(program.statements, result.nonCompliantWitness.env),
        false,
        `seed ${seed}: non-compliant witness fails reference check`,
      );
    } else {
      assert.equal(compliantCount, total, `seed ${seed}: missing non-compliant witness`);
    }
  }
});
