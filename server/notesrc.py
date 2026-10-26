# -*- coding: utf-8 -*-
"""研学台 · 外部笔记来源接入。

一句话目标：**别处记的笔记，能原样变成一张导图拿进来。**

分两类：
  file 类   Obsidian / Logseq / OPML / Markdown —— 只要一个文件夹或一个文件，
            不需要任何账号。这类最容易真的跑通，所以优先做扎实。
  api 类    Joplin / Notion / 语雀 / wolai —— 要填 token，有的还要本机起服务。
            没填就如实说没填，**绝不假装能连**。

规矩（跟项目其它地方一致）：
- 拿不到就返回 error 并说明原因，绝不编内容；
- 网络失败不抛给上层，包成 ok=False；
- 只读外部，不回写别人的库（pull 是单向的）。
"""
import shutil
import hashlib
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from . import config, store

NET_TIMEOUT = 20
MAX_BYTES = 4 * 1024 * 1024        # 单个文件 / 响应体的上限，防止手滑点到大文件
MAX_ITEMS = 400                    # 一次列最多这么多条

# 各来源的默认地址。填过 cfg 就用填的，没填用这里。
DEFAULTS = {
    "joplin": {"base": "http://127.0.0.1:41184"},
    "notion": {"base": "https://api.notion.com/v1"},
    "yuque": {"base": "https://www.yuque.com/api/v2"},
    "wolai": {"base": "https://openapi.wolai.com/v1"},
}

FILE_SRCS = ("obsidian", "logseq", "opml", "markdown")
API_SRCS = ("joplin", "notion", "yuque", "wolai")

# 批量导入时，单文件超过这个大小就先跳过（不读不解析），让用户自己决定要不要单独导。
# 理由：ob 库里常有几十 MB 的日记大文件，一次全导进来既慢又会撑爆画布。
_DEFAULT_REMEMBER_SIZE = 1024 * 1024

_IDX_PREFIX = "notesrc_idx_"      # 每个来源的导入进度存 kv 里


def _idx_key(src):
    return _IDX_PREFIX + str(src)


def _doc_id(src, abs_path):
    """一篇外部笔记 → 一个稳定的画布 ID。

    为什么用 realpath 再 hash：同一个库从不同路径指进来（盘符大小写、符号链接、
    网络盘映射）应该是同一篇笔记，换成 realpath 才不会因为「路径看着不一样」
    被导入两次。
    """
    if not abs_path:
        return "%s:000000000000" % src
    try:
        rp = os.path.realpath(str(abs_path))
    except Exception:
        rp = str(abs_path)
    h = hashlib.sha1(rp.encode("utf-8", "replace")).hexdigest()[:12]
    return "%s:%s" % (src, h)


def list_indexed():
    """kv 里所有笔记来源配置（不含导出进度），按来源分组。

    单独抽出来是为了给上层「扫全部已连来源」用 ——
    不想让 UI 去猜 kv 的键名格式（改一处就够了）。
    """
    out = {}
    try:
        con = store.connect()
        try:
            # SQLite 的 LIKE 默认不认反斜杠转义，写 notesrc\_% 等于找字面的
            # 「notesrc\」前缀，一个都匹配不到。这里直接 LIKE 'notesrc_%'，
            # 再用 startswith 把 idx 键剔掉（idx 键是 notesrc_idx_ 开头）。
            for r in con.execute("SELECT k, v FROM kv WHERE k LIKE 'notesrc_%'"):
                k = r["k"]
                if k.startswith(_IDX_PREFIX):
                    continue
                try:
                    out[k[len("notesrc_"):]] = json.loads(r["v"]) if r["v"] else {}
                except ValueError:
                    out[k[len("notesrc_"):]] = {}
        finally:
            con.close()
    except Exception:
        pass
    return out

# 每个来源要填什么、去哪填。前端照着显示，不用猜。
HINTS = {
    "obsidian": {"field": "path", "label": "Obsidian 库文件夹",
                 "eg": "D:\\我的库\\笔记",
                 "help": "在你的库里右键任意文件夹 → 复制路径，粘进来。会读里面所有 .md"},
    "logseq": {"field": "path", "label": "Logseq graphs 文件夹",
               "eg": "%USERPROFILE%\\logseq\\graphs\\我的图谱",
               "help": "里面有 pages/ 和 journals/ 两个子目录"},
    "opml": {"field": "path", "label": "OPML 文件",
             "eg": "D:\\导出\\大纲.opml",
             "help": "XMind / MindManager / 幕布 都能导出成这个格式"},
    "markdown": {"field": "path", "label": "Markdown 文件（可选）",
                 "eg": "D:\\笔记\\第二章.md",
                 "help": "也可以不填，直接用「粘贴 Markdown」"},
    "joplin": {"field": "token", "label": "Joplin Web Clipper Token",
               "eg": "在 Joplin 里 工具 → 选项 → 网页剪辑器 → 启用服务",
               "help": "端口默认 41184，token 就在那一页；Joplin 要开着"},
    "notion": {"field": "token", "label": "Notion Integration Token",
               "eg": "secret_ 或 ntn_ 开头的一长串",
               "help": "notion.so/my-integrations 建一个，再把要读的页面「连接」给这个集成"},
    "yuque": {"field": "token", "label": "语雀 API Token",
              "eg": "语雀 → 头像 → 设置 → 令牌 → 新建",
              "help": "只读权限就够"},
    "wolai": {"field": "token", "label": "wolai 开放 API Token",
              "eg": "wolai.com/dev 建应用后拿到",
              "help": "需要空间管理员权限"},
}

# 文件后缀：文本类只认这些，图片/压缩包一律跳过
TEXT_EXT = (".md", ".markdown", ".txt", ".org", ".opml")


# ================================================================ 配置读写
def _cfg_key(src):
    return "notesrc_%s" % src


def get_cfg(src):
    """读某个来源的配置。没配过返回空 dict，不返回 None。"""
    raw = store.kv_get(_cfg_key(src))
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def set_cfg(src, path=None, token=None, base=None, clear=False):
    """存配置。clear=True 就清空。path/token 传空串表示「删掉这一项」。"""
    if clear:
        store.kv_set(_cfg_key(src), "")
        return {}
    d = get_cfg(src)
    if path is not None:
        p = str(path).strip()
        if p:
            d["path"] = p
        else:
            d.pop("path", None)
    if token is not None:
        t = str(token).strip()
        if t:
            d["token"] = t
        else:
            d.pop("token", None)
    if base is not None:
        b = str(base).strip()
        if b:
            d["base"] = b
        else:
            d.pop("base", None)
    store.kv_set(_cfg_key(src), json.dumps(d, ensure_ascii=False))
    return d


def cfg_state(src):
    """这个来源现在能不能用，缺什么。前端全靠这个显示状态。"""
    d = get_cfg(src)
    h = HINTS.get(src) or {}
    need = h.get("field")
    if src == "local":
        return {"connected": True, "state": "本机自带", "missing": None, "cfg": {}}
    if src == "xmind":
        return {"connected": None, "state": "", "missing": None, "cfg": {}}   # 由 xmind.status() 填
    if src in FILE_SRCS:
        p = (d.get("path") or "").strip()
        if not p:
            if src == "markdown":
                return {"connected": True, "state": "可直接粘贴", "missing": None, "cfg": d}
            return {"connected": False, "state": "还没填文件夹", "missing": "path", "cfg": d}
        ok, why = _path_ok(p, want_dir=(src != "opml" and src != "markdown"))
        if not ok:
            return {"connected": False, "state": "路径不对：" + why, "missing": "path", "cfg": d}
        return {"connected": True, "state": "已指向本机文件", "missing": None, "cfg": d}
    # api 类
    tok = (d.get("token") or "").strip()
    if not tok:
        return {"connected": False, "state": "还没填 token", "missing": "token", "cfg": d}
    return {"connected": True, "state": "已填凭证（还没验证）", "missing": None, "cfg": d}


def _path_ok(p, want_dir=True):
    """路径存在性检查。给用户看的原因要具体，别只说「不存在」。"""
    p2 = os.path.expandvars(os.path.expanduser(p))
    if not os.path.exists(p2):
        return False, "这个路径不存在"
    if want_dir and not os.path.isdir(p2):
        return False, "这是个文件，这里要填文件夹"
    if (not want_dir) and os.path.isdir(p2):
        return False, "这是个文件夹，这里要填文件"
    return True, ""


def _expand(p):
    return os.path.expandvars(os.path.expanduser(p or ""))


# ================================================================ Markdown → 树
def md_tree(text, title=None):
    """Markdown → 树。

    规则跟主流笔记软件对齐：
      # 一级标题        → 深度 1，挂在根下
      ## / ###…        → 深度 = 井号数，自然成为上一级的子节点
      - / * / 1. 列表   → 深度 = 当前标题深度 + 1 + 缩进/2
      其余正文           → 进「当前节点」的备注，不新增节点

    实现用一个深度栈：节点深度 d 落下来之前，先把栈里深度 >= d 的全弹掉，
    弹完栈顶就是它的父节点。这样标题跳级（h1 直接跳 h3）、列表跳缩进都不会错位。
    """
    if not text:
        return {"error": u"没给 Markdown 内容"}
    root = {"id": "root", "text": title or u"导入的导图",
            "children": [], "note": ""}
    stack = [root]          # stack[0]=root(深度0)，stack[d]=深度 d 的当前节点
    head_depth = 1          # 最近一个标题的深度，列表项在它下面排
    seq = 0
    cur = root
    fence = False

    for raw in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.rstrip()
        # 代码围栏里的内容原样进备注，不当标题解析（否则代码里的 # 注释会变成节点）。
        # 围栏那两行 ``` 本身不写进备注 —— 那是格式标记，不是内容。
        if line.strip().startswith("```"):
            fence = not fence
            continue
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        s = line.strip()

        if not fence:
            m = re.match(r"^(#{1,6})\s+(.*)$", s)
            if m:
                depth = len(m.group(1))
                head_depth = depth
                node = {"id": "n%d" % seq, "text": _clean_title(m.group(2)),
                        "children": [], "note": ""}
                seq += 1
                while len(stack) > depth:
                    stack.pop()
                stack[-1].setdefault("children", []).append(node)
                stack.append(node)
                cur = node
                continue

            m = re.match(r"^([-*+]|\d+[.)])\s+(.*)$", s)
            if m:
                depth = head_depth + 1 + int(indent / 2)
                node = {"id": "n%d" % seq, "text": _clean_title(m.group(2)),
                        "children": [], "note": ""}
                seq += 1
                while len(stack) > depth:
                    stack.pop()
                stack[-1].setdefault("children", []).append(node)
                stack.append(node)
                cur = node
                continue

        # 正文：进当前节点的备注
        cur["note"] = (cur.get("note") or "") + ("\n" if cur.get("note") else "") + s

    root = _dedupe_root(root)
    n = count_nodes(root)
    return {"ok": True, "tree": root, "title": root["text"], "nodes": n,
            "note": u"按标题 / 列表层级转成了 %d 个节点；正文进了对应节点的备注" % n}


def _dedupe_root(root):
    """根和它唯一的那个孩子同名时，把孩子提上来。

    典型情况：文件名是「句子成分」，正文第一行又是「# 句子成分」 ——
    不提上来的话导图顶上会挂两个一模一样的节点，看着像出了 bug。
    """
    kids = root.get("children") or []
    if len(kids) != 1:
        return root
    k = kids[0]
    if (k.get("text") or "").strip() != (root.get("text") or "").strip():
        return root
    if not (k.get("children") or []):
        return root
    k = dict(k)
    # 根上自己可能带了前言正文，别丢
    if (root.get("note") or "").strip():
        k["note"] = "\n".join(x for x in (root.get("note"), k.get("note")) if x).strip()
    return k


def _is_whole_image(s):
    """整段就是一张 Markdown 图：![说明](路径)。图片节点，不是格式修饰。"""
    return bool(re.match(r"^!\[[^\]]*\]\([^)\s]+\)$", (s or "").strip()))


def _is_whole_link(s):
    """整段就是一个 Markdown 链接：[文字](地址)。链接节点。"""
    return bool(re.match(r"^\[[^\]]+\]\([^)\s]+\)$", (s or "").strip()))


def _clean_title(s):
    """标题里常见的 Markdown 修饰剥掉，但 [[双链]] 留着（那是内容不是格式）。

    两个例外**整段原样保留**（开发文档 6.1 的引用式规矩）：
    - 整段就是一张图 `![说明](相对路径)` —— 剥了路径，回写时就回不去了；
    - 整段就是一个链接 `[文字](地址)` —— 跳转地址是内容的一部分。
    图或链接混在长文字里仍然只算格式，剥掉留字。
    """
    s = (s or "").strip()
    if _is_whole_image(s) or _is_whole_link(s):
        return s
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"\1", s)
    s = re.sub(r"`(.+?)`", r"\1", s)
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)     # 图片 → 只留说明
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)      # 链接 → 只留文字
    return s.strip()


def tree_md(tree):
    """树还原成 Markdown。

    只认自己 md_tree 能读回来的形状：标题深度 = 层级+1（最深的标题不超过六级），
    超出六级之后一律用列表，不然写出去再读回来层级会塌。
    节点上的备注原样落到下一级的正文里（本来就是这么存进来的）。
    """
    if not tree:
        return ""
    out = []

    def lines_of(n):
        return [x for x in str(n.get("note") or "").split("\n") if x.strip()]

    def txt(n):
        t = str(n.get("text") or "").strip()
        return t or "(空)"

    def walk(n, d):
        head = "#" * max(1, min(6, d + 1))
        if d <= 5:
            out.append("%s %s" % (head, txt(n)))
        else:
            out.append("- %s" % txt(n))
        body = lines_of(n)
        if body:
            out.append("")
            out.extend(body)
            out.append("")
        for c in (n.get("children") or []):
            walk(c, d + 1)

    # 根自己的备注落在全文最前面（它本来就是这么读进来的：标题之前的那段引言）
    body0 = lines_of(tree)
    if body0:
        out.extend(body0)
        out.append("")
    out.append("# %s" % txt(tree))
    out.append("")
    for c in (tree.get("children") or []):
        walk(c, 1)
    return "\n".join(out).rstrip() + "\n"


def count_nodes(n):
    return 1 + sum(count_nodes(c) for c in (n.get("children") or []))


def image_stats(tree):
    """数一棵树里的图，回写计划用（开发文档 6.2 那张摊开表）。

    - assets/   画布新加、已落进笔记文件夹的 —— 写回只写相对引用
    - external  外部笔记里本来就有的相对路径图 —— 引用式，原样写回
    - cloud     /shots/ 或 http 直链 —— 本机能看，写回 md 就成了死链
    """
    st = {"assets": 0, "external": 0, "cloud": 0, "cloud_paths": []}

    def walk(n):
        m = re.match(r"^\s*!\[[^\]]*\]\(([^)\s]+)\)\s*$", str((n or {}).get("text") or ""))
        if m:
            p = m.group(1)
            if p.startswith("assets/"):
                st["assets"] += 1
            elif p.startswith("/") or re.match(r"^https?://", p):
                st["cloud"] += 1
                if len(st["cloud_paths"]) < 8:
                    st["cloud_paths"].append(p)
            else:
                st["external"] += 1
        for c in ((n or {}).get("children") or []):
            walk(c)

    walk(tree)
    return st


def _md_body(text):
    """去掉 frontmatter（--- 包起来那段），正文才进树。"""
    t = (text or "").replace("\r\n", "\n")
    if t.startswith("---"):
        i = t.find("\n---", 3)
        if i > 0:
            t = t[i + 4:]
    return t


# ================================================================ 画布图片资产
# 开发文档 6.1：画布上新加的图 → 写到笔记旁的 assets/，按哈希查重，同图不重复落盘。
# 文件型来源写进「笔记文件夹/assets/」（md 里写相对引用，回写时原样带走）；
# 本机画布写进 data/assets/（由 /assets/ 路由代理出去）。

IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif"}


def assets_dir(src=None):
    """这个来源的资产目录。src 缺省或不是文件型 → 本机 data/assets/。
    配置的路径可能是文件夹也可能是单个文件（markdown 来源常直接指一个 .md），
    是文件就取它所在的文件夹。"""
    if src in FILE_SRCS:
        base = _expand(get_cfg(src).get("path") or "")
        if base:
            base = os.path.abspath(base)
            if os.path.isfile(base):
                base = os.path.dirname(base)
            if os.path.isdir(base):
                return os.path.join(base, "assets")
    return os.path.join(config.APP_DATA_DIR, "assets")


def save_asset(data, src=None, ext=None):
    """一张图（data URL 或裸 base64）按哈希落盘。同一张图永远只存一份。

    返回 {ok, rel, url, existed, bytes}：
    - rel   md 里写的引用路径（文件型 → assets/<哈希>.<扩展名>）
    - url   本机预览地址（/noteimg/… 或 /assets/…），只用于画布显示，不写进 md
    """
    import base64
    if not data:
        return {"ok": False, "error": "没收到图片数据"}
    if data.startswith("data:"):
        head, _, data = data.partition(",")
        if "base64" not in head:
            return {"ok": False, "error": "只认 base64 编码的 data URL"}
        m = re.search(r"data:image/([a-z0-9]+)", head or "")
        if m and not ext:
            ext = "." + m.group(1)
    try:
        raw = base64.b64decode(data, validate=False)
    except Exception as e:
        return {"ok": False, "error": "解不出图片：%s" % e}
    if not raw:
        return {"ok": False, "error": "解出来是空图"}
    if len(raw) > 20 * 1024 * 1024:
        return {"ok": False, "error": "图太大了（%.1f MB），上限 20 MB" % (len(raw) / 1048576.0)}
    ext = (ext or ".png").lower()
    if ext not in IMG_MIME:
        ext = ".png"
    name = hashlib.sha256(raw).hexdigest()[:20] + ext
    d = assets_dir(src)
    try:
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, name)
        existed = os.path.exists(p)
        if not existed:
            with open(p, "wb") as f:
                f.write(raw)
    except Exception as e:
        return {"ok": False, "error": "写不进去：%s" % e}
    rel = "assets/" + name
    if src in FILE_SRCS:
        url = "/noteimg/%s?p=%s" % (src, urllib.parse.quote(rel))
        where = "笔记文件夹"
    else:
        url = "/assets/" + name
        where = "本机素材"
    return {"ok": True, "rel": rel, "url": url, "existed": existed,
            "bytes": len(raw), "where": where,
            "note": ("这张图早就在「%s/assets」里了，没重复存" % where) if existed
                    else ("已写进「%s」的 assets/" % where)}


def land_notion_image(url, title=None):
    """云端来源的图落地一份到 data/shots/note/（origin=note，开发文档 6.1）。

    回写永远不回云端图 —— 这里落的那份是给本机看的，md 里写 /shots/ 直链。
    拉不下来就返回 ok=False，调用方把说明写进节点备注，绝不编一张空图。
    """
    if not url or not re.match(r"^https?://", url):
        return {"ok": False, "error": "不是 http(s) 图片地址"}
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    if ext not in IMG_MIME:
        ext = ".png"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "StudyDeck/1.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            raw = r.read(MAX_BYTES + 1)
        if not raw or len(raw) > MAX_BYTES:
            return {"ok": False, "error": "图拉不下来或超过 %d MB 上限" % (MAX_BYTES // 1048576)}
    except Exception as e:
        return {"ok": False, "error": "下载失败：%s" % e}
    name = "note_" + hashlib.sha256(raw).hexdigest()[:16] + ext
    rel = "note/" + name
    root = os.path.join(config.APP_DATA_DIR, "shots")
    try:
        os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
        with open(os.path.join(root, rel), "wb") as f:
            f.write(raw)
    except Exception as e:
        return {"ok": False, "error": "落盘失败：%s" % e}
    sid = "sh_note_" + hashlib.sha256(raw).hexdigest()[:10]
    store.save_shot(sid, "note", rel, title=title or "Notion 图片",
                    nbytes=len(raw), tag="note", origin="note")
    return {"ok": True, "rel": rel, "url": "/shots/" + rel, "bytes": len(raw)}


# ================================================================ OPML → 树
def opml_tree(xml_text, title=None):
    """OPML 是导图软件之间最通用的交换格式，结构就是嵌套的 <outline>。"""
    try:
        root_el = ET.fromstring(xml_text)
    except Exception as e:
        return {"error": u"这个文件不是合法 XML：%s" % e}
    body = root_el.find("body")
    if body is None:
        return {"error": u"OPML 里没有 <body>，可能是别的格式改了后缀"}
    seq = [0]

    def conv(el):
        node = {"id": "n%d" % seq[0],
                "text": (el.get("text") or el.get("title") or "(无标题)").strip(),
                "children": [], "note": (el.get("_note") or "").strip()}
        seq[0] += 1
        for ch in list(el):
            if ch.tag.lower().endswith("outline"):
                node["children"].append(conv(ch))
        return node

    tops = [ch for ch in list(body) if ch.tag.lower().endswith("outline")]
    if not tops:
        return {"error": u"OPML 里一条 outline 都没有"}
    head = root_el.find("head")
    doc_title = title
    if not doc_title and head is not None:
        t = head.find("title")
        if t is not None and (t.text or "").strip():
            doc_title = t.text.strip()
    if len(tops) == 1:
        tree = conv(tops[0])
        if doc_title:
            tree["text"] = doc_title
    else:
        tree = {"id": "root", "text": doc_title or u"导入的大纲",
                "children": [conv(t) for t in tops], "note": ""}
    return {"ok": True, "tree": tree, "title": tree["text"], "nodes": count_nodes(tree),
            "note": u"按 outline 层级转成了 %d 个节点" % count_nodes(tree)}


# ================================================================ 文件型来源
def _walk_files(base, exts, limit=MAX_ITEMS):
    """走一个文件夹收指定后缀的文件。跳过 .git / node_modules 这类噪音目录。"""
    skip = {".git", ".obsidian", "node_modules", ".trash", ".logseq", "assets",
            "attachments", "__pycache__"}
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d.lower() not in skip and not d.startswith(".")]
        for fn in filenames:
            if len(out) >= limit:
                return out
            if fn.lower().endswith(exts):
                full = os.path.join(dirpath, fn)
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, base).replace("\\", "/")
                out.append({"id": rel, "title": os.path.splitext(fn)[0],
                            "path": full, "bytes": sz})
    out.sort(key=lambda x: (-x["bytes"], x["id"]))
    return out


def _read_text(path):
    """读文本文件。带 BOM 的、GBK 的都试一遍 —— 老笔记很多不是 UTF-8。"""
    if os.path.getsize(path) > MAX_BYTES:
        return None, u"这个文件 %d MB，太大了，没有读" % (os.path.getsize(path) // 1048576)
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(enc), ""
        except UnicodeDecodeError:
            continue
    return None, u"这个文件的编码认不出来（不是 UTF-8 也不是 GBK）"


def _mtime(f):
    try:
        return int(os.path.getmtime(f))
    except Exception:
        return 0


def list_file_src(src, q=None, with_path=False, since_ts=None, limit=None):
    """列来源里的笔记。

    with_path：默认 False。开了之后每条带 abs_path（绝对路径）—— 只给受控的导入流程用，
               因为要根据文件名那条 idiopathological 排序去重，
               拿到绝对路径才是可靠的 mtime / size 来源。
    since_ts ：只返回 mtime 大于它的，用来筛出「上次导入之后又改过的」。
    """
    d = get_cfg(src)
    p = d.get("path")
    if not p:
        return {"ok": False, "error": HINTS[src]["label"] + " 还没填",
                "need": "path", "hint": HINTS[src]}
    full = _expand(p)
    ok, why = _path_ok(full, want_dir=(src != "opml" and src != "markdown"))
    if not ok:
        return {"ok": False, "error": why, "need": "path", "hint": HINTS[src]}
    if os.path.isfile(full):
        files = [{"id": os.path.basename(full), "title": os.path.splitext(os.path.basename(full))[0],
                  "path": full, "bytes": os.path.getsize(full), "mtime": _mtime(full)}]
    else:
        exts = (".opml",) if src == "opml" else TEXT_EXT
        files = _walk_files(full, exts)
        for f in files:
            f["mtime"] = _mtime(f.get("path") or "")
    if q:
        ql = str(q).lower()
        files = [f for f in files if ql in f["id"].lower()]
    if since_ts:
        try:
            st = int(since_ts)
        except Exception:
            st = 0
        if st > 0:
            files = [f for f in files if int(f.get("mtime") or 0) > st]
    if limit:
        try:
            files = files[:int(limit)]
        except Exception:
            pass
    for f in files:
        p = f.pop("path", None)          # 默认不把绝对路径吐给前端
        if p:
            try:
                f["abs_path"] = os.path.abspath(p)
            except Exception:
                f["abs_path"] = p
        if not with_path:
            f.pop("abs_path", None)
    return {"ok": True, "items": files, "count": len(files), "q": q or "",
            "note": (u"共 %d 个文件" % len(files)) if files else u"这个文件夹里没找到可读的笔记"}


def pull_file_src(src, item_id, title=None):
    d = get_cfg(src)
    p = d.get("path")
    if not p:
        return {"ok": False, "error": HINTS[src]["label"] + " 还没填", "need": "path"}
    full = _expand(p)
    if os.path.isfile(full):
        target = full
    else:
        target = os.path.join(full, str(item_id or "").replace("/", os.sep))
    # 防越界：拼出来的路径必须还在这个库下面
    try:
        base_abs = os.path.abspath(full if os.path.isdir(full) else os.path.dirname(full))
        if not os.path.abspath(target).startswith(base_abs + os.sep) and \
           os.path.abspath(target) != base_abs:
            return {"ok": False, "error": u"这个条目不在你填的文件夹里"}
    except Exception:
        pass
    if not os.path.isfile(target):
        return {"ok": False, "error": u"找不到这个文件：%s" % item_id}
    text, why = _read_text(target)
    if text is None:
        return {"ok": False, "error": why}
    name = title or os.path.splitext(os.path.basename(target))[0]
    if target.lower().endswith(".opml"):
        return opml_tree(text, name)
    return md_tree(_md_body(text), name)


# ================================================================ 批量 / 增量导入
# fingerprint 三件套 = realpath + size + mtime，代表这个文件「现在的样子」。
# 只比 mtime 不够：有的同步盘改了内容但 mtime 不动（或反过来），
# 加上 size 之后误判概率低得多，代价只是多存一个数字。
def _fingerprint(abs_path, size=None, mtime=None):
    try:
        rp = os.path.realpath(abs_path)
    except Exception:
        rp = abs_path
    if size is None:
        try:
            size = os.path.getsize(abs_path)
        except Exception:
            size = 0
    return "%s|%s|%s" % (rp, size, mtime if mtime is not None else _mtime(abs_path))


def _load_index(src):
    raw = store.kv_get(_idx_key(src))
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def _put_index(src, files, last_ts):
    store.kv_set(_idx_key(src), json.dumps({"files": files, "last_ts": last_ts},
                                           ensure_ascii=False))


def reset_index(src=None):
    """断开重连时调：把某个来源（或全部）的导入进度忘掉。

    为什么要有这个：用户主动「重填一次路径」说明他想要一份干净的开始，
    这时候留着旧的 fingerprint 会导致「我明明重填了怎么一个都没导」。
    """
    if src:
        store.kv_set(_idx_key(src), "")
        return {"ok": True, "cleared": [str(src)]}
    cleared = []
    for k in FILE_SRCS:
        store.kv_set(_idx_key(k), "")
        cleared.append(k)
    return {"ok": True, "cleared": cleared}


def push_plan(src, map_row):
    """回写之前先把话说明白：要写到哪个文件、文件自打.Theme 拉进来之后改没改过、
       会不会覆盖别人的东西。

       返回 knew=外界已改 时上层必须停下来问用户 —— 直接盖上去等于吃掉别人的编辑。
    """
    if src not in FILE_SRCS:
        return {"ok": False, "error": "%s 不是文件夹类来源，回写这条路只有本机文件夹有" % src}
    # 画布 id 的那截就是文件指纹（obsidian:5ab277e9e3bc），最可靠；
    # src_id 存的是相对路径，文件被改名/移动过就对不上。
    ident = str(map_row.get("id") or map_row.get("src_id") or "")
    if not ident:
        return {"ok": False, "error": "这张画布不是从外面拉进来的（既没有来源条目也没有 id），不知道该写回哪篇笔记"}
    item = pull_plan_target(src, ident)
    if not item.get("ok"):
        return item
    abs_p = item["abs_path"]
    if not os.path.isfile(abs_p):
        return {"ok": False, "error": "对应的笔记文件已经不在了：%s" % item["rel"],
                "gone": True}
    idx = _load_index(src).get("files") or {}
    rec = idx.get(_doc_id(src, abs_p)) or {}
    if rec:
        fp = _fingerprint(abs_p)
        knew = (rec.get("fp") != fp)
    else:
        knew = False
    return {"ok": True, "abs_path": abs_p, "rel": item["rel"], "title": item.get("title"),
            "bytes": os.path.getsize(abs_p), "knew": knew,
            "note": ("这篇笔记自打上次导入后被改过了" if knew
                     else "这篇笔记和上次导入时一样，可以安全覆盖")}


def pull_plan_target(src, ident):
    """把「导入时记住的条目 id」还原成绝对路径。

    两种 id 都认：老的是相对路径（语法/句子成分.md），新的是 deidabriel 指纹
    （obsidian:1a2b3c4d5e6f）。认不出来就明说，不猜。
    """
    cfgp = get_cfg(src).get("path")
    base = _expand(cfgp) if cfgp else None
    if not base:
        return {"ok": False, "error": "%s 还没填文件夹" % src, "need": "path"}
    base_abs = os.path.abspath(base)
    # 指纹 id：拿当前库的清单对一遍（受 base 限制，出不了这个文件夹）
    files = _walk_files(base_abs, TEXT_EXT, MAX_ITEMS)
    # 第一条路：画布 id 的那截指纹（obsidian:5ab277e9e3bc → 5ab277e9e3bc）最准。
    # 库里的 src_id 记的是相对路径，文件一改名就对不上，指纹不会。
    if ":" in ident:
        dig = ident.rsplit(":", 1)[1]
        if dig:
            for f in files:
                if f.get("abs_path") and _doc_id(src, f["abs_path"]).rsplit(":", 1)[1] == dig:
                    return {"ok": True, "abs_path": f["abs_path"], "rel": f.get("file"),
                            "title": f.get("title"), "by": "fingerprint"}
    # 第二条路：指纹 id 整体相等
    for f in files:
        if f.get("abs_path") and _doc_id(src, f["abs_path"]) == ident:
            return {"ok": True, "abs_path": f["abs_path"], "rel": f.get("file"),
                    "title": f.get("title"), "by": "fingerprint"}
    # 第三条路：老的写法（src_id 就是相对路径）
    cand = os.path.abspath(os.path.join(base_abs, ident))
    if cand.startswith(base_abs + os.sep) and os.path.isfile(cand):
        return {"ok": True, "abs_path": cand, "rel": ident,
                "title": os.path.basename(cand), "by": "path"}
    return {"ok": False, "error": "在这个笔记夹里找不到 id 为 %s 的那篇笔记" % ident}


def push_file_src(src, map_row, tree, force=False, backup=True):
    """真的写回文件。规矩：
       - 默认先留一份 .bak，写坏了能拿回来；
       - 外界改过又不给 force 就拒绝，绝不替用户做「覆盖别人编辑」这个决定；
       - 写完把指纹更新进索引，否则下次导入会把自己的回写当成「外界改了」再导一遍。
    """
    plan = push_plan(src, map_row)
    if not plan.get("ok"):
        return plan
    abs_p = plan["abs_path"]
    if plan.get("knew") and not force:
        return {"ok": False, "error": "这篇笔记在外面被改过了，覆盖会吃掉别人的编辑。"
                                      "确认要盖就带上 force=true（会先留备份）",
                "need": "force", "rel": plan.get("rel"), "bytes": plan.get("bytes")}
    text = tree_md(tree)
    try:
        if backup and os.path.isfile(abs_p):
            shutil.copy2(abs_p, abs_p + ".bak")
        io.open(abs_p, "w", encoding="utf-8", newline="\n").write(text)
    except Exception as e:
        return {"ok": False, "error": "写不进去：%s" % e, "rel": plan.get("rel")}
    idx = _load_index(src)
    files = idx.get("files") or {}
    files[_doc_id(src, abs_p)] = {"fp": _fingerprint(abs_p), "file": plan.get("rel"),
                                  "title": plan.get("title")}
    _put_index(src, files, int(time.time()))
    return {"ok": True, "rel": plan.get("rel"), "bytes": len(text.encode("utf-8")),
            "backup": bool(backup and os.path.isfile(abs_p + ".bak")),
            "overwrote": bool(plan.get("knew")),
            "note": "已写回「%s」%s" % (plan.get("rel"),
                                       "（原文被覆盖，已留 .bak）" if plan.get("knew")
                                       else "（改动前那份还在 .bak 里）")}


def import_batch(src, since_ts=None, limit=None, lesson_id=None,
                 only=None, force=False):
    """File 类来源的批量 / 增量导入。

    逐条报下场（imported / skipped / failed / heavy），不笼统给一个 done。
    为什么必须逐条报：一次导 400 篇，前端要能说「有 3 篇挂了，是哪 3 篇」，
    不然用户以为全进来了，回头发现少了东西只会觉得这软件骗人。
    """
    src = (src or "").strip()
    if not src:
        return {"ok": False, "error": u"没说是哪个来源"}
    if src in ("local", "xmind"):
        return {"ok": False, "error": u"%s 不走文件夹导入这条路" % src}
    if src in API_SRCS:
        return {"ok": False,
                "error": u"%s 是云端来源，批量导入还没做" % HINTS.get(src, {}).get("label", src)}
    if src not in FILE_SRCS:
        return {"ok": False, "error": u"不认识的来源：%s" % src}

    cfg = get_cfg(src)
    try:
        remember_size = int(cfg.get("remember_size") or _DEFAULT_REMEMBER_SIZE)
    except Exception:
        remember_size = _DEFAULT_REMEMBER_SIZE

    lst = list_file_src(src, with_path=True,
                        since_ts=(None if force else since_ts), limit=limit)
    if not lst.get("ok"):
        return lst
    items = lst.get("items") or []
    if only:
        want = set(only) if isinstance(only, (list, tuple)) else set([str(only)])
        items = [f for f in items if f.get("id") in want]

    idx_all = _load_index(src)
    known = {} if force else dict(idx_all.get("files") or {})
    now_files = dict(known)
    max_ts = int(idx_all.get("last_ts") or 0)

    did, skip, fail, heavy = [], [], [], []
    for f in items:
        ap = f.get("abs_path")
        fid = f.get("id")
        if not ap:
            fail.append({"file": fid, "reason": u"拿不到绝对路径，跳过了"})
            continue
        size = int(f.get("bytes") or 0)
        mtime = int(f.get("mtime") or 0)
        fp = _fingerprint(ap, size, mtime)
        if (not force) and fp in known.values():
            skip.append(fid)
            continue
        if size > MAX_BYTES:
            # 超硬上限：连 BD 也随之跳过，不占 indexed 名额
            heavy.append({"file": fid, "bytes": size, "reason": u"超过 %d MB 上限" % (MAX_BYTES // 1024 // 1024)})
            continue
        if size > remember_size:
            # 不自动导，但要记住它现在的样子 ——
            # 否则下次用户手动单独导入它，增量会再把它当成「没见过」重复一遍
            now_files[fid] = fp
            heavy.append({"file": fid, "bytes": size, "reason": u"超过 %d KB，要单独导入" % (remember_size // 1024)})
            continue
        got = pull_file_src(src, fid)
        if not got.get("ok"):
            fail.append({"file": fid, "reason": got.get("error") or u"没转成树"})
            continue
        mid = _doc_id(src, ap)
        ttl = got.get("title") or fid
        store.save_canvas(mid, title=ttl, tree=got.get("tree") or {},
                          lesson_id=lesson_id, src=src, src_id=fid)
        store.add_event("note", mid, payload="import %s <- %s" % (src, fid))
        did.append({"file": fid, "map": mid, "title": ttl,
                    "nodes": got.get("nodes") or 0})
        now_files[fid] = fp
        if mtime > max_ts:
            max_ts = mtime

    _put_index(src, now_files, max_ts)
    return {"ok": True, "src": src, "scanned": len(items),
            "force": bool(force), "last_ts": max_ts,
            "imported": did, "imported_n": len(did),
            "skipped": skip, "skipped_n": len(skip),
            "failed": fail, "failed_n": len(fail),
            "heavy": heavy, "heavy_n": len(heavy),
            "note": _batch_note(len(items), len(did), len(skip), len(heavy), len(fail))}


def _batch_note(scanned, imported, skipped, heavy, failed):
    ps = []
    if imported:
        ps.append(u"导入 %d 篇" % imported)
    if skipped:
        ps.append(u"跳过 %d 篇（上次之后没改过）" % skipped)
    if heavy:
        ps.append(u"%d 篇太大没自动导" % heavy)
    if failed:
        ps.append(u"%d 篇没转成树" % failed)
    return (u"、".join(ps) + u"。") if ps else u"扫了 %d 个文件，没有需要处理的。" % scanned


def import_state():
    """现在连了哪些 File 来源、各自导了多少 —— 给人看的。"""
    rows = []
    for sid, cfg in sorted(list_indexed().items()):
        if sid not in FILE_SRCS:
            continue
        if not (cfg.get("path") or "").strip():
            continue
        idx = _load_index(sid)
        last = idx.get("last_ts")
        rows.append({"id": sid, "label": HINTS[sid]["label"], "path": cfg.get("path"),
                     "imported": len(idx.get("files") or {}),
                     "last_ts": last,
                     "last_at": (time.strftime("%Y-%m-%d %H:%M", time.localtime(int(last)))
                                 if last else u"还没导过")})
    return {"ok": True, "sources": rows, "count": len(rows),
            "note": (u"已连 %d 个文件夹类来源" % len(rows)) if rows
                    else u"还没有填过任何笔记文件夹"}


# ================================================================ HTTP 小工具
def _http(url, headers=None, data=None, method=None, timeout=NET_TIMEOUT):
    """统一发请求。**任何失败都变成 (None, 原因) 返回**，不抛。"""
    h = {"User-Agent": "StudyDeck/1.0 (local study app)"}
    h.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                return None, u"对方返回的数据超过 %d MB，没有继续读" % (MAX_BYTES // 1048576)
            return raw.decode("utf-8", "replace"), ""
    except urllib.error.HTTPError as e:
        try:
            detail = e.read(600).decode("utf-8", "replace")
        except Exception:
            detail = ""
        if e.code in (401, 403):
            return None, u"凭证被拒（HTTP %d）—— token 可能填错或过期了。%s" % (e.code, detail[:220])
        if e.code == 404:
            return None, u"对方的地址不对（HTTP 404）—— 检查 base 有没有填错"
        return None, u"对方返回 HTTP %d：%s" % (e.code, detail[:220])
    except urllib.error.URLError as e:
        return None, (u"连不上：%s。"
                      u"（Joplin 要先把桌面版的网页剪辑器打开）" % getattr(e, "reason", e))
    except Exception as e:
        return None, u"请求失败：%s: %s" % (type(e).__name__, e)


def _json(raw, why):
    if raw is None:
        return None, why
    try:
        return json.loads(raw), ""
    except Exception:
        return None, u"对方返回的不是 JSON（可能地址填成了网页）"


def _api_base(src):
    d = get_cfg(src)
    return (d.get("base") or DEFAULTS.get(src, {}).get("base") or "").rstrip("/")


def _tok(src):
    return (get_cfg(src).get("token") or "").strip()


# ================================================================ Joplin
def _joplin(path, params=None):
    p = dict(params or {})
    p["token"] = _tok("joplin")
    q = urllib.parse.urlencode(p)
    url = "%s%s?%s" % (_api_base("joplin"), path, q)
    return _json(*_http(url))


def joplin_list(q=None):
    if not _tok("joplin"):
        return {"ok": False, "error": u"还没填 Joplin 的 token", "need": "token",
                "hint": HINTS["joplin"]}
    # _joplin 内部已经走过 _json，返回的就是解析好的 dict —— 这里**不能**再 _json 一次。
    # 再包一层会让 json.loads(dict) 抛异常，报成「对方返回的不是 JSON」，
    # 而真实响应其实完全正常，排查时会被这句假话带偏。
    d, why = _joplin("/notes", {"fields": "id,title,parent_id,updated_time", "limit": 100})
    if d is None:
        return {"ok": False, "error": why}
    items = d.get("items") or []
    # 笔记本名字单独查一次，列表里才看得出是哪本
    fd, _w = _joplin("/folders", {"fields": "id,title", "limit": 100})
    fmap = {}
    if fd:
        fmap = {f["id"]: f.get("title") or "" for f in (fd.get("items") or [])}
    out = []
    for it in items:
        tt = it.get("title") or "(无标题)"
        if q and str(q).lower() not in tt.lower():
            continue
        out.append({"id": it.get("id"), "title": tt,
                    "parent": fmap.get(it.get("parent_id"), ""),
                    "parent_id": it.get("parent_id") or "",
                    "updated": it.get("updated_time") or ""})
    # 按笔记本分桶。不分组的话 100 条笔记挤在一列里，找东西全靠肉眼扫。
    # 只给有名字的笔记本建桶；没挂笔记本的（parent_id 为空）归到「未分类」。
    groups = []
    seen = {}
    for row in out:
        pn = row.get("parent") or u"未分类"
        if pn not in seen:
            seen[pn] = {"title": pn or u"未分类", "items": []}
            groups.append(seen[pn])
        seen[pn]["items"].append(row)
    for g in groups:
        g["count"] = len(g["items"])
    return {"ok": True, "items": out[:MAX_ITEMS], "count": len(out),
            "groups": groups,
            "note": (u"共 %d 条笔记，分在 %d 个笔记本里" % (len(out), len(groups))
                     if groups else u"Joplin 里还没有笔记")}


def joplin_pull(note_id, title=None):
    # 同上：_joplin 已经返回解析好的 dict
    d, why = _joplin("/notes/" + urllib.parse.quote(str(note_id)),
                     {"fields": "id,title,body"})
    if d is None:
        return {"ok": False, "error": why}
    body = d.get("body") or ""
    if not body.strip():
        return {"ok": False, "error": u"这条笔记是空的"}
    return md_tree(body, title or d.get("title") or u"Joplin 笔记")


# ================================================================ Notion
def _notion(path, params=None, data=None, method=None):
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = _api_base("notion") + path + q
    return _json(*_http(url, headers={
        "Authorization": "Bearer " + _tok("notion"),
        "Notion-Version": "2022-06-28",
    }, data=data, method=method))


def notion_list(q=None):
    if not _tok("notion"):
        return {"ok": False, "error": u"还没填 Notion 的 Integration Token", "need": "token",
                "hint": HINTS["notion"]}
    d, why = _notion("/search", data={"page_size": 100})
    if d is None:
        return {"ok": False, "error": why}
    out = []
    for r in (d.get("results") or []):
        tt = _notion_title(r)
        if not tt:
            continue
        if q and str(q).lower() not in tt.lower():
            continue
        out.append({"id": r.get("id"), "title": tt,
                    "kind": r.get("object") or "", "updated": r.get("last_edited_time") or ""})
    return {"ok": True, "items": out[:MAX_ITEMS], "count": len(out),
            "note": (u"共 %d 条；只列你**连接给这个集成**的页面"
                     % len(out)) if out else
                    u"这个集成还看不到任何页面 —— 去 Notion 页面右上角「…」→ 连接 → 选中你的集成"}


def _notion_title(r):
    """Notion 的标题藏在 properties 里，且键名不固定（Title / 名称 / Name）。"""
    props = r.get("properties") or {}
    for _k, v in props.items():
        if (v or {}).get("type") == "title":
            arr = v.get("title") or []
            return "".join((x.get("plain_text") or "") for x in arr).strip()
    tt = r.get("title")
    if isinstance(tt, list):
        return "".join((x.get("plain_text") or "") for x in tt).strip()
    return ""


def _rich(arr):
    return "".join((x.get("plain_text") or "") for x in (arr or [])).strip()


def notion_pull(page_id, title=None):
    """把一个页面的 block 递归拉下来。只处理最常见的几种 block，其余按段落拼。"""
    root = {"id": "root", "text": title or u"Notion 页面", "children": [], "note": ""}
    seq = [0]

    def walk(block_id, node, depth=0):
        if depth > 5:
            return
        d, why = _notion("/blocks/" + urllib.parse.quote(str(block_id)) + "/children",
                         {"page_size": 100})
        if d is None:
            return
        for b in (d.get("results") or []):
            if b.get("archived") or b.get("in_trash"):
                continue
            t = b.get("type") or ""
            body = b.get(t) or {}
            txt = _rich(body.get("rich_text"))
            if t in ("heading_1", "heading_2", "heading_3") and txt:
                seq[0] += 1
                ch = {"id": "n%d" % seq[0], "text": txt, "children": [], "note": ""}
                node["children"].append(ch)
                if b.get("has_children"):
                    walk(b["id"], ch, depth + 1)
            elif t in ("bulleted_list_item", "numbered_list_item", "to_do", "toggle") and txt:
                seq[0] += 1
                ch = {"id": "n%d" % seq[0], "text": txt, "children": [], "note": ""}
                node["children"].append(ch)
                if b.get("has_children"):
                    walk(b["id"], ch, depth + 1)
            elif t == "image":
                # 云端来源的图：落地一份到本机截图库（origin=note），md 里写 /shots/ 直链。
                # 回写不回云端 —— 拉不下来就老老实实写进备注，绝不假装图还在。
                src_url = ((body.get("file") or {}).get("url")
                           or (body.get("external") or {}).get("url") or "")
                alt = _rich(body.get("caption")) or ""
                d_img = land_notion_image(src_url, title=alt or None)
                if d_img.get("ok"):
                    seq[0] += 1
                    ch = {"id": "n%d" % seq[0],
                          "text": "![%s](%s)" % (alt, d_img["url"]),
                          "children": [], "note": ""}
                    node["children"].append(ch)
                else:
                    node["note"] = (node.get("note") or "") + \
                        ("\n" if node.get("note") else "") + \
                        "[图片没拉下来] %s（%s）" % (alt or "未命名", d_img.get("error") or src_url)
            elif t == "child_page":
                seq[0] += 1
                ch = {"id": "n%d" % seq[0], "text": body.get("title") or u"(子页面)",
                      "children": [], "note": ""}
                node["children"].append(ch)
                walk(b["id"], ch, depth + 1)
            elif txt:
                node["note"] = (node.get("note") or "") + \
                    ("\n" if node.get("note") else "") + txt
            if b.get("has_children") and t not in (
                    "bulleted_list_item", "numbered_list_item", "to_do", "toggle",
                    "heading_1", "heading_2", "heading_3", "child_page"):
                walk(b["id"], node, depth + 1)

    walk(page_id, root)
    if not root["children"] and not (root.get("note") or "").strip():
        return {"ok": False, "error": u"这个页面上没有可转成节点的内容（可能是空的或全是图）"}
    n = count_nodes(root)
    return {"ok": True, "tree": root, "title": root["text"], "nodes": n,
            "note": u"从 Notion 拉下来 %d 个节点" % n}


# ================================================================ 语雀
def _yuque(path, params=None):
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = _api_base("yuque") + path + q
    return _json(*_http(url, headers={"X-Auth-Token": _tok("yuque")}))


def yuque_list(q=None):
    if not _tok("yuque"):
        return {"ok": False, "error": u"还没填语雀的 API Token", "need": "token",
                "hint": HINTS["yuque"]}
    d, why = _yuque("/user/repos", {"limit": 100})
    if d is None:
        return {"ok": False, "error": why}
    repos = d.get("data") if isinstance(d, dict) else d
    out = []
    for r in (repos or []):
        nm = r.get("name") or ""
        ns = (r.get("namespace") or "").split("/")
        full = "%s/%s" % (ns[0], r.get("slug") or nm) if r.get("slug") else (r.get("namespace") or nm)
        tt = ("%s / %s" % (r.get("namespace") or "", nm)).strip(" /")
        if q and str(q).lower() not in tt.lower():
            continue
        out.append({"id": full, "title": tt, "kind": "repo",
                    "docs": r.get("items_count") or 0})
    return {"ok": True, "items": out[:MAX_ITEMS], "count": len(out),
            "note": u"共 %d 个知识库" % len(out)}


def yuque_pull(repo, title=None):
    """item 既可以是知识库（`命名空间/库名`），也可以是单篇文档。

    判断办法：单篇文档传的是 `库/文档slug` 两段，知识库传的是 `命名空间/库名` 两段——
    形状一样、没法靠段数分辨。所以**先按知识库试**，拿到 docs 列表再判断：
    如果 item 的末段正好等于库里某篇文档的 slug，就按单篇拉正文；否则按整库展开。
    这样用户在列表里点哪条都能用同一个入口。

    （语雀的文档正文只能单篇取，没有「一次给我整库正文」的接口。）
    """
    if not _tok("yuque"):
        return {"ok": False, "error": u"还没填语雀的 API Token", "need": "token"}
    parts = str(repo).split("/")
    if len(parts) < 2:
        return {"ok": False, "error": u"语雀的条目要写成「命名空间/库名」或「命名空间/库名/文档」"}
    doc_slug = parts[-1] if len(parts) >= 3 else ""
    repo_path = "/".join(parts[:2])
    if doc_slug:
        return _yuque_one(repo_path, doc_slug, title)
    d, why = _yuque("/repos/%s/docs" % urllib.parse.quote(repo_path),
                    {"limit": 100, "optional_properties": "title"})
    if d is None:
        return {"ok": False, "error": why}
    docs = d.get("data") if isinstance(d, dict) else d
    if not docs:
        return {"ok": False, "error": u"这个知识库里没有文档"}
    root = {"id": "root", "text": title or str(repo), "children": [], "note": ""}
    for i, doc in enumerate(docs[:60]):
        node = {"id": "n%d" % i, "text": doc.get("title") or u"(无标题)",
                "children": [], "note": ""}
        root["children"].append(node)
    n = count_nodes(root)
    return {"ok": True, "tree": root, "title": root["text"], "nodes": n,
            "note": (u"知识库里有 %d 篇文档，这里建了 %d 个分支。"
                     u"要看正文就点某一篇单独导入" % (len(docs), len(root["children"])))}


def _yuque_one(repo_path, doc_slug, title=None):
    """单篇文档：取正文，按 Markdown 转成树。"""
    d, why = _yuque("/repos/%s/docs/%s" % (urllib.parse.quote(repo_path),
                                          urllib.parse.quote(str(doc_slug))))
    if d is None:
        return {"ok": False, "error": why}
    body = ((d.get("data") or {}) if isinstance(d, dict) else {}).get("body") or ""
    if not body.strip():
        # 语雀的正文里如果是纯粘贴的富文本，api 可能只给 HTML。
        # 这时如实说清，不猜着解析。
        return {"ok": False,
                "error": u"这篇文档取回来没有 Markdown 正文（可能是纯富文本/图床内容）"}
    return md_tree(body, title or ((d.get("data") or {}).get("title") or doc_slug))


# ================================================================ wolai
def _wolai(path, params=None):
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = _api_base("wolai") + path + q
    return _json(*_http(url, headers={"Authorization": "Bearer " + _tok("wolai")}))


# ================================================================ Joplin 自动发现
# Joplin 是唯一「不用注册任何第三方账号」就能真连上的云端类来源：桌面版自带一个
# 本地 Web Clipper 服务（默认 127.0.0.1:41184），开着就能读。所以这里主动探测，
# 探到了就把地址填好，用户只剩「把 token 粘进来」这一步。
# 端口会冲突，用户也可能改过，所以按默认端口 + 常见候选依次试，不写死一个。
_JOPLIN_PORTS = (41184, 41185, 41186, 41187, 41188)


def joplin_probe(ports=None):
    """扫一下本机有没有开着的 Joplin 服务。

    只做两件事：连得上吗、要 token 吗。**不试探 token**（那是在猜别人的凭证）。
    返回 {ok, base, need_token, note}；一个都没探到就 ok=False 并说清怎么开。
    """
    cands = list(ports or _JOPLIN_PORTS)
    # 探测路径必须带服务前缀：Joplin 的 Clipper 挂在 /joplin 下面，
    # 裸 /ping 是没有的。用户把 base 填成 127.0.0.1:41184 时，
    # 真实请求地址是 127.0.0.1:41184/joplin/notes —— 同一套前缀。
    prefixes = ("/joplin", "")
    tried = []
    for p in cands:
        b = "http://127.0.0.1:%d" % p
        for pre in prefixes:
            url = b + pre + "/ping"
            raw, why = _http(url, timeout=2)
            tried.append("%s → %s" % (url, u"通" if raw is not None else u"不通"))
            if raw is None:
                continue
            try:
                d = json.loads(raw)
            except Exception:
                d = {}
            if str(d.get("status") or "").lower().startswith("joplin"):
                return {"ok": True, "base": b + pre, "need_token": True,
                        "note": (u"探到 Joplin 在 %s（版本 %s）。"
                                 u"把「网页剪辑器」那页的 token 粘进来就能读笔记"
                                 % (b + pre, d.get("message") or u"?"))}
    return {"ok": False,
            "error": (u"本机没探到开着的 Joplin。在 Joplin 里打开："
                      u"工具 → 选项 → 网页剪辑器 → 启用服务（默认端口 41184）"),
            "tried": tried}


def wolai_list(q=None):
    if not _tok("wolai"):
        return {"ok": False, "error": u"还没填 wolai 的 API Token", "need": "token",
                "hint": HINTS["wolai"]}
    d, why = _wolai("/blocks", {"page_size": 100})
    if d is None:
        return {"ok": False, "error": why}
    blocks = d.get("data") or d.get("blocks") or []
    out = []
    for b in blocks:
        tt = b.get("title") or ""
        if not tt:
            continue
        if q and str(q).lower() not in tt.lower():
            continue
        out.append({"id": b.get("id"), "title": tt, "kind": b.get("type") or ""})
    return {"ok": True, "items": out[:MAX_ITEMS], "count": len(out),
            "note": (u"共 %d 个页面" % len(out)) if out else
                    u"这个 token 还看不到页面 —— 去 wolai 应用设置里把页面授权给这个应用"}


def wolai_pull(block_id, title=None):
    """页面块递归拉下来。原来只取一层 —— 页面里嵌套的子块全丢了，
    拉下来是一张只有标题、没有内容的图。"""
    if not _tok("wolai"):
        return {"ok": False, "error": u"还没填 wolai 的 API Token", "need": "token"}
    root = {"id": "root", "text": title or u"wolai 页面", "children": [], "note": ""}
    seq = [0]
    seen = set()          # 已经展开过的块 id。防重入 —— 有的接口对子查询会回同一批块，
                          # 不记就无限递归，实测能堆出 127 个节点。

    def walk(bid, node, depth=0):
        if depth > 5 or not bid or str(bid) in seen:
            return
        seen.add(str(bid))
        d, why = _wolai("/blocks/" + urllib.parse.quote(str(bid)) + "/children",
                        {"page_size": 100})
        if d is None:
            return
        blocks = d.get("data") or d.get("blocks") or []
        for b in blocks:
            txt = b.get("title") or b.get("content") or ""
            txt = str(txt).strip()
            if not txt:
                continue          # 空块（分隔线、图片块）跳过，别造出一堆无名节点
            seq[0] += 1
            ch = {"id": "n%d" % seq[0], "text": txt[:120], "children": [], "note": ""}
            node["children"].append(ch)
            walk(b.get("id"), ch, depth + 1)

    walk(block_id, root)
    if not root["children"]:
        return {"ok": False, "error": u"这个页面上没有文字块"}
    n = count_nodes(root)
    return {"ok": True, "tree": root, "title": root["text"], "nodes": n,
            "note": u"拉到 %d 个块" % n}


# ================================================================ 统一入口
def src_list(src, q=None):
    src = (src or "").strip()
    if src in FILE_SRCS:
        return list_file_src(src, q)
    if src == "joplin":
        return joplin_list(q)
    if src == "notion":
        return notion_list(q)
    if src == "yuque":
        return yuque_list(q)
    if src == "wolai":
        return wolai_list(q)
    return {"ok": False, "error": u"不认识的来源：%s" % src}


def src_pull(src, item, title=None):
    src = (src or "").strip()
    # 「粘贴一段文本直接转树」：item 本身就是 Markdown 正文（不是文件路径）。
    # 但现在 markdown 既能粘贴也能指到一个文件 / 文件夹 —— 列表出来的条目都是文件名，
    # 必须先把「这条是不是我库里的一个真文件」问清楚，再去当正文解析：
    # 否则 notebook 侧点「挑一条」拿到的树永远是「标题 + 一条叫文件名的备注」，
    # 一个节点都没有（实测过：README.md → {"text":"README","children":[],"note":"README.md"}）。
    if src == "markdown":
        target = _resolve_file_src(src, item)
        return pull_file_src(src, item, title) if target else md_tree(item, title)
    if src in FILE_SRCS:
        return pull_file_src(src, item, title)
    if src == "joplin":
        return joplin_pull(item, title)
    if src == "notion":
        return notion_pull(item, title)
    if src == "yuque":
        return yuque_pull(item, title)
    if src == "wolai":
        return wolai_pull(item, title)
    return {"ok": False, "error": u"不认识的来源：%s" % src}


def _resolve_file_src(src, item_id):
    """item_id 在这个来源配的路径下面是不是一个真文件。是就返回绝对路径，不是返回 None。

    和 pull_file_src 里那段同出一辙（含同样的防越界判断），但那边一发现读不了就直接
    返回 error —— 这里要的是「能不能当成文件读」这个是非题，不是错误文案，所以单拎出来。
    """
    p = get_cfg(src).get("path")
    if not p or not item_id:
        return None
    full = _expand(p)
    if os.path.isfile(full):
        target = full
    else:
        target = os.path.join(full, str(item_id).replace("/", os.sep))
    try:
        base_abs = os.path.abspath(full if os.path.isdir(full) else os.path.dirname(full))
        tgt_abs = os.path.abspath(target)
        if not tgt_abs.startswith(base_abs + os.sep) and tgt_abs != base_abs:
            return None
    except Exception:
        return None
    return target if os.path.isfile(target) else None


def src_test(src):
    """连一下试试。file 类查路径，api 类真发一次请求。"""
    st = cfg_state(src)
    if src == "local":
        return {"ok": True, "state": "本机自带", "note": u"本地画布不需要连"}
    if src == "xmind":
        return {"ok": bool(st.get("connected")), "state": st.get("state") or "",
                "note": u"XMind 用顶栏那个按钮登录"}
    if src == "joplin" and not st.get("connected"):
        # Joplin 除了「填 token」还有一条路：本机开着服务，先探测再让用户粘 token。
        # 直接把探测结果交回去，前端就能把 base 顺手填好，少一步手抄。
        pr = joplin_probe()
        if pr.get("ok"):
            return {"ok": False, "state": pr["note"], "need": "token",
                    "probe": pr, "hint": HINTS.get(src)}
    if not st.get("connected") and st.get("missing"):
        return {"ok": False, "state": st.get("state") or "",
                "error": u"还差「%s」没填" % (HINTS.get(src, {}).get("label") or st["missing"]),
                "need": st.get("missing"), "hint": HINTS.get(src)}
    r = src_list(src)
    if not r.get("ok"):
        return {"ok": False, "state": st.get("state") or "",
                "error": r.get("error") or u"连不上", "need": r.get("need"),
                "hint": r.get("hint")}
    return {"ok": True, "state": "连上了", "count": r.get("count", 0),
            "note": r.get("note") or (u"读到 %d 条" % r.get("count", 0))}
