# 海克斯大乱斗助手 (Hextech ARAM Assistant)

> 英雄联盟国服「海克斯大乱斗」模式实时推荐助手 — 第二阶段

## 架构概览

```
┌──────────────────────────────────────────────┐
│  网页前端 (React + Vite)                     │
│  :5173                                       │
│  ┌───────────┐ ┌─────────────┐ ┌──────────┐ │
│  │ 画面预览   │ │ LCU 数据面板 │ │ 推荐引擎  │ │
│  │ (屏幕捕获) │ │ (桥接状态)  │ │ (KB状态)  │ │
│  └───────────┘ └─────────────┘ └──────────┘ │
└──────┬──────────────────┬───────────────────┘
       │ /bridge → :3517  │ /kb,/assets → :4000
       │ (本地桥接)       │ (知识库服务)
┌──────▼──────────┐  ┌───▼─────────────────────┐
│  bridge/        │  │  knowledge-server/       │
│  :3517          │  │  :4000                   │
│  • lockfile 探测│  │  • 英雄梯度表             │
│  • LCU API 转发 │  │  • 海克斯评分             │
│  部署: 用户电脑  │  │  • 出装规则               │
│  未来: 打包分发  │  │  部署: 本地联调 → 公网     │
└──────┬──────────┘  └──────────────────────────┘
       │ https://127.0.0.1:<动态端口>
       │ (自签名证书, Basic Auth)
┌──────▼───────────────────────────────────────┐
│  LOL 国服客户端 (LCU API)                     │
└──────────────────────────────────────────────┘
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS 4 + OpenCV.js (WASM) |
| 桥接 | Node.js + TypeScript + chokidar (裸 http) |
| 知识库 | Node.js + TypeScript + Express |
| 包管理 | pnpm |

## 快速开始

### 前提条件

1. **Node.js >= 18** 已安装
2. **LOL 国服客户端已登录**（桥接程序需要读取 LCU API 数据）
3. 游戏建议设置为**无边框窗口模式**（为后续悬浮窗做准备，本阶段暂不影响使用）

### 安装 & 运行

```bash
# 1. 安装根目录依赖（前端）
pnpm install

# 2. 安装桥接程序依赖
cd bridge && pnpm install && cd ..

# 3. 安装知识库服务依赖
cd knowledge-server && pnpm install && cd ..

# 4. 拉取素材（英雄/装备/海克斯图标 + 元数据）
pnpm run fetch-assets

# 5. 一键启动三个服务
pnpm run dev
```

启动后：
- 前端界面：http://localhost:5173
- 桥接服务：http://127.0.0.1:3517
- 知识库服务：http://127.0.0.1:4000

### 单独启动

```bash
pnpm run dev:frontend      # 仅启动前端
pnpm run dev:bridge        # 仅启动桥接程序
pnpm run dev:kb            # 仅启动知识库服务
pnpm run fetch-assets      # 素材获取（一次性/版本更新时运行）
```

## 项目结构

```
HaiYiBa_lol_helper/
├── bridge/                     # 本地桥接程序（独立 Node 项目）
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── index.ts            # 入口：lockfile 探测 + HTTP 服务 + LCU 转发
├── knowledge-server/           # 知识库后端服务（独立 Node 项目）
│   ├── package.json
│   ├── tsconfig.json
│   ├── data/                   # 知识库 JSON 数据
│   │   ├── tier-list.json      # 英雄梯度表
│   │   ├── augment-scores.json # 海克斯评分表
│   │   ├── build-rules.json    # 出装规则表
│   │   └── combos.json         # 组合搭配表
│   ├── assets/                 # 素材文件（fetch-assets 写入）
│   │   ├── champions/          # 英雄图标 (PNG)
│   │   ├── items/              # 装备图标 (PNG)
│   │   └── augments/           # 海克斯图标 (PNG)
│   └── src/
│       └── index.ts            # Express 服务入口
├── scripts/
│   └── fetch-assets.ts         # 素材获取脚本
├── src/                        # 前端源码
│   ├── main.tsx                # React 入口
│   ├── App.tsx                 # 主布局（左预览 + 右面板）
│   ├── index.css               # 全局样式 + Tailwind
│   └── modules/
│       ├── ScreenCapture/      # 屏幕捕获模块
│       │   ├── index.ts
│       │   ├── ScreenCapture.tsx
│       │   ├── useBorderlessDetection.ts
│       │   ├── AugmentOverlay.tsx
│       │   ├── useAugmentDetection.ts
│       │   └── AugmentWorker/
│       │       └── worker.ts
│       ├── BridgePanel/        # 桥接状态 & LCU 数据展示
│       │   ├── index.ts
│       │   └── BridgePanel.tsx
│       └── Recommender/        # 推荐引擎
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

## 知识库服务详解

### REST 端点

| 端点 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /kb/version` | 知识库版本信息 |
| `GET /kb/tier-list` | 英雄梯度表 (S/A/B/C/D) |
| `GET /kb/augment-scores` | 海克斯评分表 |
| `GET /kb/build-rules` | 出装规则表 |
| `GET /kb/combos` | 组合搭配表 |
| `GET /assets/champions` | 英雄元数据列表 |
| `GET /assets/items` | 装备元数据列表 |
| `GET /assets/augments` | 海克斯元数据列表 |
| `GET /assets/icons/<category>/<file>` | 静态图标文件 |

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `KB_PORT` | `4000` | 知识库服务端口 |

## ⚠ Riot 开发者协议合规提醒

根据 Riot 开发者协议规定，本项目：
- **不展示海克斯强化 (Augment) 或 Arena 模式的胜率数据**
- 知识库中的评分使用 **S/A/B/C 梯度评级**，不以"胜率"等具体百分比数值呈现
- **不提供玩家原本不知道的、局内特定的信息**
- 本项目**只读 LCU API 数据**，不做任何自动操作（秒选、自动接受对局等）
- 使用第三方工具读取游戏数据请自行评估风险，本项目仅供学习研究

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
