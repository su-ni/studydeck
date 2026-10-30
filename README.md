# 研学台 StudyDeck

AI Native 学习工作台。前端是界面，后端是 AI 接入层与本机数据层：Agent 通过工具注册表直接操作本机的课程、题库、笔记与计划，流式对话驱动，数据只存本机。

| | |
|---|---|
| 前端 | React 18 + TypeScript (strict) + Vite |
| 后端 | Python 3.11+ / FastAPI + SQLite |
| 形态 | 单机 Web 应用（127.0.0.1:8770） |

<p align="center">
  <img src="screenshots/01-course-home.jpg" width="31%" alt="课程主页" />
  <img src="screenshots/02-classroom.jpg" width="31%" alt="课堂" />
  <img src="screenshots/03-practice.jpg" width="31%" alt="练习" />
</p>

## 架构

```
┌───────────────────── 前端（React 18 + TS strict，16 页）─────────────────────┐
│ 课程主页 / 课堂 / 练习 / 考场 / 画布（自研导图引擎）/ 截图库 / 全局搜索 / 助手 │
│ 流式渲染（SSE）· 思考可视化 · 操作卡 · 设计系统 · 响应式布局                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ SSE /api/agent/stream · REST /api/tool/{name}
                                 ▼
┌───────────────── AI 接入层（FastAPI）─────────────────┐
│ agent.py      Agent 循环：多轮工具编排、操作卡          │
│ tools.py      工具注册表（186 个，装饰器注册）           │
│ model_router  模型出口路由、上下文压缩                   │
│ evidence.py   证据检索与引文核对                        │
│ store.py      SQLite 数据层（20 张表）                   │
└───────────────────────────────────────────────────────┘
```

## 运行

```bash
pip install fastapi uvicorn

cp server/config.example.json server/config.local.json   # 填模型 Key

cd app && npm install && npm run build                   # 产物输出 web/app-dist/

python -m server.main                                    # 或双击 start.bat
# http://127.0.0.1:8770
```

## 目录

```
app/        前端源码（React + TS，Vite 构建到 ../web/app-dist）
server/     FastAPI：agent / tools / model_router / evidence / store
web/        静态资源
tests/      无头探针与单测
screenshots/  界面截图
```

## 许可

个人项目，仅限学习交流使用。第三方组件许可见源码内标注。
