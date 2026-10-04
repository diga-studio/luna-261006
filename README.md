# ring-arbitration

企业电话网关的**同时振铃仲裁库**（TypeScript，纯内存状态，无接口层）。负责多通来电争抢重叠振铃组名额时的预约、振铃、撤销、挂断仲裁，保证：

- 同一来电最多一个赢家；
- 名额（预约 / 振铃 / 通话 / 等待撤销或挂断确认）不超占、不泄漏；
- 已终止支路不复活，重复 / 交错 / 迟到回报安全忽略；
- 同一支路的振铃、撤销、挂断动作各至多交付一次。

## 构建与测试

```sh
npm install
npm test        # 编译 + 运行全部测试（node:test）
npm run build   # 仅编译到 dist/
```

## 使用

```ts
import { RingGateway } from 'ring-arbitration';

const gw = new RingGateway({
  onAction: (action) => {
    // action: { type: 'ring' | 'cancel' | 'hangup', callId, extensionId }
    // 在此对接 SIP 等传输层；回调内可重入调用 report* 方法，规则一致。
  },
  ringTimeoutMs: 10_000, // 未接听超时，默认 10 秒
});

// 1. 预注册分机（并发上限 1~8，默认 2，跨组共享）与振铃组
gw.registerExtension('ext-1001');      // 容量 2
gw.registerExtension('ext-1002', 4);
gw.registerGroup('sales', ['ext-1001', 'ext-1002']);
gw.registerGroup('support', ['ext-1001']); // 分机可属于多个组

// 2. 业务时间由调用方显式向前推进（事件按处理时的当前业务时间判定）
gw.advanceTime(Date.now());

// 3. 来电：为组内所有有余量的成员各预约一个名额并交付振铃；
//    全满则立即 busy。不排队、不补发。
const result = gw.incomingCall('call-1', 'sales');

// 4. 支路回报（可重复、可交错、可迟到，均安全处理）
gw.reportAnswer('call-1', 'ext-1001');  // 首个有效接听成为唯一赢家
gw.reportReject('call-1', 'ext-1002');  // 明确拒接 -> 释放名额
gw.reportLineEnd('call-1', 'ext-1001'); // 线路结束；赢家挂线即结束整通来电

// 5. 来电方主动结束 / 超时（advanceTime 推进到截止时刻即触发，含等于）
gw.callerHangup('call-1');

// 6. 查询
gw.getCallResult('call-1');
//  { status: 'ringing' }
//  { status: 'established', winner } | { status: 'answered-ended', winner }
//  { status: 'unanswered' } | { status: 'busy' }
gw.getWinner('call-1');          // 赢家分机或 undefined
gw.getExtensionUsage('ext-1001'); // { extensionId, capacity, occupied, available }
```

## 关键语义

- **名额生命周期**：预约即占名额；已交付振铃的支路只有在明确的拒接或线路结束回报到达时才释放；发出撤销 / 挂断本身不提前释放。
- **赢家仲裁**：首个被处理的有效接听成为唯一赢家。其余已交付支路未接听则撤销、已接听则挂断；未交付的预约作废退还，不再振铃。赢家线路结束即结束整通来电，不改选赢家。
- **超时与结束**：未接听来电在发起 `ringTimeoutMs` 后超时（当前业务时间等于截止时刻也算超时）；超时或来电方结束后不得再建立通话，撤销途中 / 挂断途中的迟到接听只会再收到挂断，不会复活来电。
- **重入安全**：`onAction` 回调返回前重入调用 `report*` / `callerHangup` / `advanceTime`，与稍后异步报告遵守相同规则。
