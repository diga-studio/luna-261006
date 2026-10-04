# dlp — 离线流式 DLP 检测与脱敏库

纯 Python 3 标准库实现，无第三方依赖。在任意分块的 UTF-8 字节流中检测并脱敏：

- **SSN**：`ddd-dd-dddd`（首组不能为 000/666/900-999，后两组不能全零）
- **银行卡号**：13–19 位数字，相邻数字间允许零或一个空格/连字符，需通过 Luhn 校验
- **美国电话**：`ddd-ddd-dddd` 或 `(ddd) ddd-dddd`（空格恰好一个）

候选左右相邻字节不能是 ASCII 字母或数字；流首尾视为满足边界。
每个命中保留最后四位数字，其余数字替换为 `X`，分隔符不变；
多类命中区间可重叠，遮盖要求取并集。

## 用法

```python
from dlp import Scanner

sc = Scanner()
out = sc.feed(b"card: 4111 1111 1111 1111\n")   # 返回已确定的脱敏字节
out += sc.feed(b"ssn: 078-05-1120")             # 分块可为空、可切在任意字节处
tail, counts = sc.finish()                      # 输入结束：剩余字节 + 三类命中总数
out += tail
print(out)     # b'card: XXXX XXXX XXXX 1111\nssn: XXX-XX-1120'
print(counts)  # {'ssn': 1, 'card': 1, 'phone': 0}
```

性质：

- 相同原文无论如何分块，脱敏结果与命中总数完全一致；
- 已返回的字节不可撤回，且不会成为漏脱敏内容；
- 工作内存与累计输入长度无关（每次 feed 返回后积压不超过 256 字节，
  实际约 40 字节以内），`finish` 排空全部余量。

## 测试

```sh
python3 -m unittest test_dlp -v
```

测试包含：全部两段切分 / 逐字节 / 插入空块与独立非流式参考实现核对、
Luhn 回退与跨类重叠遮盖合并、以及 ≥32 MiB 长流的 256 字节输出滞后上限检查。
