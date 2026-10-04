# task26100616

施工现场 AR 标注定位库（`ar_anchor`）：从本地 GLB 2.0 文件加载建筑模型，
支持射线拾取生成标注锚点，以及校准后用新位姿回放锚点。

## 能力

- **加载场景**：`ArAnnotationModel(glb_path, scene_index=None)`，仅处理指定
  scene 可达节点；同一 mesh 被不同 node 引用时视为不同实例。数据全部驻留内存。
- **射线拾取**：`pick(model_to_project, origin, direction)` 返回前向最近命中
  （项目坐标、米制距离、可保存的 `Anchor`），无命中返回 `None`。
- **锚点回放**：`replay(model_to_project, anchor)` 用新的模型到项目变换返回
  锚点当前项目坐标；校准改变平移/旋转/缩放后锚点仍贴在原实例原三角形的
  同一相对位置，不受遮挡关系影响。

## 输入约束

- GLB 2.0 静态三角网格，数据全部来自内嵌 BIN 块（无外部 uri、无动画/蒙皮/
  形变/压缩扩展）。
- 位置：float32 VEC3；索引：u8/u16/u32 SCALAR。均支持 sparse 覆盖、accessor
  与 bufferView 偏移、合法 byteStride；无基础 bufferView 的稀疏 accessor
  未覆盖元素按零处理。
- primitive mode：TRIANGLES(4) / TRIANGLE_STRIP(5) / TRIANGLE_FAN(6)，
  有索引或无索引；退化三角形占编号但不参与命中。
- 节点支持 matrix（列主序）或 TRS（xyzw 四元数，先缩放再旋转后平移），
  父子变换级联，负缩放与非均匀缩放有效。

## 调用约定

- 项目空间：右手 Y 向上，单位米。
- `model_to_project`：4x4 行主序可逆仿射矩阵（嵌套列表或 numpy 数组），
  把 glTF 根空间坐标变换到项目空间。
- `origin` / `direction`：项目空间射线起点与方向，方向不要求单位长度。
- 命中距离以米计（已乘方向模长），起点处命中距离为零；正反面、边、顶点
  均可命中；射线与三角形共面不计命中。
- 多个命中与最短距离之差 ≤ 1e-8 米时，按 (node, primitive, triangle)
  字典序取最小者。
- `Anchor` 记录 node 索引、primitive 索引、三角形序号和相对于该三角形
  顶点顺序的重心坐标，可用 `to_dict()` / `Anchor.from_dict()` 序列化，
  由调用方自行保存。不要求跨模型版本迁移锚点。

## 示例

```python
from ar_anchor import Anchor, ArAnnotationModel

model = ArAnnotationModel("building.glb")

hit = model.pick(model_to_project, origin=(12.0, 1.7, 5.0),
                 direction=(0.0, -0.5, 3.0))
if hit is not None:
    print(hit.point, hit.distance)      # 项目坐标、米制距离
    saved = hit.anchor.to_dict()        # 调用方持久化

# 重新校准后：
anchor = Anchor.from_dict(saved)
point = model.replay(new_model_to_project, anchor)
```

## 测试

```bash
python3 -m pytest tests/ -q
```

覆盖：交错布局叠加稀疏覆盖、无基础 bufferView、TRIANGLE_STRIP/FAN 展开、
共享 mesh 在嵌套旋转/负缩放/非均匀缩放下的多实例拾取、非单位方向射线、
边界同距命中仲裁、遮挡下的锚点回放、64 层节点链与 10 万三角形规模。
