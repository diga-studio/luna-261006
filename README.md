# license-seat-reallocation

软件许可席位重排库，供资产治理平台直接调用。每次接收同款软件的完整盘点快照，数据与结果仅保存在内存，无任何外部依赖与副作用。

## 能力

- 只处理同一款软件的按设备许可：一台在用设备需要 1 席。
- 每个许可池有唯一标识、席位总数、到期日和允许覆盖的部门集合；到期日当天仍有效，早于核算日的池不参与分配。
- 每台设备最多绑定一个许可池，且当前部门必须在该池允许范围内；每池绑定设备数不超过席位总数。
- 优化目标（按优先级）：
  1. 获得有效授权的设备总数最大；
  2. 在覆盖数最大的所有方案中，保持原许可池绑定的设备数最多（原先无绑定的不计入）。
- 许可不足时返回最优的部分覆盖方案，而不是整批失败。

内部将问题建模为最小费用最大流：覆盖数对应最大流，保留旧绑定对应最小费用，两项指标按字典序最优。

## 安装与测试

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

仅需 Node.js，无运行时依赖。

## API

```ts
import { reallocateSeats } from 'license-seat-reallocation';

const result = reallocateSeats(
  [
    { deviceId: 'dev-1', department: '甲', previousPoolId: 'pool-A' },
    { deviceId: 'dev-2', department: '乙' },
  ],
  [
    { poolId: 'pool-A', totalSeats: 1, expiresOn: '2026-12-31', allowedDepartments: ['甲', '乙'] },
    { poolId: 'pool-B', totalSeats: 1, expiresOn: '2026-12-31', allowedDepartments: ['甲'] },
  ],
  '2026-10-05', // 调用方提供的业务日期
);
// result.assignments        最终设备绑定 [{ deviceId, poolId }]
// result.uncoveredDeviceIds 未覆盖设备
// result.coveredCount       获得授权的设备总数
// result.preservedCount     保持原绑定的设备数
```

日期一律使用 `YYYY-MM-DD` 格式，按字典序比较。
