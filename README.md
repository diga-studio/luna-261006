# annotation-migration

视频剪辑版本间的批注迁移预览库（TypeScript）。由上层审片工具调用：
剪辑清单与批注由调用方提供，全部数据仅保存在进程内存中，不处理视频解码。

## 背景

创意团队提交新版视频时会删减、重排、重复使用镜头，也会倒放或调整播放速度。
本库把旧版批注按**原素材标识 + 素材覆盖范围**映射到新版成片帧区间，
让审片人员看到旧批注在新版对应内容上的全部落点。

## 使用

```ts
import { MigrationRegistry } from 'annotation-migration';

const registry = new MigrationRegistry();

// 登记剪辑版本：片段依次拼接，成片从第 0 帧开始，中间无空隙。
registry.registerVersion('v1', [
  { sourceId: 'A', sourceStart: 0, sourceEnd: 100, duration: 50, direction: 'forward' },
  { sourceId: 'B', sourceStart: 20, sourceEnd: 40, duration: 20, direction: 'reverse' },
]);
registry.registerVersion('v2', [/* 新版剪辑清单 */]);

// 登记旧版批注（左闭右开帧区间；startFrame === endFrame 为单点批注，覆盖一个完整帧）。
registry.registerAnnotations('v1', [{ id: 'note-1', startFrame: 10, endFrame: 20 }]);

// 生成迁移预览：不修改旧批注，每条旧批注都有独立结果（含空结果）。
const preview = registry.migrate('v1', 'v2');
// preview.results[i] = { annotationId, ranges: [{ startFrame, endFrame }, ...] }
// ranges 按新版位置排序，重叠或相邻区间已合并；空数组表示新版中无落点。
```

## 规则要点

- 统一按 24fps 的整数帧编号定位；输入边界与长度须为 JavaScript 安全整数。
- 片段匀速播放指定素材范围，速度可以是非整数倍；正放从起边界走向止边界，倒放相反。
- 每个成片帧覆盖其两端边界之间的连续素材范围；匹配要求同一素材上**正长度**交集，
  仅端点相碰不算命中；不同素材即使画面相似也不匹配。
- 同一素材被新版重复引用时返回所有命中位置；内容全部删除时返回空结果。
- 边界计算使用 BigInt 精确有理数运算，不会多迁移或漏迁移一帧。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试（功能 + 随机差分 + 规模性能）
npm run build   # 产出 dist/（含类型声明）
```

测试包含：

- 跨段批注在重复引用、倒放、非整数变速下的迁移，验证所有副本命中且边界帧精确；
- 仅端点相触、内容全部删除返回空结果；
- 400 组随机场景与独立逐帧暴力参考实现完全一致；
- 规模验证：新版 10 万段（大量同源不相交短段 + 少量覆盖长段）、5 万条批注
  （每条跨旧版 4 段、命中新版不超过 8 段、结果总计不超过 50 万区间），
  全量迁移 < 20s、额外内存 <= 256 MiB（本机实测约 250ms / 常驻约 20MiB）。
