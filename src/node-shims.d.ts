// Minimal ambient declarations so the project compiles without @types/node.
declare var console: { log(...args: unknown[]): void; error(...args: unknown[]): void };
declare var process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  hrtime: { bigint(): bigint };
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
};
declare var __dirname: string;
