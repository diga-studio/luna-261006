import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlSite, type SiteGraph } from '../src/index.js';
import { ControlledReader, links, redirect, tick } from './helpers.js';

const S = 'http://example.com/';
const A = 'http://example.com/a';
const X = 'http://example.com/x';
const Y = 'http://example.com/y';
const W = 'http://example.com/w';
const V = 'http://example.com/v';
const R0 = 'http://example.com/r0';
const R1 = 'http://example.com/r1';

// 站点结构（D = 2）：
//   S ─link→ /a ─link→ /x ─link→ /y ─link→ /z(超深)
//   │                    └─link→ /w ─redirect→ /v ─link→ /out(超深)
//   └─link→ /r0 ─redirect→ /r1 ─redirect→ /x
// /x 先经长路径 /a 以深度 2 被读取，之后经连续重定向暴露深度 1 的更短入口。
const PAGES = {
  [S]: links('/a', '/r0'),
  [A]: links('/x'),
  [X]: links('/y', '/w'),
  [Y]: links('/z'),
  [W]: redirect('/v'),
  [V]: links('/out'),
  [R0]: redirect('/r1'),
  [R1]: redirect('/x'),
} as const;

const EXPECTED_NODES = [
  { url: S, depth: 0 },
  { url: A, depth: 1 },
  { url: R0, depth: 1 },
  { url: R1, depth: 1 },
  { url: V, depth: 2 },
  { url: W, depth: 2 },
  { url: X, depth: 1 },
  { url: Y, depth: 2 },
].sort((m, n) => (m.url < n.url ? -1 : 1));

const EXPECTED_EDGES = [
  { from: S, to: A, kind: 'link' },
  { from: S, to: R0, kind: 'link' },
  { from: A, to: X, kind: 'link' },
  { from: X, to: Y, kind: 'link' },
  { from: X, to: W, kind: 'link' },
  { from: W, to: V, kind: 'redirect' },
  { from: R0, to: R1, kind: 'redirect' },
  { from: R1, to: X, kind: 'redirect' },
].sort((m, n) =>
  m.from !== n.from ? (m.from < n.from ? -1 : 1) : m.to < n.to ? -1 : 1,
);

const READ_ONCE = [S, A, X, Y, W, V, R0, R1];

async function runInOrder(order: string[]): Promise<{ graph: SiteGraph; reader: ControlledReader }> {
  const reader = new ControlledReader({ ...PAGES });
  const pending = crawlSite(S, 2, reader.reader);
  for (const url of order) {
    await tick();
    assert.ok(reader.pending().includes(url), `expected ${url} to be pending, got ${reader.pending()}`);
    reader.resolve(url);
  }
  const graph = await pending;
  return { graph, reader };
}

test('长路径先返回、子树已读取后出现更短入口与连续重定向', async () => {
  const reader = new ControlledReader({ ...PAGES });
  const pending = crawlSite(S, 2, reader.reader);

  await tick();
  assert.deepEqual(reader.pending(), [S]);
  reader.resolve(S);

  await tick();
  assert.deepEqual(reader.pending().sort(), [A, R0]);
  // 先走长路径：/a → /x（深度 2 读取），/y、/w 此时深度 3 超深，不能读取。
  reader.resolve(A);
  await tick();
  reader.resolve(X);
  await tick();
  assert.deepEqual(reader.pending(), [R0], '超深地址不得被读取');
  assert.equal(reader.count(Y), 0);
  assert.equal(reader.count(W), 0);

  // 更短入口经连续重定向出现：/r0 → /r1 → /x，/x 深度降为 1。
  reader.resolve(R0);
  await tick();
  reader.resolve(R1);
  await tick();
  // /x 已读过不得重读；/y、/w 回到范围内（深度 2），必须被补读。
  assert.equal(reader.count(X), 1);
  assert.deepEqual(reader.pending().sort(), [W, Y]);

  // 深度恰为 D 的页面仍须读取；/w 的重定向在深度 D 上继续。
  reader.resolve(Y);
  await tick();
  assert.equal(reader.count('http://example.com/z'), 0, '/z 深度 3 超深');
  reader.resolve(W);
  await tick();
  assert.deepEqual(reader.pending(), [V]);
  reader.resolve(V);
  await tick();
  assert.equal(reader.count('http://example.com/out'), 0, '/out 深度 3 超深');

  const graph = await pending;
  assert.deepEqual(graph.nodes, EXPECTED_NODES);
  assert.deepEqual(graph.edges, EXPECTED_EDGES);
  assert.equal(graph.seed, S);
  assert.equal(graph.maxDepth, 2);
  for (const url of READ_ONCE) {
    assert.equal(reader.count(url), 1, `${url} 应只读取一次`);
  }
  assert.equal(reader.totalReads(), READ_ONCE.length);
});

test('相同站点不同读取顺序得到完全相同的站点图', async () => {
  const longFirst = await runInOrder([S, A, X, R0, R1, Y, W, V]);
  const shortFirst = await runInOrder([S, R0, R1, A, X, W, V, Y]);
  const interleaved = await runInOrder([S, R0, A, R1, X, Y, W, V]);

  for (const graph of [longFirst.graph, shortFirst.graph, interleaved.graph]) {
    assert.deepEqual(graph.nodes, EXPECTED_NODES);
    assert.deepEqual(graph.edges, EXPECTED_EDGES);
  }
  assert.deepEqual(longFirst.graph, shortFirst.graph);
  assert.deepEqual(longFirst.graph, interleaved.graph);
  for (const run of [longFirst, shortFirst, interleaved]) {
    assert.equal(run.reader.totalReads(), READ_ONCE.length);
  }
});
