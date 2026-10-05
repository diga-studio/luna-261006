import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Bdd } from '../src/bdd';
import { makeRng } from './helpers';

const VARS = 4;

type Formula =
  | { kind: 'var'; v: number }
  | { kind: 'not'; a: Formula }
  | { kind: 'and'; a: Formula; b: Formula }
  | { kind: 'or'; a: Formula; b: Formula };

function randomFormula(rng: () => number, depth: number): Formula {
  if (depth === 0 || rng() < 0.35) return { kind: 'var', v: Math.floor(rng() * VARS) };
  const roll = rng();
  if (roll < 0.34) return { kind: 'not', a: randomFormula(rng, depth - 1) };
  const a = randomFormula(rng, depth - 1);
  const b = randomFormula(rng, depth - 1);
  return roll < 0.67 ? { kind: 'and', a, b } : { kind: 'or', a, b };
}

function build(bdd: Bdd, f: Formula): number {
  switch (f.kind) {
    case 'var':
      return bdd.variable(f.v);
    case 'not':
      return bdd.not(build(bdd, f.a));
    case 'and':
      return bdd.and(build(bdd, f.a), build(bdd, f.b));
    case 'or':
      return bdd.or(build(bdd, f.a), build(bdd, f.b));
  }
}

function evaluate(f: Formula, input: boolean[]): boolean {
  switch (f.kind) {
    case 'var':
      return input[f.v]!;
    case 'not':
      return !evaluate(f.a, input);
    case 'and':
      return evaluate(f.a, input) && evaluate(f.b, input);
    case 'or':
      return evaluate(f.a, input) || evaluate(f.b, input);
  }
}

test('BDD operations agree with truth-table evaluation', () => {
  const rng = makeRng(991);
  const bdd = new Bdd();
  for (let round = 0; round < 500; round++) {
    const formula = randomFormula(rng, 4);
    const root = build(bdd, formula);
    for (let mask = 0; mask < 1 << VARS; mask++) {
      const input: boolean[] = [];
      for (let bit = 0; bit < VARS; bit++) input.push(((mask >>> bit) & 1) === 1);
      const expected = evaluate(formula, input);
      assert.equal(bdd.evaluate(root, input), expected, `mask ${mask} round ${round}`);
    }
  }
});

test('oneSat returns a complete satisfying assignment or null', () => {
  const bdd = new Bdd();
  const a = bdd.variable(0);
  const b = bdd.variable(1);
  const sat = bdd.oneSat(bdd.and(a, bdd.not(b)), 3)!;
  assert.deepEqual(sat, [true, false, false]);
  assert.equal(bdd.oneSat(bdd.and(a, bdd.not(a)), 1), null);
  const free = bdd.oneSat(Bdd.TRUE, 3)!;
  assert.deepEqual(free, [false, false, false]);
});
