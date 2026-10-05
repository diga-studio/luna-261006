import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { DocumentIndex, Doc } from '../src/index';
import { tempDbPath, modelSearch } from './helpers';

function pad(n: number): string {
  return 'd' + String(n).padStart(4, '0');
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// 1500 docs => the rebuild scan takes several batches, leaving plenty of
// room for puts and searches to interleave while it is in flight.
test('reads and writes during rebuild; publish swaps a complete index', async () => {
  const { path, cleanup } = tempDbPath();
  const idx = new DocumentIndex({ path });
  const docs = new Map<string, Doc>();
  try {
    for (let i = 1; i <= 1500; i++) {
      const doc = { title: 'alpha item', body: 'beta item' };
      docs.set(pad(i), doc);
      await idx.put(pad(i), doc);
    }
    const g1 = await idx.rebuild(['title']);
    equal(g1.status, 'published');
    equal(g1.generation, 1);

    // Start the rebuild. Its first scan batch (d0001..d0500) has already
    // been processed synchronously when the call returns.
    const p = idx.rebuild(['title', 'body']);

    // Writes while the rebuild is in flight:
    // - replace an already-scanned doc and a not-yet-scanned doc
    docs.set('d0001', { title: 'gamma one', body: 'delta one' });
    await idx.put('d0001', docs.get('d0001') as Doc);
    docs.set('d1499', { title: 'gamma nine', body: 'delta nine' });
    await idx.put('d1499', docs.get('d1499') as Doc);
    // - delete an already-scanned doc and a not-yet-scanned doc
    docs.delete('d0002');
    await idx.put('d0002', null);
    docs.delete('d1498');
    await idx.put('d1498', null);
    // - insert brand new docs
    docs.set('d1501', { title: 'alpha extra', body: 'beta extra' });
    await idx.put('d1501', docs.get('d1501') as Doc);
    docs.set('d1502', { title: 'epsilon extra', body: 'zeta extra' });
    await idx.put('d1502', docs.get('d1502') as Doc);

    // Let the rebuild run another batch, then write some more.
    await tick();
    docs.set('d0003', { title: 'gamma three', body: 'delta three' });
    await idx.put('d0003', docs.get('d0003') as Doc);
    docs.delete('d1000');
    await idx.put('d1000', null);

    // Searches while the rebuild is still running: served by the old
    // generation (1, fields = ['title']) and reflecting every put so far.
    const during1 = await idx.search('alpha');
    equal(during1.generation, 1);
    deepEqual(during1.ids, modelSearch(docs, ['title'], 'alpha'));
    const during2 = await idx.search('gamma');
    equal(during2.generation, 1);
    deepEqual(during2.ids, modelSearch(docs, ['title'], 'gamma'));
    // body is not part of the old field set yet
    deepEqual((await idx.search('beta')).ids, []);
    deepEqual((await idx.search('delta')).ids, []);

    const g2 = await p;
    equal(g2.status, 'published');
    equal(g2.generation, 2);

    // After publish: the new field set serves, and the index must contain
    // every change committed before the publish - no resurrected old
    // values, no missing docs, no deleted docs.
    const after1 = await idx.search('alpha');
    equal(after1.generation, 2);
    deepEqual(after1.ids, modelSearch(docs, ['title', 'body'], 'alpha'));
    deepEqual(
      (await idx.search('beta')).ids,
      modelSearch(docs, ['title', 'body'], 'beta')
    );
    deepEqual(
      (await idx.search('gamma')).ids,
      modelSearch(docs, ['title', 'body'], 'gamma')
    );
    deepEqual(
      (await idx.search('delta')).ids,
      modelSearch(docs, ['title', 'body'], 'delta')
    );

    // Spot checks against stale content.
    const alpha = (await idx.search('alpha')).ids;
    equal(alpha.includes('d0001'), false, 'replaced doc must not match its old title');
    equal(alpha.includes('d1499'), false, 'replaced doc must not match its old title');
    equal(alpha.includes('d0002'), false, 'deleted doc must be gone');
    equal(alpha.includes('d1498'), false, 'deleted doc must be gone');
    equal(alpha.includes('d1000'), false, 'deleted doc must be gone');
    equal(alpha.includes('d1501'), true, 'inserted doc must be present');
    const gamma = (await idx.search('gamma')).ids;
    deepEqual(gamma.sort(), ['d0001', 'd0003', 'd1499']);
    const delta = (await idx.search('delta')).ids;
    deepEqual(delta.sort(), ['d0001', 'd0003', 'd1499']);

    // The index keeps tracking puts after the publish.
    docs.set('d1503', { title: 'alpha late', body: 'beta late' });
    await idx.put('d1503', docs.get('d1503') as Doc);
    deepEqual(
      (await idx.search('beta')).ids,
      modelSearch(docs, ['title', 'body'], 'beta')
    );
  } finally {
    await idx.close();
    cleanup();
  }
});
