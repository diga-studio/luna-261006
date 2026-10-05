# LocalDock

进程内服务热切换生命周期管理库（TypeScript）。服务配置与业务工作单元由调用方提供，
LocalDock 在平台进程运行期间维护各服务的生命周期状态。

## 能力

- **部署版本** `deploy(service, config, factory)`：每次部署创建独立工作单元，
  返回 `{ version, settled }`。`settled` 在该版本接手流量时兑现，在准备失败、
  被更新部署覆盖或被停止失效时拒绝。
- **提交请求** `submitRequest(service, request)`：请求被接纳时归属当前接流量版本，
  直到完成不换版本、不自动重试；没有接流量版本时直接以 `NO_SERVING_VERSION` 失败。
- **停止服务** `stop(service)`：立即关闭请求入口并使未完成部署失效；等待受影响
  请求结束、相关工作单元终止后完成。停止后的新部署可再次提供服务。
- **查看状态** `getStatus(service)`：报告 `serving / preparing / unavailable /
  stopped`，绝不把未就绪或已终止的版本报告为在服务。

## 工作单元协议

调用方通过工厂提供工作单元，并通过 `lifecycle` 通道上报生命周期（通知可乱序、
迟到或重复，库均能容忍）：

```ts
import { LocalDock } from 'localdock';

const dock = new LocalDock();

const { settled } = dock.deploy('svc', config, (config, lifecycle) => {
  const unit = createMyUnit(config); // 你的业务工作单元
  unit.onReady(() => lifecycle.notifyReady());
  unit.onExit((err) => lifecycle.notifyExited(err));
  return unit; // { handleRequest(req): Promise<unknown>, terminate(): Promise<void> }
});
```

语义要点：

- 新版本准备期间，原接流量版本继续服务；只有仍有效的最新部署就绪后才接手。
  被后续部署覆盖的版本即使迟到就绪也不会再上线。
- 切换前已接纳的请求由旧版本处理完；旧版本最后一个请求结束后才被终止。
  部署成功不等旧请求结束。
- 工作单元意外退出只使其未完成请求失败；若它是接流量版本，服务转为不可用，
  不回退到旧版本。
- 所有不再使用的工作单元最终都会被终止；每个工作单元至多收到一次 `terminate()`，
  且允许在就绪前调用。

## 开发

要求 Node.js >= 22.18（测试直接用 Node 内置类型剥离运行 TypeScript）。

```sh
npm install
npm test        # node --test，直接运行 test/*.test.ts
npm run build   # 输出 dist/（.js + .d.ts）
npm run typecheck
```
