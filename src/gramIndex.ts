/**
 * q-gram 倒排索引：对某一字段的全部目录记录建立 q-gram -> 记录 的倒排表，
 * 查询时用 q-gram 计数引理做安全预过滤（只去伪、不丢真）：
 *   ed(a, b) <= k  ⇒  两侧 q-gram 多重集交集大小 >= max(lenA, lenB) - q + 1 - k*q
 * 阈值比较全部用整数运算（tPercent 为百分制整数），不做浮点四舍五入。
 *
 * 内存与装入速度：
 * - 纯 BMP 文本的 q-gram 编码为 48 位数值键（精确无碰撞），装入时用可复用的
 *   Float64Array 收集键、排序后游程统计多重集计数，不在堆上分配临时键对象；
 * - 含非 BMP 字符的文本回退到字符串键的 Map 统计（极少见，保证正确性）；
 * - 装入采用两遍扫描：先统计各 gram 的文档频次，再精确分配倒排数组并填充。
 */

const Q = 3;
const HAS_SURROGATE = /[\uD800-\uDFFF]/;

interface Posting {
  ids: Uint32Array;
  counts: Uint8Array;
}

/** 码点长度：无代理对时等于 UTF-16 长度。 */
function cpLength(text: string): number {
  return HAS_SURROGATE.test(text) ? Array.from(text).length : text.length;
}

/**
 * 把纯 BMP 文本的全部 q-gram 数值键写入 buf，返回写入个数（含重复）。
 * 调用方保证 buf.length >= text.length。
 */
function collectNumKeys(text: string, buf: Float64Array): number {
  const n = text.length;
  let w = 0;
  for (let i = 0; i + Q <= n; i++) {
    buf[w++] =
      text.charCodeAt(i) * 0x1_0000_0000 +
      text.charCodeAt(i + 1) * 0x1_0000 +
      text.charCodeAt(i + 2);
  }
  return w;
}

/** 非 BMP 文本的 q-gram 字符串键多重集计数。 */
function collectStrKeys(text: string, counts: Map<string, number>): void {
  const cps = Array.from(text);
  for (let i = 0; i + Q <= cps.length; i++) {
    const key = cps[i]! + cps[i + 1]! + cps[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

export class GramIndex {
  private readonly lengths: number[] = [];
  private numPostings = new Map<number, Posting>();
  private strPostings = new Map<string, Posting>();
  /** 按码点长度升序排列的记录下标，用于“计数过滤失效”时的短串回退扫描 */
  private orderByLen: Uint32Array = new Uint32Array(0);
  private scores: Int32Array = new Int32Array(0);
  private sealed = false;
  /** 装入期间仅暂存原始文本引用（不复制） */
  private pending: string[] = [];
  private numDf = new Map<number, number>();
  private strDf = new Map<string, number>();
  /** 装入期复用的 gram 键缓冲（按最长文本 256 码点预留） */
  private keyBuf = new Float64Array(1024);

  get size(): number {
    return this.lengths.length;
  }

  /** 追加一条记录文本。只能在 seal() 之前调用。 */
  addRecord(text: string): void {
    if (this.sealed) throw new Error("index already sealed");
    this.lengths.push(cpLength(text));
    this.pending.push(text);
    // 第一遍随装入进行：累计各 gram 的文档频次
    if (!HAS_SURROGATE.test(text)) {
      if (this.keyBuf.length < text.length) {
        this.keyBuf = new Float64Array(text.length * 2);
      }
      const n = collectNumKeys(text, this.keyBuf);
      const keys = this.keyBuf.subarray(0, n);
      keys.sort();
      const df = this.numDf;
      let i = 0;
      while (i < n) {
        const key = keys[i]!;
        df.set(key, (df.get(key) ?? 0) + 1);
        while (i < n && keys[i] === key) i++;
      }
    } else {
      const counts = new Map<string, number>();
      collectStrKeys(text, counts);
      const df = this.strDf;
      for (const key of counts.keys()) {
        df.set(key, (df.get(key) ?? 0) + 1);
      }
    }
  }

  /** 结束装入：按文档频次精确分配倒排数组，第二遍扫描填充。 */
  seal(): void {
    const records = this.pending;
    // 精确分配倒排数组
    const numFill = new Map<number, number>();
    for (const [key, df] of this.numDf) {
      this.numPostings.set(key, {
        ids: new Uint32Array(df),
        counts: new Uint8Array(df),
      });
      numFill.set(key, 0);
    }
    const strFill = new Map<string, number>();
    for (const [key, df] of this.strDf) {
      this.strPostings.set(key, {
        ids: new Uint32Array(df),
        counts: new Uint8Array(df),
      });
      strFill.set(key, 0);
    }
    this.numDf = new Map();
    this.strDf = new Map();

    // 第二遍：重新计算各记录的 gram 计数并填充倒排数组
    for (let id = 0; id < records.length; id++) {
      const text = records[id]!;
      if (!HAS_SURROGATE.test(text)) {
        const n = collectNumKeys(text, this.keyBuf);
        const keys = this.keyBuf.subarray(0, n);
        keys.sort();
        let i = 0;
        while (i < n) {
          const key = keys[i]!;
          let count = 0;
          while (i < n && keys[i] === key) {
            i++;
            count++;
          }
          const p = this.numPostings.get(key)!;
          const at = numFill.get(key)!;
          p.ids[at] = id;
          p.counts[at] = count;
          numFill.set(key, at + 1);
        }
      } else {
        const counts = new Map<string, number>();
        collectStrKeys(text, counts);
        for (const [key, count] of counts) {
          const p = this.strPostings.get(key)!;
          const at = strFill.get(key)!;
          p.ids[at] = id;
          p.counts[at] = count;
          strFill.set(key, at + 1);
        }
      }
    }
    this.pending = [];

    const order = new Uint32Array(this.lengths.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    const lens = this.lengths;
    order.sort((x, y) => lens[x]! - lens[y]!);
    this.orderByLen = order;
    this.scores = new Int32Array(this.lengths.length);
    this.sealed = true;
  }

  /** 估算以该字段驱动查询的代价：查询各 q-gram 的倒排表长度之和。 */
  estimateCost(queryText: string): number {
    let cost = 0;
    if (!HAS_SURROGATE.test(queryText)) {
      const buf = new Float64Array(queryText.length);
      const n = collectNumKeys(queryText, buf);
      const keys = buf.subarray(0, n);
      keys.sort();
      let i = 0;
      while (i < n) {
        const key = keys[i]!;
        const p = this.numPostings.get(key);
        if (p !== undefined) cost += p.ids.length;
        while (i < n && keys[i] === key) i++;
      }
      return cost;
    }
    const counts = new Map<string, number>();
    collectStrKeys(queryText, counts);
    for (const key of counts.keys()) {
      const p = this.strPostings.get(key);
      if (p !== undefined) cost += p.ids.length;
    }
    return cost;
  }

  /**
   * 返回通过“长度过滤 + q-gram 计数过滤”的候选记录下标（按下标升序）。
   * 保证不丢真：任何相似度达到 tPercent/100 的记录都在结果中。
   */
  query(queryText: string, tPercent: number): number[] {
    const nq = cpLength(queryText);
    const scores = this.scores;
    const touched: number[] = [];
    let gramKinds = 0;

    if (!HAS_SURROGATE.test(queryText)) {
      const buf = new Float64Array(nq);
      const n = collectNumKeys(queryText, buf);
      const keys = buf.subarray(0, n);
      keys.sort();
      let i = 0;
      while (i < n) {
        const key = keys[i]!;
        let qc = 0;
        while (i < n && keys[i] === key) {
          i++;
          qc++;
        }
        gramKinds++;
        const p = this.numPostings.get(key);
        if (p === undefined) continue;
        const ids = p.ids;
        const pcs = p.counts;
        for (let j = 0; j < ids.length; j++) {
          const id = ids[j]!;
          if (scores[id] === 0) touched.push(id);
          scores[id] = scores[id]! + (qc < pcs[j]! ? qc : pcs[j]!);
        }
      }
    } else {
      const counts = new Map<string, number>();
      collectStrKeys(queryText, counts);
      gramKinds = counts.size;
      for (const [key, qc] of counts) {
        const p = this.strPostings.get(key);
        if (p === undefined) continue;
        const ids = p.ids;
        const pcs = p.counts;
        for (let j = 0; j < ids.length; j++) {
          const id = ids[j]!;
          if (scores[id] === 0) touched.push(id);
          scores[id] = scores[id]! + (qc < pcs[j]! ? qc : pcs[j]!);
        }
      }
    }

    if (gramKinds === 0) {
      // 查询串没有 q-gram（长度 < q）：计数过滤退化为仅长度过滤。
      // 此时长度过滤能保证 M 足够小、计数下界 <= 0，无需再查计数。
      const result: number[] = [];
      for (let id = 0; id < this.lengths.length; id++) {
        const nr = this.lengths[id]!;
        const m = nq > nr ? nq : nr;
        const lo = nq < nr ? nq : nr;
        if (lo * 100 >= tPercent * m) result.push(id);
      }
      return result;
    }

    const added: number[] = [];
    for (const id of touched) {
      const score = scores[id]!;
      const nr = this.lengths[id]!;
      const m = nq > nr ? nq : nr;
      const lo = nq < nr ? nq : nr;
      if (lo * 100 >= tPercent * m) {
        const k = Math.floor(((100 - tPercent) * m) / 100);
        const need = m - Q + 1 - k * Q;
        if (need <= 0 || score >= need) {
          added.push(id);
          scores[id] = -1; // 标记已收录，避免下述回退扫描重复加入
          continue;
        }
      }
      scores[id] = 0;
    }

    // 计数下界 need <= 0 时过滤失效：与查询无公共 q-gram 的短记录也可能是候选。
    // need <= 0 仅可能在 M <= (Q-1) / (1 - Q*(100-t)/100) 时成立，只扫描该长度范围。
    const denom = 1 - (Q * (100 - tPercent)) / 100;
    if (denom > 0) {
      const maxVacuousM = Math.floor((Q - 1) / denom + 1e-9);
      if (nq <= maxVacuousM) {
        const order = this.orderByLen;
        const lens = this.lengths;
        for (let oi = 0; oi < order.length; oi++) {
          const id = order[oi]!;
          const nr = lens[id]!;
          if (nr > maxVacuousM) break; // 长度升序，之后 M 只会更大
          const m = nq > nr ? nq : nr;
          const lo = nq < nr ? nq : nr;
          if (lo * 100 < tPercent * m) continue;
          if (scores[id] === -1) continue; // 已收录
          const k = Math.floor(((100 - tPercent) * m) / 100);
          if (m - Q + 1 - k * Q <= 0) added.push(id); // 仅计数下界失效时才收录
        }
      }
    }
    for (const id of touched) scores[id] = 0;

    added.sort((x, y) => x - y);
    return added;
  }
}
