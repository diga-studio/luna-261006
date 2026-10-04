import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlSite } from '../src/crawl.js';
import type { PageReader, PageResult, SiteGraph } from '../src/crawl.js';

/** 用固定站点表构造读取器，并统计每个地址的读取次数。 */
function makeReader(site: Record<string, PageResult>, delay?: (url: string) => number) {
  const counts = new Map<string, number>();
  const reader: PageReader = async (url) => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    const ms = delay?.(url) ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    const result = site[url];
    if (!result) throw new Error(`unexpected read: ${url}`);
    return result;
  };
  return { reader, counts };
}

const links = (...urls: string[]): PageResult => ({ kind: 'links', links: urls });
const redirect = (target: string): PageResult => ({ kind: 'redirect', target });

function assertEveryReadOnce(counts: Map<string, number>): void {
  for (const [url, n] of counts) {
    assert.equal(n, 1, `${url} read ${n} times`);
  }
}

function depthsOf(graph: SiteGraph): Record<string, number> {
  return Object.fromEntries([...graph.depths.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function edgesOf(graph: SiteGraph): string[] {
  return graph.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`).sort();
}

// 场景 1：长路径先返回，子树已读取后才暴露更短入口（连续重定向）。
// 站点结构（D=2）：
//   /        -> /p, /q
//   /p       -> /p/r            （长路径：/p/r 先以深度 2 被读取）
//   /q       => /q1             （重定向）
//   /q1      => /p/r            （重定向：/p/r 更短入口，深度修正为 1）
//   /p/r     -> /p/r/s          （先以深度 3 被拒，修正后深度 2 进入范围）
//   /p/r/s   -> /leaf           （/leaf 深度 3，始终越界，不得读取）
const site1: Record<string, PageResult> = {
  'http://example.com/': links('/p', '/q'),
  'http://example.com/p': links('/p/r'),
  'http://example.com/q': redirect('/q1'),
  'http://example.com/q1': redirect('/p/r'),
  'http://example.com/p/r': links('/p/r/s'),
  'http://example.com/p/r/s': links('/leaf'),
};

const expected1Nodes = [
  'http://example.com/',
  'http://example.com/p',
  'http://example.com/p/r',
  'http://example.com/p/r/s',
  'http://example.com/q',
  'http://example.com/q1',
];

const expected1Depths: Record<string, number> = {
  'http://example.com/': 0,
  'http://example.com/p': 1,
  'http://example.com/q': 1,
  'http://example.com/q1': 1,
  'http://example.com/p/r': 1,
  'http://example.com/p/r/s': 2,
};

const expected1Edges = [
  'http://example.com/ -link-> http://example.com/p',
  'http://example.com/ -link-> http://example.com/q',
  'http://example.com/p -link-> http://example.com/p/r',
  'http://example.com/p/r -link-> http://example.com/p/r/s',
  'http://example.com/q -redirect-> http://example.com/q1',
  'http://example.com/q1 -redirect-> http://example.com/p/r',
];

function assertScenario1(graph: SiteGraph, counts: Map<string, number>): void {
  assert.deepEqual(graph.nodes, expected1Nodes);
  assert.deepEqual(depthsOf(graph), expected1Depths);
  assert.deepEqual(edgesOf(graph), expected1Edges);
  assert.equal(graph.seed, 'http://example.com/');
  // 每个已接纳地址只读取一次，且没有读取任何越界地址（如 /leaf）。
  assertEveryReadOnce(counts);
  assert.equal(counts.size, expected1Nodes.length);
}

test('长路径先返回，更短入口与连续重定向后出现，深度被修正', async () => {
  const { reader, counts } = makeReader(site1);
  const graph = await crawlSite('http://example.com/', 2, reader);
  assertScenario1(graph, counts);
});

test('读取完成顺序任意时结果不变（随机延迟）', async () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 20;
  };
  const { reader, counts } = makeReader(site1, () => rand());
  const graph = await crawlSite('http://example.com/', 2, reader);
  assertScenario1(graph, counts);
});

// 场景 2：重定向环、多入口汇合、仅片段/主机大小写/默认端口不同的地址混合。
// 站点结构（D=2）：
//   种子 HTTP://EXAMPLE.com:80/a#frag 规范化为 http://example.com/a
//   /a      -> /b#x, http://example.com:80/b, HTTP://Example.COM/b, /c, /d, /e,
//              https://other.com/off, ftp://example.com/no, /q?b=2&a=1
//   /b      => /c   （/b 与 /c 互相重定向成环）
//   /c      => /b
//   /d, /e  -> /shared           （多入口汇合，/shared 只读一次）
//   /shared => /final            （深度恰为 D 的重定向仍可继续）
//   /final  -> /deep             （/deep 深度 3，越界不读）
const site2: Record<string, PageResult> = {
  'http://example.com/a': links(
    '/b#x',
    'http://example.com:80/b',
    'HTTP://Example.COM/b',
    '/c',
    '/d',
    '/e',
    'https://other.com/off',
    'ftp://example.com/no',
    '/q?b=2&a=1',
  ),
  'http://example.com/b': redirect('/c'),
  'http://example.com/c': redirect('/b'),
  'http://example.com/d': links('/shared'),
  'http://example.com/e': links('/shared'),
  'http://example.com/shared': redirect('/final'),
  'http://example.com/final': links('/deep'),
  'http://example.com/q?b=2&a=1': links(),
};

test('重定向环、多入口汇合与规范化判重', async () => {
  const { reader, counts } = makeReader(site2);
  const graph = await crawlSite('HTTP://EXAMPLE.com:80/a#frag', 2, reader);

  assert.equal(graph.seed, 'http://example.com/a');
  assert.deepEqual(graph.nodes, [
    'http://example.com/a',
    'http://example.com/b',
    'http://example.com/c',
    'http://example.com/d',
    'http://example.com/e',
    'http://example.com/final',
    'http://example.com/q?b=2&a=1',
    'http://example.com/shared',
  ]);
  assert.deepEqual(depthsOf(graph), {
    'http://example.com/a': 0,
    'http://example.com/b': 1,
    'http://example.com/c': 1,
    'http://example.com/d': 1,
    'http://example.com/e': 1,
    'http://example.com/q?b=2&a=1': 1,
    'http://example.com/shared': 2,
    'http://example.com/final': 2,
  });
  // 判重：/b 的三种写法只读取一次；环中每个地址只读取一次。
  assertEveryReadOnce(counts);
  assert.equal(counts.get('http://example.com/b'), 1);
  assert.equal(counts.get('http://example.com/c'), 1);
  assert.equal(counts.get('http://example.com/shared'), 1);
  // 越界与异源地址从未被读取。
  assert.equal(counts.has('http://example.com/deep'), false);
  assert.equal(counts.size, graph.nodes.length);
  // 边：包含环与汇合关系，且不含指向未接纳地址的边。
  assert.deepEqual(edgesOf(graph), [
    'http://example.com/a -link-> http://example.com/b',
    'http://example.com/a -link-> http://example.com/c',
    'http://example.com/a -link-> http://example.com/d',
    'http://example.com/a -link-> http://example.com/e',
    'http://example.com/a -link-> http://example.com/q?b=2&a=1',
    'http://example.com/b -redirect-> http://example.com/c',
    'http://example.com/c -redirect-> http://example.com/b',
    'http://example.com/d -link-> http://example.com/shared',
    'http://example.com/e -link-> http://example.com/shared',
    'http://example.com/shared -redirect-> http://example.com/final',
  ]);
});

test('查询参数顺序保留且不同的参数顺序视为不同地址', async () => {
  const site: Record<string, PageResult> = {
    'http://example.com/': links('/q?b=2&a=1', '/q?a=1&b=2'),
    'http://example.com/q?b=2&a=1': links(),
    'http://example.com/q?a=1&b=2': links(),
  };
  const { reader, counts } = makeReader(site);
  const graph = await crawlSite('http://example.com/', 1, reader);
  assert.deepEqual(graph.nodes, [
    'http://example.com/',
    'http://example.com/q?a=1&b=2',
    'http://example.com/q?b=2&a=1',
  ]);
  assertEveryReadOnce(counts);
});

test('普通链接环正常结束', async () => {
  const site: Record<string, PageResult> = {
    'http://example.com/': links('/x'),
    'http://example.com/x': links('/y'),
    'http://example.com/y': links('/x', '/'),
  };
  const { reader, counts } = makeReader(site);
  const graph = await crawlSite('http://example.com/', 5, reader);
  assert.deepEqual(depthsOf(graph), {
    'http://example.com/': 0,
    'http://example.com/x': 1,
    'http://example.com/y': 2,
  });
  assertEveryReadOnce(counts);
});

test('D=0 时只读取种子', async () => {
  const site: Record<string, PageResult> = {
    'http://example.com/': links('/a', '/b'),
  };
  const { reader, counts } = makeReader(site);
  const graph = await crawlSite('http://example.com/', 0, reader);
  assert.deepEqual(graph.nodes, ['http://example.com/']);
  assert.deepEqual(depthsOf(graph), { 'http://example.com/': 0 });
  assert.equal(counts.size, 1);
});

test('非法种子与非法深度被拒绝', async () => {
  const { reader } = makeReader({});
  await assert.rejects(() => crawlSite('ftp://example.com/', 1, reader));
  await assert.rejects(() => crawlSite('not a url', 1, reader));
  await assert.rejects(() => crawlSite('http://example.com/', -1, reader));
});
