# telemetry-buffer

工业设备遥测的可恢复入库缓冲库（TypeScript / Node.js，零第三方依赖）。

- SQLite（`node:sqlite`）保存接纳与重放状态：待归档记录、未过期去重记录、有界恢复状态（已提交归档偏移、下一个 receipt）。
- 最终遥测写入本地追加式归档文件 `archive.bin`，归档记录不依赖 SQLite 保存。
- 进程可在任意位置被强制终止；重启后从 SQLite 中已提交的归档偏移继续校验，只截断末尾不完整记录，完整但未提交的记录直接重放（不重新执行接纳检查）。

## 要求

- Node.js >= 23.6（依赖内置 `node:sqlite` 与原生 TypeScript 类型擦除，无构建步骤、无外部依赖）。

## 使用

```bash
npm install
npm test
```

```ts
import { TelemetryBuffer } from "./src/index.ts";

const tb = new TelemetryBuffer({ dir: "./data" });

// 接纳：按 (deviceId, sampleAt) 去重，30 秒窗口内返回原 receipt；
// sampleAt <= now - 60000 拒绝；否则持久接纳并分配严格递增 receipt。
const res = tb.ingest({ deviceId: "dev-1", sampleAt: 1_700_000_000_000, payload: buf }, now);

// 归档：把 sampleAt <= now - 60000 的已接纳记录追加到归档文件，
// 按 (sampleAt, receipt) 升序，分批写入（每批 <= 256 条，驻留 payload 受限）。
tb.advance(now);

// 分页读取：游标跨重启有效，payload 逐字节还原，从头遍历无重复 receipt。
const page = tb.read(null, 100);        // { records, nextCursor }
const more = tb.read(page.nextCursor, 100);

tb.close();
```

## 归档文件格式

每条记录：`magic(4) + bodyLen(4) + crc32(4) + body`，
`body = receipt(8) + sampleAt(8, f64) + deviceIdLen(2) + deviceId + payloadLen(4) + payload`，全部小端。

## 崩溃恢复

`advance` 的顺序为：写文件 → fsync → SQLite 事务提交（删除已归档 pending、推进 committed offset）。

- 写在记录中途崩溃：重启时从 committed offset 起扫描，截断不完整尾部，pending 记录由后续 `advance` 重写。
- 写完整批但状态未提交：重启时重放完整记录（仅从 pending 中移除并推进偏移，不重查接纳、不改 receipt），再补齐剩余记录。
- 恢复不扫描全部历史归档，不重写历史前缀；已提交给读者的前缀不可撤回。

## 测试

`npm test` 覆盖：30 秒去重窗口边界与 60 秒归档边界、同时间 receipt 排序、4 KiB payload 逐字节还原、
子进程 SIGKILL 崩溃（部分写入 / 写完未提交）后的反复重启恢复与游标有效性、超过内存批量限制的乱序积压重启后归档。
