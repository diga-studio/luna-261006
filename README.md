# telemetry-buffer

工业设备遥测的可恢复入库缓冲库。SQLite 保存接纳与重放状态，最终遥测进入一个
本地追加式归档文件。设备身份与设备时间已在库外校验，本库不做协议解析。

要求 Node.js >= 24（使用内置 `node:sqlite`，无原生依赖）。

```
npm install
npm test
```

## 用法

```js
const { TelemetryBuffer } = require("telemetry-buffer");

const buf = new TelemetryBuffer({ dir: "/var/lib/telemetry" });

// 接纳：按 (deviceId, sampleAt) 去重，30 秒窗口内重发返回原 receipt；
// sampleAt <= now - 60000 的迟到事件抛 LateEventError。
const { receipt, duplicate } = buf.ingest(
  { deviceId: "dev-1", sampleAt: 1_700_000_000_000, payload: Buffer.from("...") },
  Date.now(),
);

// 归档：把 sampleAt <= now - 60000 的已接纳记录追加进归档文件，
// 按 (sampleAt, receipt) 升序；进程在任意位置被杀死后，
// 重新打开并用同一个 now 再调 advance 即可补齐。
buf.advance(Date.now());

// 读取：游标跨重启有效，payload 逐字节还原。
let cursor;
for (;;) {
  const page = buf.read(cursor, 100);
  for (const rec of page.records) { /* rec: { receipt, deviceId, sampleAt, payload } */ }
  if (page.records.length === 0) break;
  cursor = page.nextCursor;
}

buf.close();
```

## 设计

- `state.sqlite`（WAL, synchronous=FULL）只保存：待归档记录 `pending`、
  未过期去重记录 `dedup`、以及单行恢复状态 `meta.committed_size`。
  receipt 由 `INTEGER PRIMARY KEY AUTOINCREMENT` 分配，跨重启严格递增。
- `archive.log` 为追加式归档。记录格式：
  `magic(4) | bodyLen(4) | body | crc32(4)`，body 含
  `receipt(8) | sampleAt(8) | deviceIdLen(2) | deviceId | payloadLen(4) | payload`。
- `advance` 每批取 128 条到期记录（内存驻留 payload 远低于 256 条上限），
  先写文件并 fsync，再在一个 SQLite 事务里删除 pending 并推进
  `committed_size`。崩溃只可能留下“文件已写但状态未跟进”的尾巴。
- 启动恢复只做 `fstat` + 截断到 `committed_size`（只截末尾，不重写历史，
  不扫描归档）；被截掉的记录仍在 pending 中，重放时按原 receipt 原样重写。
- 读者只能看到 `committed_size` 之前的前缀，已返回的前缀不会被撤回或修改。
