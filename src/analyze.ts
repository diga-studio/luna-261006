import { findModel, FormulaBuilder } from './formula.js';
import { parse } from './parser.js';
import { symbolicExecute } from './symbolic.js';
import { TARGET_CONSTANTS } from './types.js';

export type Verdict = 'PASS' | 'FAIL' | 'CONDITIONAL';

export interface AnalysisResult {
  result: Verdict;
  /** Assignment witnessing a compliant outcome (present iff one exists). */
  compliantWitness?: Record<string, boolean>;
  /** Assignment witnessing a non-compliant outcome (present iff one exists). */
  nonCompliantWitness?: Record<string, boolean>;
}

/**
 * Decides, over ALL environment assignments, whether both target constants
 * end up defined with value true. The result is exact: it comes from a
 * complete SAT decision over the symbolic execution DAG, never from
 * sampling, path truncation, or timeouts.
 */
export function analyze(source: string): AnalysisResult {
  const program = parse(source);
  const builder = new FormulaBuilder();
  const { constants, envKeys } = symbolicExecute(program, builder);

  let compliant = builder.const(true);
  for (const name of TARGET_CONSTANTS) {
    const st = constants.get(name);
    compliant = builder.and(
      compliant,
      st === undefined ? builder.const(false) : builder.and(st.def, st.val),
    );
  }

  const compliantModel = findModel(compliant, true, envKeys);
  const nonCompliantModel = findModel(compliant, false, envKeys);

  if (nonCompliantModel === null) {
    // compliant === false is unsatisfiable: every assignment complies.
    return { result: 'PASS', compliantWitness: compliantModel! };
  }
  if (compliantModel === null) {
    // compliant === true is unsatisfiable: no assignment complies.
    return { result: 'FAIL', nonCompliantWitness: nonCompliantModel };
  }
  return {
    result: 'CONDITIONAL',
    compliantWitness: compliantModel,
    nonCompliantWitness: nonCompliantModel,
  };
}
