import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBatch, buildStateFromInput } from '../src/tree.js';
import { BatchValidationError } from '../src/errors.js';
import type { EditOperation, MindMapNodeInput, NodeId, TreeState } from '../src/types.js';

function nested(id: string, ...children: MindMapNodeInput[]): MindMapNodeInput {
  return { id, children };
}

/** 把状态拍平成 "id(childId,...)" 的嵌套字符串，便于断言。 */
function shape(state: TreeState, id: NodeId = state.rootId): string {
  const kids = state.children.get(id) ?? [];
  if (kids.length === 0) return id;
  return `${id}(${kids.map((k) => shape(state, k)).join(',')})`;
}

function chainState(): TreeState {
  // R -> A -> B -> C 依次嵌套
  return buildStateFromInput(nested('R', nested('A', nested('B', nested('C')))));
}

test('同批搬动祖先与后代：结果与排列无关', () => {
  const edits: EditOperation[] = [
    { nodeId: 'C', newParentId: 'R', position: 0 },
    { nodeId: 'A', newParentId: 'C', position: 0 },
  ];
  const forward = applyBatch(chainState(), edits);
  assert.equal(shape(forward), 'R(C(A(B)))');

  const reversed = applyBatch(chainState(), [...edits].reverse());
  assert.equal(shape(reversed), 'R(C(A(B)))');
});

test('多孩子换父与重排：最终孩子列表与独立计算一致', () => {
  // R 下依次有 a b c d e；把 c 移到位置 0，e 移到位置 1，b 搬到子节点 x 下位置 0。
  const state = buildStateFromInput(
    nested('R', nested('a'), nested('b'), nested('c'), nested('d'), nested('e'), nested('x')),
  );
  const next = applyBatch(state, [
    { nodeId: 'c', newParentId: 'R', position: 0 },
    { nodeId: 'e', newParentId: 'R', position: 1 },
    { nodeId: 'b', newParentId: 'x', position: 0 },
  ]);
  // 独立计算：R 老孩子 a b c d e x，b 搬走，c 占 0、e 占 1，
  // 其余按原相对顺序 a d x 填入 2、3、4。
  assert.deepEqual(next.children.get('R'), ['c', 'e', 'a', 'd', 'x']);
  assert.deepEqual(next.children.get('x'), ['b']);
});

test('同父重排：指定位置必须生效', () => {
  const state = buildStateFromInput(nested('R', nested('a'), nested('b'), nested('c')));
  const next = applyBatch(state, [{ nodeId: 'c', newParentId: 'R', position: 0 }]);
  assert.deepEqual(next.children.get('R'), ['c', 'a', 'b']);
});

test('重复最终位置：整批失败', () => {
  const state = buildStateFromInput(nested('R', nested('a'), nested('b'), nested('c')));
  assert.throws(
    () =>
      applyBatch(state, [
        { nodeId: 'a', newParentId: 'R', position: 1 },
        { nodeId: 'b', newParentId: 'R', position: 1 },
      ]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'POSITION_CONFLICT',
  );
});

test('位置越界：整批失败', () => {
  const state = buildStateFromInput(nested('R', nested('a'), nested('b')));
  // R 最终孩子数 k=2，位置 2 越界。
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'a', newParentId: 'R', position: 2 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'POSITION_OUT_OF_RANGE',
  );
});

test('最终成环：整批失败（包括经由未编辑后代的环）', () => {
  const state = chainState();
  // A 搬到自己的后代 C 下。
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'A', newParentId: 'C', position: 0 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'CYCLE',
  );
  // 两个被编辑节点互挂。
  assert.throws(
    () =>
      applyBatch(state, [
        { nodeId: 'A', newParentId: 'C', position: 0 },
        { nodeId: 'C', newParentId: 'A', position: 0 },
      ]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'CYCLE',
  );
});

test('搬迁后最深后代进入第 13 层：整批失败', () => {
  // 构造 12 层链 n1..n12，另挂一个带 2 层子树的节点 m 在 n1 下；
  // 把 m 搬到 n11 下会使 m 的孙节点到达第 13 层。
  let deep: MindMapNodeInput = nested('n12');
  for (let index = 11; index >= 1; index -= 1) {
    deep = nested(`n${index}`, deep);
  }
  // n1 下再挂 m(c1(c2))：初始 m 在第 2 层，c2 在第 4 层，合法。
  const root = nested('R', deep, nested('m', nested('c1', nested('c2'))));
  // 上面 deep 从 n1 开始挂在 R 下：n1 第 2 层 … n12 第 13 层，超了。
  // 调整为 11 层链：n1..n11，n11 在第 12 层。
  let chain: MindMapNodeInput = nested('n11');
  for (let index = 10; index >= 1; index -= 1) {
    chain = nested(`n${index}`, chain);
  }
  const state = buildStateFromInput(nested('R', chain, nested('m', nested('c1', nested('c2')))));
  void root;
  // m 搬到 n11（第 12 层）下：m 第 13 层，直接超限。
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'm', newParentId: 'n11', position: 0 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'DEPTH_EXCEEDED',
  );
  // m 搬到 n10（第 11 层）下：m 第 12 层合法，但 c2 到第 14 层？m=12, c1=13 超限。
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'm', newParentId: 'n10', position: 0 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'DEPTH_EXCEEDED',
  );
  // 搬到 n9（第 10 层）下：m=11, c1=12, c2=13 仍超限。
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'm', newParentId: 'n9', position: 0 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'DEPTH_EXCEEDED',
  );
  // 搬到 n8（第 9 层）下：m=10, c1=11, c2=12 合法。
  const ok = applyBatch(state, [{ nodeId: 'm', newParentId: 'n8', position: 0 }]);
  assert.deepEqual(ok.children.get('n8')?.[0], 'm');
});

test('其他非法输入：根不可搬、节点不存在、重复节点、超量编辑', () => {
  const state = chainState();
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'R', newParentId: 'A', position: 0 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'ROOT_NOT_MOVABLE',
  );
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'ghost', newParentId: 'R', position: 0 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'NODE_NOT_FOUND',
  );
  assert.throws(
    () => applyBatch(state, [{ nodeId: 'A', newParentId: 'ghost', position: 0 }]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'PARENT_NOT_FOUND',
  );
  assert.throws(
    () =>
      applyBatch(state, [
        { nodeId: 'A', newParentId: 'R', position: 0 },
        { nodeId: 'A', newParentId: 'R', position: 1 },
      ]),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'DUPLICATE_NODE',
  );
  const tooMany: EditOperation[] = Array.from({ length: 51 }, (_, index) => ({
    nodeId: `n${index}`,
    newParentId: 'R',
    position: index,
  }));
  assert.throws(
    () => applyBatch(state, tooMany),
    (error: unknown) => error instanceof BatchValidationError && error.reason === 'TOO_MANY_EDITS',
  );
});

test('applyBatch 不修改原状态', () => {
  const state = buildStateFromInput(nested('R', nested('a'), nested('b')));
  const before = shape(state);
  applyBatch(state, [{ nodeId: 'b', newParentId: 'R', position: 0 }]);
  assert.equal(shape(state), before);
});
