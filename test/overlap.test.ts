import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { DocumentIndex, Doc } from '../src/index';
import { tempDbPath, modelSearch } from './helpers';

function pad(n: number): string {
  return 'd' + String(n).padStart(4, '0');
}

async function seed(
  idx: DocumentIndex,
  docs: Map<string, Doc>,
  n: number
): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const doc = { title: 'alpha item', body: 'beta item' };
    docs.set(pad(i), doc);
    await idx.put(pad(i), doc);
  }
}

test('newer rebuild with another field set finishes first; older ends superseded', async () => {
  const { path, cleanup } = tempDbPath();
  const idx = new DocumentIndex({ path });
  const docs = new Map<string, Doc>();
  try {
    await seed(idx, docs, 1500);
    const g1 = await idx.rebuild(['title']);
    equal(g1.status, 'published');

    // Older rebuild: long scan over 1500 docs, stays in flight.
    const pOld = idx.rebuild(['title', 'body']);
    // Newer rebuild with a different (empty) field set: publishes at once,
    // before the older one finishes scanning.
    const pNew = idx.rebuild([]);

    const rNew = await pNew;
    deepEqual(rNew, { generation: 3, status: 'published' });
    const rOld = await pOld;
    deepEqual(rOld, { generation: 2, status: 'superseded' });

    // No version regression: searches keep seeing generation 3.
    const s1 = await idx.search('alpha');
    equal(s1.generation, 3);
    deepEqual(s1.ids, []);

    // Writes still tracked by the serving (empty) index.
    docs.set('d1501', { title: 'alpha extra', body: 'beta extra' });
    await idx.put('d1501', docs.get('d1501') as Doc);
    const s2 = await idx.search('alpha');
    equal(s2.generation, 3);
    deepEqual(s2.ids, []);

    // A later rebuild publishes normally on top.
    const g3 = await idx.rebuild(['title']);
    equal(g3.status, 'published');
    equal(g3.generation, 4);
    deepEqual(
      (await idx.search('alpha')).ids,
      modelSearch(docs, ['title'], 'alpha')
    );
    equal((await idx.search('alpha')).generation, 4);
  } finally {
    await idx.close();
    cleanup();
  }
});

test('overlapping rebuilds: only the newest entered may publish', async () => {
  const { path, cleanup } = tempDbPath();
  const idx = new DocumentIndex({ path });
  const docs = new Map<string, Doc>();
  try {
    await seed(idx, docs, 1500);
    await idx.rebuild(['title']);

    // Two overlapping rebuilds with different field sets. The older one
    // started first, so it reaches its publish attempt first - but the
    // newer one has already entered, so the older must be superseded.
    const pOld = idx.rebuild(['title', 'body']);
    const pNew = idx.rebuild(['body']);
    const rOld = await pOld;
    const rNew = await pNew;
    deepEqual(rOld, { generation: 2, status: 'superseded' });
    deepEqual(rNew, { generation: 3, status: 'published' });

    // The serving index uses the newest field set; no regression to 2.
    const sTitle = await idx.search('alpha');
    equal(sTitle.generation, 3);
    deepEqual(sTitle.ids, [], 'title is not in the published field set');
    const sBody = await idx.search('beta');
    equal(sBody.generation, 3);
    deepEqual(sBody.ids, modelSearch(docs, ['body'], 'beta'));

    // Writes after the publish are visible; generation stays 3.
    docs.set('d1501', { title: 'alpha extra', body: 'beta extra' });
    await idx.put('d1501', docs.get('d1501') as Doc);
    const s3 = await idx.search('beta');
    equal(s3.generation, 3);
    deepEqual(s3.ids, modelSearch(docs, ['body'], 'beta'));
  } finally {
    await idx.close();
    cleanup();
  }
});

test('puts committed during overlapping rebuilds survive into the published index', async () => {
  const { path, cleanup } = tempDbPath();
  const idx = new DocumentIndex({ path });
  const docs = new Map<string, Doc>();
  try {
    await seed(idx, docs, 1200);
    await idx.rebuild(['title']);

    const pOld = idx.rebuild(['body']);
    const pNew = idx.rebuild(['title', 'body']);
    // Writes while both rebuilds are in flight.
    docs.set('d0001', { title: 'gamma one', body: 'delta one' });
    await idx.put('d0001', docs.get('d0001') as Doc);
    docs.delete('d0002');
    await idx.put('d0002', null);
    docs.set('d1201', { title: 'gamma new', body: 'delta new' });
    await idx.put('d1201', docs.get('d1201') as Doc);

    const rOld = await pOld;
    const rNew = await pNew;
    equal(rOld.status, 'superseded');
    equal(rNew.status, 'published');
    equal(rNew.generation, 3);

    deepEqual(
      (await idx.search('delta')).ids,
      modelSearch(docs, ['title', 'body'], 'delta')
    );
    deepEqual(
      (await idx.search('gamma')).ids,
      modelSearch(docs, ['title', 'body'], 'gamma')
    );
    deepEqual(
      (await idx.search('alpha')).ids,
      modelSearch(docs, ['title', 'body'], 'alpha')
    );
  } finally {
    await idx.close();
    cleanup();
  }
});
