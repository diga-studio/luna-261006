/** 内存采样 worker：与主线程同进程，周期性读取进程级内存并记录峰值。 */
import { parentPort } from "node:worker_threads";

interface MemPeak {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
}

const peak: MemPeak = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 };
const timer = setInterval(() => {
  const mu = process.memoryUsage();
  if (mu.rss > peak.rss) peak.rss = mu.rss;
  if (mu.heapTotal > peak.heapTotal) peak.heapTotal = mu.heapTotal;
  if (mu.heapUsed > peak.heapUsed) peak.heapUsed = mu.heapUsed;
  if (mu.external > peak.external) peak.external = mu.external;
}, 10);

parentPort!.on("message", () => {
  clearInterval(timer);
  parentPort!.postMessage(peak);
  process.exit(0);
});
