# -*- coding: utf-8 -*-
"""研学台 · 权限档：写盘这件事到底要不要人点一下。

市面上的 agent 软件（Trae / WorkBuddy / Claude Code / Cursor）都是同一个思路：
不是一刀切「永远确认」或者「永远放行」，而是**给人一个档位开关**，
默认保守，愿意的人自己拧到全自动。

三档：
    ask       默认。改本机的工具要先弹确认卡，人点了才落盘。
    auto      完全信任。改本机直接落盘，事后在轨迹里留痕告诉你改了什么。
    readonly  只看不改。改本机的工具一律拒绝，一眼看出是被挡的，不是失败。

铁律：**档位只能由人改**，模型自己不能把自己的权限拧大。
所以 set_mode 不注册成工具，只挂在 /api/perm 这个 HTTP 接口上。
"""
from __future__ import annotations

from . import store

KV = "perm.mode"

# 顺序即界面顺序：从最严到最松，人往下读就是在放开权限。
MODES = {
    "readonly": "只看不改：任何写操作都挡住",
    "ask": "改本机的东西先问你一声（默认）",
    "auto": "完全信任：改本机的东西直接落盘，事后告诉你改了什么",
}
DEFAULT = "ask"


def mode():
    m = (store.kv_get(KV) or DEFAULT).strip().lower()
    return m if m in MODES else DEFAULT


def set_mode(m):
    """只有人（界面/接口）能调。工具注册表里没有它 —— 模型碰不到。"""
    m = (m or "").strip().lower()
    if m not in MODES:
        return {"ok": False, "error": "没有这一档：%s（可选 %s）"
                % (m or "(空)", " / ".join(MODES))}
    store.kv_set(KV, m)
    return {"ok": True, "mode": m, "note": MODES[m]}


def state():
    return {"mode": mode(), "modes": [{"id": k, "why": v} for k, v in MODES.items()]}
