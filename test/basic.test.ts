import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { DocumentIndex, Doc } from '../src/index';
import { tempDbPath, modelSearch } from './helpers';

async function withIndex(
  fn: (idx: DocumentIndex, docs: Map<string, Doc>) => Promise<void>
): Promise<void> {
  const { path, cleanup } = tempDbPath();
  const idx = new DocumentIndex({ path });
  const docs = new Map<string, Doc>();
  try {
    await fn(idx, docs);
  } finally {
    await idx.close();
    cleanup();
  }
}

test('initial state: generation 0, empty field set, no hits', async () => {
  await withIndex(async (idx, docs) => {
    docs.set('a', { title: 'hello world' });
    await idx.put('a', docs.get('a') as Doc);
    const r = await idx.search('hello');
    equal(r.generation, 0);
    deepEqual(r.ids, []);
  });
});

test('put, replace, delete against the published index', async () => {
  await withIndex(async (idx, docs) => {
    const seed: Array<[string, Doc]> = [
      ['a', { title: 'Hello brave world', body: 'alpha beta' }],
      ['b', { title: 'goodbye', body: 'hello there friend' }],
      ['c', { title: 'nothing here', body: 'gamma' }],
      ['d', { body: 'title less document says hello' }],
    ];
    for (const [id, doc] of seed) {
      docs.set(id, doc);
      await idx.put(id, doc);
    }
    const pub = await idx.rebuild(['title', 'body']);
    equal(pub.status, 'published');
    equal(pub.generation, 1);

    // case-insensitive whole word, any indexed field
    deepEqual(await idx.search('hello'), {
      generation: 1,
      ids: modelSearch(docs, ['title', 'body'], 'hello'),
    });
    // whole word: "hell" and "helloo" must not match "hello"
    deepEqual((await idx.search('hell')).ids, []);
    await idx.put('e', { title: 'hell helloo' });
    docs.set('e', { title: 'hell helloo' });
    deepEqual((await idx.search('hello')).ids, ['a', 'b', 'd']);

    // full replace removes old field values from the index
    docs.set('a', { title: 'replaced entirely', body: 'omega' });
    await idx.put('a', docs.get('a') as Doc);
    deepEqual(
      (await idx.search('hello')).ids,
      modelSearch(docs, ['title', 'body'], 'hello')
    );
    deepEqual((await idx.search('alpha')).ids, []);
    deepEqual((await idx.search('omega')).ids, ['a']);

    // delete
    docs.delete('b');
    await idx.put('b', null);
    deepEqual(
      (await idx.search('hello')).ids,
      modelSearch(docs, ['title', 'body'], 'hello')
    );

    // missing fields are allowed
    docs.set('f', {});
    await idx.put('f', {});
    deepEqual(
      (await idx.search('hello')).ids,
      modelSearch(docs, ['title', 'body'], 'hello')
    );
  });
});

test('unindexed fields do not match until a rebuild publishes them', async () => {
  await withIndex(async (idx, docs) => {
    docs.set('a', { title: 'hello', secret: 'hidden treasure' });
    await idx.put('a', docs.get('a') as Doc);
    await idx.rebuild(['title']);
    deepEqual((await idx.search('hidden')).ids, []);
    const pub = await idx.rebuild(['title', 'secret']);
    equal(pub.generation, 2);
    deepEqual(await idx.search('hidden'), { generation: 2, ids: ['a'] });
  });
});

test('rebuild with empty field set publishes an empty index', async () => {
  await withIndex(async (idx, docs) => {
    docs.set('a', { title: 'hello' });
    await idx.put('a', docs.get('a') as Doc);
    await idx.rebuild(['title']);
    deepEqual((await idx.search('hello')).ids, ['a']);
    const pub = await idx.rebuild([]);
    equal(pub.status, 'published');
    deepEqual(await idx.search('hello'), { generation: 2, ids: [] });
  });
});

test('generations increment per rebuild call', async () => {
  await withIndex(async (idx) => {
    const r1 = await idx.rebuild(['title']);
    const r2 = await idx.rebuild(['title']);
    equal(r1.generation, 1);
    equal(r2.generation, 2);
    equal((await idx.search('hello')).generation, 2);
  });
});

test('validation: bad term, bad doc values, bad id', async () => {
  await withIndex(async (idx) => {
    await rejects(() => idx.search('Hello'));
    await rejects(() => idx.search('two words'));
    await rejects(() => idx.search('hello123'));
    await rejects(() => idx.put('', { title: 'x' }));
    await rejects(() => idx.put('a', { title: 'digits 9' }));
    await rejects(() => idx.put('a', { title: 5 as unknown as string }));
  });
});

async function rejects(fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  equal(threw, true);
}
