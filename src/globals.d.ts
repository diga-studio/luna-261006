// Node.js 全局 URL（WHATWG）的最小声明，避免依赖 @types/node 或 DOM lib。
declare class URL {
  constructor(url: string | URL);
  hostname: string;
}
