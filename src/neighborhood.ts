/**
 * Precomputed XOR delta masks covering every 16-bit value within
 * Hamming distance 2 of a probe base: 1 identity + 16 one-bit masks
 * + 120 two-bit masks = 137 masks total.
 *
 * The 64-bit hash is split into four 16-bit blocks. Any record within
 * total distance 6 has distance at most 2 in at least one of the three
 * probed blocks, so probing these neighborhoods is exact.
 */
export const RADIUS2_DELTAS: readonly number[] = buildRadius2Deltas();

function buildRadius2Deltas(): number[] {
  const deltas: number[] = [0];
  for (let i = 0; i < 16; i++) {
    deltas.push(1 << i);
  }
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      deltas.push((1 << i) | (1 << j));
    }
  }
  return deltas;
}
