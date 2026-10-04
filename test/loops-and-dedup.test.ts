import assert from 'node:assert/strict';
import test from 'node:test';
import { crawlSite, type SiteGraph } from '../src/index.js';
import { ControlledReader, links, redirect, tick } from './helpers.js';

const S = 'http://example.com/';
const DUP = 'http://example.com/dup';
const Q1 = 'http://example.com/q?b=2&a=1';
const Q2 = 'http://example.com/q?a=1&b=2';
const L1 = 'http://example.com/l1';
const L2 = 'http://example.com/l2';
const C1 = 'http://example.com/c1';
const C2 = 'http://example.com/c2';
const M1 = 'http://example.com/m1';
const M2 = 'http://example.com/m2';
const SHARED = 'http://example.com/shared';
const LEAF = 'http://example.com/leaf';
const SELF = 'http://example.com/self';

// 混合场景（D = 3）：
// - /dup 的三个入口仅片段、主机大小写、默认端口不同，应判重为一个地址；
// - 查询参数顺序不同是两个地址；非 http(s) 与跨源地址被拒绝；
// - /l1 ↔ /l2 重定向环，/c1 ↔ /c2 普通链接环，/self 自重定向；
// - /shared 从 /m1、/m2 两个入口汇合，只读一次。
const PAGES = {
  [S]: links(
    '/dup#section-1',
    'http://example.com:80/dup#other',
    'http://EXAMPLE.COM/dup',
    '/q?b=2&a=1',
    '/q?a=1&b=2',
    'ftp://example.com/x',
    'mailto:a@b.c',
    'https://example.com/secure',
    'http://other.com/x',
    'http://example.com:8080/dup',
    '/l1',
    '/c1',
    '/m1',
    '/m2',
    '/self',
  ),
  [DUP]: links('/dup#top'),
  [Q1]: links(),
  [Q2]: links(),
  [L1]: redirect('l2'),
  [L2]: redirect('/l1#frag'),
  [C1]: links('/c2'),
  [C2]: links('/c1', '//example.com/c1'),
  [M1]: links('/shared'),
  [M2]: links('/shared'),
  [SHARED]: links('/leaf'),
  [LEAF]: links(),
  [SELF]: redirect('/self#frag'),
} as const;

const EXPECTED_DEPTHS: Record<string, number> = {
  [S]: 0,
  [DUP]: 1,
  [Q1]: 1,
  [Q2]: 1,
  [L1]: 1,
  [L2]: 1,
  [C1]: 1,
  [M1]: 1,
  [M2]: 1,
  [SELF]: 1,
  [C2]: 2,
  [SHARED]: 2,
  [LEAF]: 3,
};

const EXPECTED_EDGES = [
  { from: S, to: DUP, kind: 'link' },
  { from: S, to: Q1, kind: 'link' },
  { from: S, to: Q2, kind: 'link' },
  { from: S, to: L1, kind: 'link' },
  { from: S, to: C1, kind: 'link' },
  { from: S, to: M1, kind: 'link' },
  { from: S, to: M2, kind: 'link' },
  { from: S, to: SELF, kind: 'link' },
  { from: DUP, to: DUP, kind: 'link' },
  { from: L1, to: L2, kind: 'redirect' },
  { from: L2, to: L1, kind: 'redirect' },
  { from: C1, to: C2, kind: 'link' },
  { from: C2, to: C1, kind: 'link' },
  { from: M1, to: SHARED, kind: 'link' },
  { from: M2, to: SHARED, kind: 'link' },
  { from: SHARED, to: LEAF, kind: 'link' },
  { from: SELF, to: SELF, kind: 'redirect' },
].sort((m, n) =>
  m.from !== n.from ? (m.from < n.from ? -1 : 1) : m.to < n.to ? -1 : 1,
);

/** 逐个解决挂起的读取；lifo=true 时后发现的先完成，制造不同完成顺序。 */
async function runAll(
  reader: ControlledReader,
  pending: Promise<SiteGraph>,
  lifo: boolean,
): Promise<SiteGraph> {
  for (;;) {
    await tick();
    const urls = reader.pending();
    if (urls.length === 0) break;
    if (lifo) urls.reverse();
    for (const url of urls) reader.resolve(url);
  }
  return pending;
}

test('重定向环、链接环、多入口汇合与判重变体混合：正常结束且结果正确', async () => {
  const reader = new ControlledReader({ ...PAGES });
  const graph = await runAll(reader, crawlSite(S, 3, reader.reader), false);

  const depths = Object.fromEntries(graph.nodes.map((n) => [n.url, n.depth]));
  assert.deepEqual(depths, EXPECTED_DEPTHS);
  assert.deepEqual(graph.edges, EXPECTED_EDGES);

  // 每个已接纳地址恰好读取一次。
  for (const url of Object.keys(EXPECTED_DEPTHS)) {
    assert.equal(reader.count(url), 1, `${url} 应只读取一次`);
  }
  assert.equal(reader.totalReads(), Object.keys(EXPECTED_DEPTHS).length);

  // 判重：变体形式不应作为独立地址出现。
  const urls = graph.nodes.map((n) => n.url);
  assert.ok(!urls.some((u) => u.includes('#')), '地址不应包含片段');
  assert.ok(!urls.some((u) => u.includes('EXAMPLE.COM')), '主机应小写化');
  assert.ok(!urls.some((u) => u.includes(':80/')), '默认端口应被去掉');
  assert.ok(!urls.some((u) => u.includes(':8080')), '非默认端口即跨源，应被拒绝');
  assert.ok(!urls.some((u) => u.startsWith('https:')), '不同协议即跨源，应被拒绝');
});

test('同样的混合场景在相反的完成顺序下结果一致', async () => {
  const run = async (lifo: boolean): Promise<SiteGraph> => {
    const reader = new ControlledReader({ ...PAGES });
    return runAll(reader, crawlSite(S, 3, reader.reader), lifo);
  };
  const fifo = await run(false);
  const lifo = await run(true);
  assert.deepEqual(fifo, lifo);
  assert.deepEqual(lifo.edges, EXPECTED_EDGES);
});
