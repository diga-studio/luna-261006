# task26100665

观看覆盖核算库（TypeScript，进程内存）。按「租户 + 用户档案 + 影片」隔离核算影片时间轴上的有效覆盖，供上层播放统计模块直接调用。

## 能力

- `upsertSegment(key, totalDurationMs, segment)`：登记或修订片段，同一标识仅最高版本生效，修订为整体替换。
- `revokeSegment(key, segmentId, version)`：撤销片段，只移除该标识的贡献；撤销可先于登记到达，更高版本登记可恢复。
- `getProgress(key)`：返回有效片段区间并集的总毫秒数与完成状态（覆盖达到总时长 90% 即完成，精确比较不四舍五入）。

## 构建与测试

```sh
npm install
npm test
```
