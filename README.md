# ring-arbitration

企业电话网关的同时振铃仲裁库（纯内存、无接口层），由上层直接调用。

## 使用

```ts
import { RingGateway } from "ring-arbitration";

const gw = new RingGateway((action) => {
  // action: { type: "ring" | "cancel" | "hangup", callId, branchId, extensionId }
  // 在此交付给 SIP 栈；回调内允许重入 report()
});

gw.addExtension("1001", 2);          // 并发上限 1-8，默认 2，跨组共享
gw.addRingGroup("sales", ["1001"]);

gw.incomingCall("call-1", "sales");  // 返回 CallResult；全满则 status="busy"
gw.report(branchId, "answer");       // "answer" | "reject" | "lineEnd"
gw.callerHangup("call-1");
gw.advanceTime(Date.now());          // 业务时间由调用方显式推进，10s 未接听超时

gw.getCallResult("call-1");          // { status, winner, finalized }
gw.getExtensionUsage("1001");        // { capacity, used }
```

规则要点：先被处理的有效接听为唯一赢家；撤销/挂断发出后名额仍占用，直到拒接或线路结束回报；撤销后的迟到接听会收到挂断；已终止支路的事件一律忽略。

## 构建与测试

```sh
npm install
npm test
```
