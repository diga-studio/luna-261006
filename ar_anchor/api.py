"""上层调用入口：加载场景、射线拾取、锚点回放。"""
from __future__ import annotations

from typing import Optional

from .builder import build_scene_model
from .glb import load_glb
from .picker import ray_pick, replay_anchor
from .types import Anchor, RayHit


class ArAnnotationModel:
    """施工现场 AR 标注定位库入口对象。

    用法::

        model = ArAnnotationModel("building.glb")
        hit = model.pick(model_to_project, origin, direction)
        if hit is not None:
            saved = hit.anchor.to_dict()   # 调用方自行保存
        # 重新校准后：
        point = model.replay(new_model_to_project, Anchor.from_dict(saved))
    """

    def __init__(self, glb_path: str, scene_index: Optional[int] = None):
        """加载 GLB 2.0 文件并把指定场景展平到内存。

        scene_index 为 None 时使用 glTF 默认场景。
        """
        doc = load_glb(glb_path)
        self._model = build_scene_model(doc, scene_index)

    @property
    def triangle_count(self) -> int:
        return int(self._model.triangles.shape[0])

    def pick(self, model_to_project, origin, direction) -> Optional[RayHit]:
        """射线拾取。

        model_to_project：4x4 行主序可逆仿射矩阵（glTF 根空间 -> 项目空间）。
        origin / direction：项目空间射线起点与方向（方向不要求单位长度）。
        返回前向最近命中的 RayHit，无命中返回 None。
        """
        return ray_pick(self._model, model_to_project, origin, direction)

    def replay(self, model_to_project, anchor: Anchor):
        """锚点回放：返回锚点在新的模型位姿下的项目坐标三元组。"""
        return replay_anchor(self._model, model_to_project, anchor)
