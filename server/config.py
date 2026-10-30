# -*- coding: utf-8 -*-
"""研学台 · 集中配置。

约定：业务代码里不允许出现字面量路径 / 端口 / 开关。
要改行为，只改这个文件，或在 server/config.local.json 里覆盖（同名键）。
"""
import io
import json
import os

# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(SERVER_DIR)                     # 研学台/
PROJECT_ROOT = os.path.dirname(APP_DIR)                   # 仓库根目录（研学台/ 的上一级）

WEB_DIR = os.path.join(APP_DIR, "web")
APP_DATA_DIR = os.path.join(APP_DIR, "data")

# 只读数据源：沿用旧工作台构建好的数据，不改不删
SOURCE_DATA_DIR = os.path.join(PROJECT_ROOT, "workbench", "data")
PROTO_DATA = os.path.join(PROJECT_ROOT, "outputs", "proto_data.json")
PROGRESS_JSON = os.path.join(SOURCE_DATA_DIR, "progress.json")
EXAM_PAPERS = os.path.join(SOURCE_DATA_DIR, "exam_papers.json")
# 考点卡真源（cs 98 条问答 + cs 505 条填空 + 政治 613 条简答，共 1216 条 Q/A）
POINT_CARDS = os.path.join(SOURCE_DATA_DIR, "point_cards.json")
# 自己导进来的题（考研 / 考编 / 别的考试都往这儿放）。
# 结构见 datahub.imported_sources 的注释；文件不存在就是空的，不影响启动。
IMPORTED_SOURCES = os.path.join(APP_DATA_DIR, "sources.json")

DB_PATH = os.path.join(APP_DATA_DIR, "study.db")
BACKUP_DIR = os.path.join(APP_DATA_DIR, "backup")
BACKUP_PREFIX = "studydeck_"
# 恢复前自动留的安全副本走另一个前缀，不跟用户自己点出来的备份混在一个列表里
BEFORE_RESTORE_PREFIX = "studydeck_before_restore_"
PROGRESS_BACKUP_DIR = BACKUP_DIR

# --------------------------------------------------------------------------
# 多端同步（G1）
# --------------------------------------------------------------------------
# 同步目录 = 两台机器都能看到的同一个文件夹（网盘同步盘 / U 盘 / 共享目录）。
# 本机把库写成一个包放进去，另一台把这个包拉回来并进自己的库。不上云，不传第三方。
SYNC_ENABLED = True
SYNC_DIR = os.path.join(PROJECT_ROOT, "sync")
SYNC_DIRNAME = "studydeck-sync"
SYNC_BUNDLE_PREFIX = "syncbundle_"
SYNC_DEVICE_NAME = ""        # 留空用主机名
SYNC_AUTO_ON_EVENT = False   # 不后台自动写文件，只在你点「推出本机」时写

# --------------------------------------------------------------------------
# 服务
# --------------------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 8770

# --------------------------------------------------------------------------
# 品牌文案（通用工具：不绑死某一次考试 / 某一个专业）
# --------------------------------------------------------------------------
# 研学台是个通用学习台，科目、讲义、题库全部来自 workbench/data 下的数据文件，
# 界面上不再写死「某年某考」。改这里或 config.local.json 即可。
APP_TITLE = "研学台"
APP_SUBTITLE = "StudyDeck"

# --------------------------------------------------------------------------
# 学习规则（可调，不写死在工具里）
# --------------------------------------------------------------------------
SM2_INTERVALS = [0, 1, 2, 4, 7, 15, 30]   # box 0..6 对应的间隔天数
TODAY_DAILY_WORDS = 28                     # 首页展示的"今日到期"目标（仅用于展示口径）
QUIZ_DEFAULT_SIZE = 10

# --------------------------------------------------------------------------
# 题源与判分（通用化：五科共用一套练习链）
# --------------------------------------------------------------------------
# 判分档：exact 只做标准化等值，不需要模型；其余两档要模型，ENABLE_LLM=False 时
# 工具如实返回待判（manual），绝不假装判过。
JUDGE_EXACT = "exact"              # 选择/短答案等值比对
JUDGE_AI_EXACT = "ai_exact"        # 先等值，判不出再交给模型（填空）
JUDGE_AI_SEMANTIC = "ai_semantic"  # 要点命中评分（简答）
JUDGE_MANUAL = "manual"            # 交给人：模型未接入时的诚实兜底

# 建「题库式」（有 ABCD 选项）的题源。考点卡的 qa 卡有明确空位，
# 由 build_choices() 用同卡其它答案造干扰项；cloze/recall 卡不造题，保持原形。
CHOICE_SOURCES = {"grammar780", "pc-cs99"}

# --------------------------------------------------------------------------
# 整卷评分口径（D4）
# --------------------------------------------------------------------------
# 真卷里每题只有 ans，不带分值；15 套卷题型组合还不一样（2023 年没有
# 「词汇与语法单选」，2021 年有 40 道单选，语法填空压根没有 ABCD 选项）。
# 所以本机按「题型权重」评分：答对一题加该题型权重，再折算成百分制。
#
# 权重不是官方分值（原卷只给答案不给分值），是本机评分口径，写在这里可改。
EXAM_TOTAL_SCORE = 100.0        # 折算后的整卷满分
EXAM_PASS_SCORE = 60.0          # 及格线（界面只标"过/没过"，不是官方省控线）
EXAM_TOTAL_MINUTES = 120        # 官方考试时长（分钟），模考倒计时按这个走

# 题型 → {"label": 界面显示名, "each": 每题权重, "judgeable": 能不能自动判分}
EXAM_TYPE_RULES = {
    "reading": {"label": "阅读理解", "each": 2.0, "judgeable": True,
                "src": "四选一，原卷带答案"},
    "single":  {"label": "词汇与语法单选", "each": 1.0, "judgeable": True,
                "src": "四选一，原卷带答案"},
    "cloze":   {"label": "完形填空", "each": 1.5, "judgeable": True,
                "src": "四选一，原卷带答案"},
    "seven":   {"label": "七选五", "each": 2.0, "judgeable": True,
                "src": "七选五，原卷带答案"},
    "blank":   {"label": "语法填空", "each": 1.5, "judgeable": False,
                "src": "要自己写词，原卷没给选项，本机不自动判分"},
}

# 权限：local 本地自动执行 / net 需联网 / confirm 需用户确认后执行
PERM_LOCAL = "local"
PERM_NET = "net"
PERM_CONFIRM = "confirm"

# 需要二次确认的工具（前端会弹确认条）
CONFIRM_TOOLS = {"sync_xuecheng", "mark_lesson_done", "restore_backup",
                 "sync_pull", "plan_set_budget", "plan_from_sentence",
                 "source_import", "source_drop",
                 "agent_reset",      # 清空会话：清掉就没了，必须点两次
                 # 设置页这三件都动本机文件/整库，必须点过才跑
                 "platform_reset", "ai_apikey_set", "ai_apikey_clear",
                 # 断开 XMind 清登录态
                 "xmind_disconnect",
                 # 删掉拉进来的卷
                 "paper_drop"}

# --------------------------------------------------------------------------
# 作文批改（D5）
# --------------------------------------------------------------------------
# 维度是广东专升本《英语基础与写作》写作部分公开的分值切法（应用文满分 15）：
# 内容 5 / 语言 5 / 结构 3 / 文采 2。这是评分口径不是代码，写在这里可改。
WRITING_MAX_SCORE = 15
WRITING_DIMS = [
    {"key": "content",  "label": "内容", "max": 5, "what": "要点是否写全（题目给了几条要点就几条）"},
    {"key": "language", "label": "语言", "max": 5, "what": "语法、用词、拼写"},
    {"key": "structure","label": "结构", "max": 3, "what": "分段、衔接、格式（书信/通知的称呼落款）"},
    {"key": "richness", "label": "文采", "max": 2, "what": "句式变化与高级表达"},
]
# 本机在没有模型的时候**只做能算的**：字数、要点词命中、格式行数。
# 这些是数出来的，不是估的；要语言/文采分必须模型，模型没接就如实不给。
WRITING_LOCAL_DIMS = ["content", "structure"]    # 本机能量化的两档
WRITING_BANK = os.path.join(SOURCE_DATA_DIR, "writing_bank.json")

# --------------------------------------------------------------------------
# 外部能力开关（未接通时工具要如实返回"未接入"，不许编数据）
# --------------------------------------------------------------------------
ENABLE_NET_FETCH = False     # 学丞词条拉取
ENABLE_LLM = False           # AI 讲解

# B 站找课（server/bili.py）。只读公开接口：搜候选 → 取分集目录 → 交叉核对。
# 这条链路不发用户数据出去，也不下载视频，只拿标题 / 时长 / 分集数。
ENABLE_SEARCH = True
SEARCH_TIMEOUT = 8           # 单个接口超时秒数；核一条课要打两个接口

# --------------------------------------------------------------------------
# 模型调用层（server/llm.py）
# --------------------------------------------------------------------------
# 只认 OpenAI 兼容的 /chat/completions，DeepSeek、通义、Kimi、本地 ollama 都是这个形状。
# Key 不写在这个文件里，放 server/config.local.json 的 LLM_API_KEY 覆盖。
# ENABLE_LLM=False 时 llm.chat() 一律返回 {ok:False, reason:"..."}，调用方必须自己
# 决定降级怎么说 —— 绝不返回假内容冒充模型。
LLM_BASE_URL = "https://api.deepseek.com"
LLM_MODEL = "deepseek-chat"
LLM_API_KEY = ""
LLM_TIMEOUT = 45             # 秒；讲一道题不该等超过这个数
LLM_TEMPERATURE = 0.2        # 低温度：讲题要稳，不要创作
# 这一份额度是「思考 + 正文」一起用的，不是「正文」用的。
# 原来写 1200 是按「一句话的回答」估的；选到推理模型时它光想就 2333 字，
# 正文那一路一个字都轮不到，人看到的就是「模型没回话」。
# 8000 是实测取值：hy3 一轮思考就能吃掉 7340 字（含完整工具清单的系统提示
# 让它想得更多），4000 的时候正文明明一个字都没轮到。思考 + 正文都得装得下。
LLM_MAX_TOKENS = 8000

# 思考预算（仅对认这个字段的上游生效）。6000 是实测：3000 时它会在
# 「正在权衡」的地方被截断，半截的思考捞不出动作，那一轮就白跑了。
LLM_THINK_TOKENS = 6000
LLM_MOCK = False             # True = 不联网，返回离线假答（只在测试里开）

# 讲题这一步的硬约束：模型必须在给定依据上说话，引文必须能在原文里逐字找到。
# 校验不过就丢掉重来一次，第二次还不过就只给本机证据版，不硬凑。
EXPLAIN_MAX_RETRY = 1
EXPLAIN_MIN_QUOTE_HIT = 1.0  # 引文命中率低于这个值（1.0 = 全部逐字命中）就当没引

# --------------------------------------------------------------------------
# 平台账号（server/platform_ai.py）：不装客户端也能用 WorkBuddy / Trae 的模型
# --------------------------------------------------------------------------
# 这两家不是 OpenAI 兼容的 Key 形状，是账号 token：会过期、有各自的刷新接口。
# 所以另开一层，不混进上面的 LLM_*（混进去会让「本机没接模型」这句话变模糊）。
# 默认模型名是实测列目录拿到的真名，不是猜的；列不出来就用列出来的第一个。
# 注意：WorkBuddy 的 "auto" 实测落在 hy4-preview —— 那是个推理模型，
# 1200 token 全烧在 reasoning_content 上，正文一个字都不吐（finish_reason=length）。
# 所以默认不给 auto，给实测能吐正文的那个；要 auto 就在界面里显式选。
WB_MODEL = "deepseek-v4-flash"         # WorkBuddy：实测 2.6 秒吐完整 JSON
TRAE_MODEL = "DeepSeek-V4-Flash"       # Trae：solo_work_lite 目录里实测可用
TRAE_FUNCTION = "solo_work_lite"       # Trae 聊天要走哪个 function

# 百词斩词条（配图 / 词根词缀 / 例句）。
# 协议在 server/bcz.py，接口要 access_token；token 从 App 的 MMKV 里读出来放在这里，
# 或写进 config.local.json 的 BCZ_ACCESS_TOKEN 覆盖。留空则每次调用如实返回"没配 token"。
ENABLE_BCZ = True
BCZ_ACCESS_TOKEN = ""
BCZ_TIMEOUT = 12             # 秒
BCZ_CACHE_TTL_DAYS = 30      # 词条落盘缓存多久算新鲜


def _apply_local_override(cfg):
    """server/config.local.json 覆盖同名键（方便换机器、换端口）。

    也可以用环境变量 MDSA_CONFIG 指到另一份 json —— 「开一个空白实例」就靠这个：
    同一份代码、同一个 web 目录，只把数据目录和服务端口换掉，
    这样看到的是真空库真空白，不是另拷一份代码出去假装。
    """
    path = os.environ.get("MDSA_CONFIG") or os.path.join(SERVER_DIR, "config.local.json")
    if not os.path.exists(path):
        return cfg
    try:
        with io.open(path, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


_apply_local_override(globals())

# 用户从 B 站挑进来、当场核过时长的课。不写进 proto_data.json，因为那份是构建产物
# （铁律：不重跑 build_proto_data.py）；这里还是活的，datahub.proto() 读时合并进来。
# 必须放在 _apply_local_override 之后：空实例会把 APP_DATA_DIR 换成 data-blank，
# 提前算出来就会指回正式库 —— 在空实例点一次「入库」就污染正式数据。
COURSES_EXTRA = os.path.join(APP_DATA_DIR, "courses_extra.json")
# 从百词斩拉进来的词书（AI 自己取，不是构建产物）。同 courses_extra 的道理，
# 写在 APP_DATA_DIR 下、datahub 读取时合并；不能碰 workbench/data/vocab.json（只读源）。
VOCAB_EXTRA = os.path.join(APP_DATA_DIR, "vocab_extra.json")
# AI 从网上拉回来的真题卷（workbench 那份 15 套是只读源，不改不删）
PAPERS_EXTRA = os.path.join(APP_DATA_DIR, "papers_extra.json")
# AI 生成的题（按考点卡作依据）。跟「真题」分开放，判分与展示都标 ai。
GEN_QUESTIONS = os.path.join(APP_DATA_DIR, "gen_questions.json")


def ensure_dirs():
    for d in (APP_DATA_DIR, PROGRESS_BACKUP_DIR):
        os.makedirs(d, exist_ok=True)
