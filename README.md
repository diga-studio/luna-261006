# LocalDock

进程内服务热切换管理库。服务配置与业务工作单元由调用方提供，库负责在平台进程运行期间维护各服务的生命周期状态：部署新版本、提交请求、停止服务、查询状态。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 先编译 TypeScript 再运行 `node:test` 测试。

## 概念

- **工作单元（WorkUnit）**：调用方提供的进程内异步任务，实现 `handleRequest` 与 `terminate`。每次部署都会通过工厂创建独立工作单元，即使配置相同。
- **生命周期通知**：工厂收到一个 `WorkUnitContext`，工作单元通过它上报 `notifyReady` / `notifyFailed` / `notifyExited`。通知可以乱序、迟到或重复，库保证幂等处理。
- **部署（deploy）**：返回 `{ id, result }`。`result` 在部署尘埃落定时给出 `active` / `failed` / `superseded` / `stopped`。

## 用法

```ts
import { LocalDock } from "localdock";

const dock = new LocalDock();

const deployment = dock.deploy("my-service", { version: 1 }, (ctx) => {
  const unit = createMyUnit(); // 你的业务工作单元
  unit.onReady(() => ctx.notifyReady());
  unit.onCrash((err) => ctx.notifyExited(err));
  return {
    handleRequest: (req) => unit.handle(req),
    terminate: () => unit.shutdown(),
  };
});

const response = await dock.submit("my-service", request);
const status = dock.status("my-service");
await dock.stop("my-service");
```

## 语义

- 新版本准备期间，原接流量版本继续服务；只有仍有效的最新部署就绪后才接手。被后续部署覆盖的版本不会在后者失败后复活。
- 请求在接纳时归属一个已就绪版本，直到完成不换版本、不自动重试；没有接流量版本时请求立即失败。
- 旧版本最后一个请求结束后才被终止；部署成功不等旧请求结束。每个工作单元至多收到一次 `terminate`。
- `stop` 立即关闭请求入口并使未完成的部署失效，等待受影响请求结束、相关工作单元终止后才完成；之后的部署不受前一次停止的迟到清理影响。
- 工作单元意外退出只使其未完成请求失败；若它是当前接流量版本，服务转为不可用，不回退到旧版本。
