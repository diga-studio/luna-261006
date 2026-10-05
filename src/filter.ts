import type { BuiltIndex } from './build.js';
import type { FilterNode, MatchLeaf } from './types.js';

function leafBits(index: BuiltIndex, leaf: MatchLeaf, size: number): Uint8Array {
  const postings =
    leaf.kind === 'tag'
      ? index.tagPostings.get(leaf.value)
      : index.skillPostings.get(leaf.value);
  const bits = new Uint8Array(size);
  if (postings !== undefined) {
    for (const slot of postings) {
      bits[slot] = 1;
    }
  }
  return bits;
}

/**
 * Evaluates the filter tree into a bitset over version slots.
 * Pure set algebra over index posting lists: no per-version
 * query-dependent scoring work happens here.
 */
export function evaluateFilter(index: BuiltIndex, node: FilterNode): Uint8Array {
  const size = index.versions.length;
  switch (node.op) {
    case 'leaf':
      return leafBits(index, node.leaf, size);
    case 'not': {
      const child = evaluateFilter(index, node.child);
      for (let i = 0; i < size; i += 1) {
        child[i] ^= 1;
      }
      return child;
    }
    case 'and': {
      if (node.children.length === 0) {
        return new Uint8Array(size).fill(1);
      }
      const acc = evaluateFilter(index, node.children[0]);
      for (let i = 1; i < node.children.length; i += 1) {
        const next = evaluateFilter(index, node.children[i]);
        for (let j = 0; j < size; j += 1) {
          acc[j] &= next[j];
        }
      }
      return acc;
    }
    case 'or': {
      const acc = new Uint8Array(size);
      for (const child of node.children) {
        const next = evaluateFilter(index, child);
        for (let j = 0; j < size; j += 1) {
          acc[j] |= next[j];
        }
      }
      return acc;
    }
  }
}
