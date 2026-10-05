import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../src/index.js";
function tmpPath() {
    return join(mkdtempSync(join(tmpdir(), "fts5-idx-")), "index.db");
}
/** Expected ids: docs where `term` appears as a full word in any of `fields`. */
function expected(docs, fields, term) {
    const out = [];
    for (const [id, doc] of docs) {
        for (const field of fields) {
            const value = doc[field];
            if (value !== undefined && value.toLowerCase().split(/\s+/).includes(term)) {
                out.push(id);
                break;
            }
        }
    }
    return out.sort();
}
async function expectSearch(idx, docs, generationFields, term) {
    const result = await idx.search(term);
    const fields = generationFields.get(result.generation);
    assert.ok(fields !== undefined, `unexpected generation ${result.generation}`);
    assert.deepEqual(result.ids, expected(docs, fields, term), `search("${term}") at generation ${result.generation}`);
}
/** A one-shot gate: blocks `wait()` callers until `release()` is called. */
function gate() {
    let entered;
    let release;
    const enteredP = new Promise((r) => (entered = r));
    const gateP = new Promise((r) => (release = r));
    return {
        enteredP,
        release,
        wait: async () => {
            entered();
            await gateP;
        },
    };
}
test("basic put/replace/delete, full-word case-insensitive match, empty generations", async (t) => {
    const path = tmpPath();
    t.after(() => rmSync(path, { force: true }));
    const idx = openIndex(path);
    t.after(() => idx.close());
    // Generation 0: empty field set, nothing is searchable.
    await idx.put("a", { title: "Hello World", body: "foo" });
    assert.deepEqual(await idx.search("hello"), { generation: 0, ids: [] });
    const r1 = await idx.rebuild(["title", "body"]);
    assert.deepEqual(r1, { generation: 1, status: "published" });
    // Case-insensitive full-word match across any indexed field.
    assert.deepEqual(await idx.search("hello"), { generation: 1, ids: ["a"] });
    await idx.put("b", { title: "bar", body: "say hello there" });
    assert.deepEqual(await idx.search("hello"), { generation: 1, ids: ["a", "b"] });
    // Whole-document replacement: old field values must not survive.
    await idx.put("a", { title: "completely different", body: "text" });
    assert.deepEqual(await idx.search("hello"), { generation: 1, ids: ["b"] });
    assert.deepEqual(await idx.search("world"), { generation: 1, ids: [] });
    // Delete.
    await idx.put("b", null);
    assert.deepEqual(await idx.search("hello"), { generation: 1, ids: [] });
    // Missing fields are allowed.
    await idx.put("c", { title: "only title" });
    assert.deepEqual(await idx.search("only"), { generation: 1, ids: ["c"] });
    // Rebuild with an empty field set publishes an empty index.
    const r2 = await idx.rebuild([]);
    assert.deepEqual(r2, { generation: 2, status: "published" });
    assert.deepEqual(await idx.search("only"), { generation: 2, ids: [] });
    // Invalid terms are rejected.
    await assert.rejects(() => idx.search("Hello"));
    await assert.rejects(() => idx.search("hello world"));
});
test("rebuild stays online: concurrent insert/replace/delete and interleaved searches", async (t) => {
    const path = tmpPath();
    t.after(() => rmSync(path, { force: true }));
    const docs = new Map();
    const generationFields = new Map([[0, []]]);
    // Gate pauses the rebuild between scan batches until released.
    const g = gate();
    let paused = true;
    const idx = openIndex(path, {
        onScanBatch: async (generation) => {
            if (paused && generation === 2)
                await g.wait();
        },
    });
    t.after(() => idx.close());
    // Seed 1000 documents so the rebuild scans several batches.
    for (let i = 0; i < 1000; i++) {
        const id = `d${String(i).padStart(4, "0")}`;
        const doc = { f1: `alpha w${i}`, f2: `omega w${i}` };
        docs.set(id, doc);
        await idx.put(id, doc);
    }
    const r1 = await idx.rebuild(["f1"]);
    assert.deepEqual(r1, { generation: 1, status: "published" });
    generationFields.set(1, ["f1"]);
    // Start a rebuild over f2. The first batch (d0000..d0255) is scanned
    // synchronously, then the rebuild blocks on the gate.
    const rebuildP = idx.rebuild(["f2"]);
    await g.enteredP;
    // Modifications while the rebuild is in flight.
    const apply = async (id, doc) => {
        await idx.put(id, doc);
        if (doc === null)
            docs.delete(id);
        else
            docs.set(id, doc);
    };
    await apply("d0001", { f1: "alpha w1", f2: "beta" }); // replace already-scanned doc
    await apply("d0002", null); // delete already-scanned doc
    await apply("d0999", { f1: "alpha w999", f2: "beta" }); // replace not-yet-scanned doc
    await apply("d0500", null); // delete not-yet-scanned doc
    await apply("new1", { f1: "alpha n1", f2: "beta" }); // insert new doc
    await apply("d0003", { f1: "gamma", f2: "x" }); // replace already-scanned doc
    // Reads and writes still complete while the rebuild is unfinished, and the
    // old (published) generation reflects every committed modification.
    await expectSearch(idx, docs, generationFields, "alpha");
    await expectSearch(idx, docs, generationFields, "gamma");
    await expectSearch(idx, docs, generationFields, "omega");
    await expectSearch(idx, docs, generationFields, "beta");
    // More modifications, then re-check: each search must match its generation.
    await apply("d0004", { f1: "gamma too", f2: "beta" });
    await apply("d0003", null);
    await expectSearch(idx, docs, generationFields, "gamma");
    await expectSearch(idx, docs, generationFields, "alpha");
    // Let the rebuild finish and publish.
    paused = false;
    g.release();
    const r2 = await rebuildP;
    assert.deepEqual(r2, { generation: 2, status: "published" });
    generationFields.set(2, ["f2"]);
    // The published index contains every change committed before publication:
    // no resurrected old values, no missing entries, no deleted documents.
    await expectSearch(idx, docs, generationFields, "beta");
    await expectSearch(idx, docs, generationFields, "omega");
    await expectSearch(idx, docs, generationFields, "alpha");
    await expectSearch(idx, docs, generationFields, "gamma");
    const beta = await idx.search("beta");
    assert.deepEqual(beta, { generation: 2, ids: ["d0001", "d0004", "d0999", "new1"] });
});
test("overlapping rebuilds: older call is superseded and never regresses the index", async (t) => {
    const path = tmpPath();
    t.after(() => rmSync(path, { force: true }));
    const docs = new Map();
    const generationFields = new Map([[0, []]]);
    // Gate pauses only the older rebuild (generation 2).
    const g = gate();
    const idx = openIndex(path, {
        onScanBatch: async (generation) => {
            if (generation === 2)
                await g.wait();
        },
    });
    t.after(() => idx.close());
    for (let i = 0; i < 600; i++) {
        const id = `d${String(i).padStart(4, "0")}`;
        const doc = { f1: `alpha w${i}`, f2: `beta w${i}`, f3: `gamma w${i}` };
        docs.set(id, doc);
        await idx.put(id, doc);
    }
    assert.deepEqual(await idx.rebuild(["f1"]), { generation: 1, status: "published" });
    generationFields.set(1, ["f1"]);
    // Older rebuild over f2: allocates generation 2, then blocks mid-scan.
    const olderP = idx.rebuild(["f2"]);
    await g.enteredP;
    // Newer rebuild over f3: allocates generation 3 and finishes first.
    const newer = await idx.rebuild(["f3"]);
    assert.deepEqual(newer, { generation: 3, status: "published" });
    generationFields.set(3, ["f3"]);
    // Writes still land on the freshly published index.
    docs.set("d0000", { f1: "alpha w0", f2: "beta w0", f3: "delta" });
    await idx.put("d0000", docs.get("d0000"));
    await expectSearch(idx, docs, generationFields, "delta");
    await expectSearch(idx, docs, generationFields, "gamma");
    // The older rebuild finishes last: it must be superseded and must not
    // overwrite the newer published index.
    g.release();
    assert.deepEqual(await olderP, { generation: 2, status: "superseded" });
    await expectSearch(idx, docs, generationFields, "gamma");
    await expectSearch(idx, docs, generationFields, "delta");
    const beta = await idx.search("beta");
    assert.deepEqual(beta, { generation: 3, ids: [] }); // f2 is not indexed at gen 3
});
