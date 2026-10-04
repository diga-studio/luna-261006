# iges-precheck

IGES 结构预检库：在转换前判断 IGES 文件结构是否完整，避免目录（D）与
参数（P）记录错配导致转换中途失败。只检查固定列结构与参数词法，不解析
几何含义。纯 Python 标准库实现，无第三方依赖。

## 用法

```python
from iges_precheck import precheck_file, precheck_bytes

result = precheck_file("part.igs")   # 或 precheck_bytes(data)
if result.ok:
    ...  # 通过预检，可进入转换
else:
    for err in result.errors:
        print(err.code, err.message, err.line)
```

## 检查内容

- 物理行：ASCII、每行 80 字节、全文件统一 LF 或 CRLF、末行可无换行。
- 段结构：S/G/D/P/T 五段非空且依次出现，第 73 列段名、第 74-80 列段内
  序号从 1 连续递增，T 仅一行。
- G 段：前两项以 `1H` 声明分隔符，仅支持 `1H,,1H;,`（逗号/分号）与
  `1H||1H!|`（竖线/感叹号）；整体词法合法，字符串外恰好一个结束符。
- 参数词法：支持空参数与前后空格；`nH` 开头的 Hollerith 字符串按声明
  长度取内容（可含分隔符、可跨行），内容之后只允许空格与一个分隔符。
- D 段：每两行一个实体；首行第 1-8 列类型、第 9-16 列 P 指针；次行类型
  一致、第 25-32 列为正整数参数行数。
- P 覆盖：每个实体拥有从声明位置开始的连续 P 区间，区间内每行归属字段
  指回该实体首条 D 记录；全部 P 记录被恰好覆盖，不越界、不重叠、不遗漏；
  每个实体首个参数必须与 D 记录类型一致。
- T 段：第 1-32 列四个 8 列字段（字母 + 7 列行数）与实际各段行数一致。

## 目录

- `iges_precheck/sections.py` — 行切分与段划分
- `iges_precheck/fields.py` — 前补空格整数字段解析
- `iges_precheck/params.py` — G 头部分隔符与参数词法（Hollerith）
- `iges_precheck/entities.py` — D 记录解析与 P 区间覆盖校验
- `iges_precheck/checker.py` — 预检编排与入口
- `tests/` — 自动化测试（`python3 -m pytest tests/`）
