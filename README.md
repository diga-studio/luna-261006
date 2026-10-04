# cintcheck

C 整数常量表达式合规检查库（纯内存、无外部依赖）。上层扫描器提取完整常量表达式文本后，调用 `check_expression` 判断在目标平台上是否存在整数运算违规。

## 平台约定（固定）

C11 整数语义；char 8 位（默认有符号）、short 16 位、int/long 32 位、long long 64 位，二补码。

## 用法

```python
from cintcheck import check_expression

r = check_expression("(unsigned short)65535*(unsigned short)65535")
# r.ok == False, r.violations == [Violation(kind='signed-overflow', ...)]

r = check_expression("0xffffffff+1")
# r.ok == True, r.value == 0, r.type.name == 'unsigned int'
```

`CheckResult`：`ok` 为 `False` 时 `value`/`type` 为 `None`，`violations` 含实际求值路径上检测到的违规（`signed-overflow` / `division-by-zero` / `invalid-shift`）。短路逻辑与条件运算只检查实际求值的操作数，但条件运算结果类型仍由两支类型共同确定。

## 结构

- `cintcheck/ctypes.py` — 整数类型模型：范围、整数提升、通常算术转换、低位截断转换
- `cintcheck/lexer.py` — 字面量（十/八/十六进制 + C11 后缀）与运算符分词
- `cintcheck/parser.py` — 递归下降解析，C11 优先级与结合性
- `cintcheck/evaluator.py` — 求值、字面量类型推断、违规检测、未求值分支的静态类型推断
- `cintcheck/api.py` — 对外入口 `check_expression`

## 测试

```sh
python3 -m pytest tests/ -q
```
