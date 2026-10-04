# task26100605

## IGES 结构预检库

`iges_precheck` 在转换前对 IGES 文件做结构完整性预检，不解析几何含义。
输入为本地文件，由上层直接调用，无接口层。

### 用法

```python
from iges_precheck import IgesPrecheckError, is_valid_file, validate_file

validate_file("part.igs")   # 通过则返回 None，失败抛出 IgesPrecheckError
ok = is_valid_file("part.igs")  # 布尔判定
```

### 检查内容

- 行格式：ASCII、每行 80 字节、LF/CRLF 全文件统一、末行可无换行。
- 段结构：S/G/D/P/T 五段非空且依次出现，段内序号从 1 连续，T 仅一行。
- 分隔符：G 段开头仅支持 `1H,,1H;,` 或 `1H||1H!|` 两种声明。
- 参数词法：Hollerith 字符串（`nH` + 恰好 n 字节内容，可跨行，
  内容可含分隔符与行尾空格）、空参数、字符串外恰好一个结束符。
- 目录段：每两行一个实体，类型一致，P 指针与参数行数为前补空格十进制。
- P 区间：每个实体独占连续区间，归属字段指回实体首条 D 记录，
  全部 P 记录被恰好覆盖一次，首个参数等于实体类型。
- T 段：前 32 列四组段行数统计与实际一致。

### 测试

```bash
python3 -m pytest
```
