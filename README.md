# 海克斯大乱斗助手 (Hextech ARAM Assistant)

> 英雄联盟国服「海克斯大乱斗」模式实时推荐助手 — 第一阶段

## 架构概览

```
┌─────────────────────────────────┐
│  网页前端 (React + Vite)        │
│  :5173                          │
│  ┌───────────┐ ┌─────────────┐ │
│  │ 画面预览   │ │ LCU 数据面板 │ │
│  │ (屏幕捕获) │ │ (桥接状态)  │ │
│  └───────────┘ └─────────────┘ │
└──────────────┬──────────────────┘
               │ http://127.0.0.1:3517
               │ (普通 HTTP + CORS)
┌──────────────▼──────────────────┐
│  本地桥接程序 (Node.js)         │
│  :3517                          │
│  • lockfile 探测                │
│  • LCU API 转发                 │
└──────────────┬──────────────────┘
               │ https://127.0.0.1:<动态端口>
               │ (自签名证书, Basic Auth)
┌──────────────▼──────────────────┐
│  LOL 国服客户端 (LCU API)       │
└─────────────────────────────────┘
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS 4 |
| 桥接 | Node.js + TypeScript + Express (裸 http) |
| 包管理 | npm |

## 快速开始

### 前提条件

1. **Node.js >= 18** 已安装
2. **LOL 国服客户端已登录**（桥接程序需要读取 LCU API 数据）
3. 游戏建议设置为**无边框窗口模式**（为后续悬浮窗做准备，本阶段暂不影响使用）

### 安装 & 运行

```bash
# 1. 安装根目录依赖（前端）
npm install

# 2. 安装桥接程序依赖
cd bridge && npm install && cd ..

# 3. 一键启动前后端
npm run dev
```

启动后：
- 前端界面：http://localhost:5173
- 桥接服务：http://127.0.0.1:3517

### 单独启动

```bash
npm run dev:frontend   # 仅启动前端
npm run dev:bridge     # 仅启动桥接程序
```

## 项目结构

```
LOL_helper/
├── bridge/                     # 本地桥接程序（独立 Node 项目）
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── index.ts            # 入口：lockfile 探测 + HTTP 服务 + LCU 转发
├── src/                        # 前端源码
│   ├── main.tsx                # React 入口
│   ├── App.tsx                 # 主布局（左预览 + 右面板）
│   ├── index.css               # 全局样式 + Tailwind
│   └── modules/
│       ├── ScreenCapture/      # 屏幕捕获模块（画面预览）
│       │   ├── index.ts
│       │   └── ScreenCapture.tsx
│       ├── BridgePanel/        # 桥接状态 & LCU 数据展示
│       │   ├── index.ts
│       │   └── BridgePanel.tsx
│       └── Recommender/        # 推荐引擎（占位，后续阶段实现）
│           ├── index.ts
│           └── Recommender.tsx
├── package.json                # 根目录（前端 + concurrently）
├── vite.config.ts
└── README.md
```

## 桥接程序详解

### Lockfile 探测机制

桥接程序启动后自动探测 LOL 客户端 LCU API 凭据，按优先级使用以下方式：

1. **Lockfile 文件**（优先）— 读取客户端安装目录下的 `lockfile` 文件
   - 国服常见路径：
     - `C:\Riot Games\League of Legends\lockfile`
     - `C:\Program Files\Tencent\WeGameApps\英雄联盟\lockfile`
   - 可通过环境变量 `LOL_INSTALL_PATH` 手动指定安装目录
2. **进程命令行兜底** — PowerShell 查询 `LeagueClientUx.exe` 的 `--app-port` 和 `--remoting-auth-token`

探测到凭据后，通过 **fs.watch 文件监听**（即时）+ **3 秒轮询**（兜底）持续跟踪客户端状态。

### HTTP 端点

| 端点 | 说明 |
|---|---|
| `GET /status` | 桥接 & LCU 连接状态，含召唤师名和当前游戏阶段 |
| `GET /proxy?endpoint=<path>` | 转发请求到 LCU API，自动附带 Basic Auth |
| `OPTIONS *` | CORS 预检，含 `Access-Control-Allow-Private-Network: true` |

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BRIDGE_PORT` | `3517` | 桥接 HTTP 服务端口 |
| `LOL_INSTALL_PATH` | — | 手动指定 LOL 安装目录 |

## LCU API 数据展示

本阶段已打通以下 LCU 接口并在前端展示：

- `/lol-summoner/v1/current-summoner` — 当前召唤师信息（名称、等级、头像）
- `/lol-gameflow/v1/session` — 游戏阶段（大厅 / 选人 / 对局中）
- `/lol-champ-select/v1/session` — 大乱斗选人数据（英雄、备选席、队友）

## CORS & Private Network Access

桥接程序已预埋 `Access-Control-Allow-Private-Network: true` 响应头，为后续公网部署做准备。Chrome 142+ 对"公网页面 → 本地地址"的请求要求被请求方显式同意，本阶段前后端同机部署暂不触发此校验。

验证方式：
```bash
curl -X OPTIONS http://127.0.0.1:3517/status -i
# 响应中应包含: Access-Control-Allow-Private-Network: true
```

## 验收清单

- [x] `npm run dev` 一条命令启动前后端
- [x] 网页「开始捕获」选择 LOL 窗口后实时显示画面
- [x] LOL 在线时面板显示召唤师名和游戏阶段
- [x] 进入选人时能看到英雄、备选席、队友
- [x] 客户端关闭后面板感知并显示"未检测到客户端"
- [x] 客户端重新打开后自动重连
- [x] CORS 预检响应含 `Access-Control-Allow-Private-Network: true`
- [x] TypeScript 无报错
- [x] `bridge/` 和前端依赖互相独立

## 后续阶段规划

- 知识库（英雄数据、装备、符文数据库）
- 推荐引擎（基于阵容分析的智能推荐算法）
- Document Picture-in-Picture 悬浮窗
- 图像识别（OCR 读取游戏内文字）
- 桥接程序正式打包分发（pkg / single executable）
- 网页公网部署

## 注意事项

- 本项目**只读 LCU API 数据**，不做任何自动操作（秒选、自动接受对局等）
- 使用第三方工具读取游戏数据请自行评估风险，本项目仅供学习研究
