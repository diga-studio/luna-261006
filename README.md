# annotation-migration

视频剪辑版本间的批注迁移预览库（TypeScript）。由上层审片工具调用：剪辑清单和批注由调用方提供，仅保存在进程内存中，不处理视频解码。

## 背景

创意团队提交新版视频时会删减、重排、重复使用镜头，也会倒放或调整播放速度。直接沿用旧时间码会把批注放到错误画面。本库生成迁移预览，让审片人员看到旧批注在新版对应内容上的全部落点。

## 安装与测试

```bash
npm install
npm test        # vitest，含正确性与性能测试
npm run build   # 编译到 dist/
```

## 使用

```ts
import { MigrationPreviewer } from 'annotation-migration';

const previewer = new MigrationPreviewer();

// 登记剪辑版本：片段依次拼接，成片从第 0 帧开始，中间没有空隙。
previewer.registerVersion('v1', [
  {
    mediaId: 'shot-A',          // 稳定的原素材标识
    sourceStartFrame: 0,        // 原素材起边界（含）
    sourceEndFrame: 240,        // 原素材止边界（不含）
    timelineLength: 120,        // 正整数成片长度（可≠素材帧数，即非整数倍速）
    direction: 'forward',       // 'forward' | 'reverse'
  },
  // ...更多片段
]);
previewer.registerVersion('v2', [/* 新版剪辑清单 */]);

// 登记旧版批注：左闭右开帧区间，可跨段；单点批注（start === end）按覆盖一个完整成片帧处理。
previewer.registerAnnotations('v1', [
  { id: 'note-1', startFrame: 24, endFrame: 96 },
]);

// 生成 v1 -> v2 的迁移预览。不修改旧批注；每条旧批注都有独立结果（含空结果）。
const results = previewer.createPreview('v1', 'v2');
// => [{ annotationId: 'note-1', intervals: [{ startFrame, endFrame }, ...] }]
```

## 规则要点

- 统一按 24fps 整数帧编号；每个成片帧覆盖其两端边界之间的连续素材范围。
- 匹配只看原素材标识与素材覆盖范围：有正长度交集才命中，仅端点相碰不算；不同素材即使画面相似也不匹配。
- 同一素材被新版重复引用时返回全部命中位置；内容全部删除时返回空结果。
- 结果以新版左闭右开整数帧区间表示，按位置排序，重叠或相邻区间合并；不同批注之间不合并。
- 边界用 BigInt 有理数精确计算，不多迁移、不漏迁移任何一帧。

## 性能

每版 10 万剪辑段、5 万条批注的规模下，全量迁移预览在本仓库性能测试中约 0.5 秒完成（预算 20 秒），额外堆内存约 30 MiB（预算 256 MiB）。索引结构：旧版按时间线二分查找；新版按素材分组、素材起边界排序，并以最大素材止边界线段树做区间刺探。
