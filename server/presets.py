# -*- coding: utf-8 -*-
"""模型厂家的预设地址：这张表里没有一句是猜的，全部是各家的 OpenAI 兼容端点。

为什么要有这张表：「接一家模型」这件事永远只有三件 —— 填地址、填 Key、选模型。
三件里只有 Key 是用户独有的，另外两件都是公开常量。让人自己去翻文档抄地址，
等于把我们该记住的事推给了人。

两条自我约束：
  ① **地址永远可改**。这张表是「默认值」，不是「唯一值」—— 厂家改域名从来不给通知。
  ② **模型清单不写死**。表里不放型号，型号靠 /models 现场拉；
     拉不到才让人自己填，宁可让手填一次，也不给一份三个月后就过期的清单。
"""

PRESETS = [
    {"id": "deepseek", "name": "DeepSeek", "base": "https://api.deepseek.com",
     "note": "国内直连，价格低，讲题够用"},
    {"id": "dashscope", "name": "通义千问 · 百炼", "base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
     "note": "阿里云百炼，兼容模式端点"},
    {"id": "zhipu", "name": "智谱 GLM", "base": "https://open.bigmodel.cn/api/paas/v4",
     "note": "BigModel 开放平台"},
    {"id": "moonshot", "name": "Moonshot · Kimi", "base": "https://api.moonshot.cn/v1",
     "note": "长上下文见长"},
    {"id": "siliconflow", "name": "硅基流动", "base": "https://api.siliconflow.cn/v1",
     "note": "聚合开源模型，一个 Key 走很多家"},
    {"id": "ark", "name": "火山方舟 · 豆包", "base": "https://ark.cn-beijing.volces.com/api/v3",
     "note": "模型名要填接入点 ID（ep- 开头）"},
    {"id": "minimax", "name": "MiniMax", "base": "https://api.minimax.chat/v1",
     "note": ""},
    {"id": "qianfan", "name": "百度千帆", "base": "https://qianfan.baidubce.com/v2",
     "note": "文心系列"},
    {"id": "openai", "name": "OpenAI", "base": "https://api.openai.com/v1",
     "note": "需要能连出去"},
    {"id": "openrouter", "name": "OpenRouter", "base": "https://openrouter.ai/api/v1",
     "note": "一个 Key 转发很多家，型号带前缀"},
    {"id": "ollama", "name": "本地 Ollama", "base": "http://localhost:11434/v1",
     "note": "本机跑的，不用 Key", "local": True},
    {"id": "lmstudio", "name": "本地 LM Studio", "base": "http://localhost:1234/v1",
     "note": "本机跑的，不用 Key", "local": True},
    {"id": "custom", "name": "自定义", "base": "",
     "note": "自己搭的网关 / 中转，填完整地址"},
]


def all():
    """整张表。界面按顺序铺出来，自定义放最后。"""
    return [dict(p) for p in PRESETS]


def by_id(pid):
    pid = (pid or "").strip().lower()
    for p in PRESETS:
        if p["id"] == pid:
            return dict(p)
    return None


def guess(base):
    """反查：给一个地址，看它是表里哪一家（用来把界面的下拉选回原样）。"""
    b = (base or "").strip().rstrip("/").lower()
    if not b:
        return None
    for p in PRESETS:
        if p["base"] and p["base"].lower().rstrip("/") == b:
            return dict(p)
    return None
