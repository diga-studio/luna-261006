# ar_anchor — 施工现场 AR 标注定位库

在叠加于现场的建筑模型（GLB 2.0 静态三角网格）上放置问题标注：
射线拾取生成可保存的锚点，模型重新校准后通过回放把锚点贴回原构件表面。

## 能力

- `Scene.load(path, scene=None)`：加载 GLB 2.0 文件到内存，可选指定 scene 索引
  （默认取文件声明的默认 scene）。仅解析该 scene 可达的节点。
- `scene.pick(ray_origin, ray_direction, model_to_project)`：在项目空间发射射线，
  返回前向最近命中 `PickResult(point, distance, anchor)`，无命中返回 `None`。
- `scene.replay(anchor, model_to_project)`：用新的模型到项目变换返回锚点当前的
  项目坐标，与新的遮挡关系无关。

## 输入约定

- GLB 2.0，数据全部来自内嵌 BIN 块；静态三角网格（TRIANGLES / TRIANGLE_STRIP /
  TRIANGLE_FAN，有索引或无索引），不支持动画、蒙皮、形变、压缩扩展与外部资源。
- 位置为 float32 VEC3，索引为无符号 8/16/32 位整数；位置与索引均支持 sparse
  覆盖、accessor/bufferView 偏移与合法 byteStride；无基础 bufferView 的稀疏
  accessor 未覆盖元素按零处理。
- 节点支持 matrix（列主序）或 TRS（xyzw 四元数，先缩放再旋转最后平移），
  父子变换共同生效，负缩放与非均匀缩放均有效。
- 项目空间为右手 Y 向上，单位米。`model_to_project` 为可逆仿射变换，
  接受行主序 4x4 嵌套序列或扁平 16 元素序列。射线方向不要求单位长度。
- 命中距离以米计（起点在表面上距离为零）；正反面、边、顶点均可命中；
  射线与三角形共面不计命中；退化三角形占编号但不参与命中。
- 与最短距离之差不超过 1e-8 米的多个命中，按 (node, primitive, triangle)
  字典序最小者胜出。

## 用法

```python
from ar_anchor import Scene, Anchor

scene = Scene.load("building.glb")          # 解析结果驻留内存

# 工程师点击放置标注
hit = scene.pick(ray_origin, ray_direction, model_to_project)
if hit is not None:
    saved = hit.anchor.to_dict()            # 调用方负责保存（JSON 可序列化）

# 重新校准后回放：同一模型文件 + 新的模型到项目变换
anchor = Anchor.from_dict(saved)
point = scene.replay(anchor, model_to_project_new)
```

`Anchor` 记录 node 索引（区分同一 mesh 的不同实例）、primitive 索引、
三角形序号（从零编号，含退化三角形）以及相对该三角形顶点顺序的重心坐标。
不要求跨模型版本迁移锚点。

## 测试

```bash
python3 -m pytest tests/ -q
```

覆盖：交错布局叠加稀疏覆盖、无基础 bufferView 的稀疏 accessor、
TRIANGLE_STRIP / TRIANGLE_FAN 与退化三角形编号、共享 mesh 在嵌套旋转 /
负缩放 / 非均匀缩放下的多实例拾取（非单位方向射线）、等距命中的字典序
裁决、校准后遮挡场景下的锚点回放，以及 8/16/32 位索引类型。
