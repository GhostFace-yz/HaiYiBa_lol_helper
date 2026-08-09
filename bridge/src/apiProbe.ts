/**
 * apiProbe — 游戏 API 探针 + 日志记录
 *
 * 目的：找出「海克斯选择界面打开」在 API 层面的可观测信号（方式二验证）。
 *
 * 持续轮询（每 1s）：
 * - LCU /lol-gameflow/v1/session      → 记录游戏阶段变化（ChampSelect / InProgress ...）
 * - Live Client Data (127.0.0.1:2999) → 探测游戏是否在进行（无需鉴权，游戏客户端自带）
 *   - 游戏进行中轮询 /liveclientdata/eventdata，逐条记录新事件（完整 JSON）
 *
 * 手动快照：
 * - GET /probe/mark?label=xxx 时抓取所有候选端点的完整响应，
 *   写入 logs/snapshots/<时间戳>-<label>/，用于事后对照「海克斯界面打开瞬间」的 API 现场
 *
 * 日志文件：bridge/logs/api-probe-YYYY-MM-DD.log
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGS_DIR = fileURLToPath(new URL('../logs/', import.meta.url));
const POLL_INTERVAL_MS = 1000;
const LIVE_CLIENT_PORT = 2999;

/** Live Client Data 候选端点（快照时全量抓取） */
const LIVE_CLIENT_ENDPOINTS = [
  'gamestats',
  'eventdata',
  'activeplayer',
  'activeplayername',
  'activeplayerabilities',
  'playerlist',
  'allgamedata',
] as const;

interface ProbeDeps {
  /** 发起 LCU 请求（未连接时 reject） */
  lcuRequest: (method: string, endpoint: string) => Promise<string>;
  /** LCU 当前是否已连接 */
  isLcuConnected: () => boolean;
}

interface ProbeState {
  inGame: boolean;
  gameMode?: string;
  lastPhase?: string;
  eventsSeen: number;
  lastEventId: number;
}

const probeState: ProbeState = {
  inGame: false,
  eventsSeen: 0,
  lastEventId: -1,
};

/* ── 日志工具 ─────────────────────────────────────────────── */

function nowForFile(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function nowForLog(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function currentLogFile(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return path.join(LOGS_DIR, `api-probe-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
}

/** 写日志文件（并同步输出到控制台） */
export function probeLog(msg: string) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(currentLogFile(), `[${nowForLog()}] ${msg}\n`);
  } catch {
    // 日志写失败不影响主流程
  }
  console.log(`[probe] ${msg}`);
}

/* ── Live Client Data 请求（无鉴权，自签名证书） ───────────── */

function liveClientRequest(apiName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: LIVE_CLIENT_PORT,
        path: `/liveclientdata/${apiName}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        rejectUnauthorized: false,
        timeout: 1500,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

/* ── 轮询逻辑 ─────────────────────────────────────────────── */

async function pollGameflow(deps: ProbeDeps) {
  if (!deps.isLcuConnected()) return;
  try {
    const body = await deps.lcuRequest('GET', '/lol-gameflow/v1/session');
    const phase = JSON.parse(body)?.phase as string | undefined;
    if (phase && phase !== probeState.lastPhase) {
      probeLog(`🎮 gameflow 阶段: ${probeState.lastPhase ?? '(无)'} → ${phase}`);
      probeState.lastPhase = phase;
    }
  } catch {
    // LCU 抖动，忽略
  }
}

async function pollLiveClient() {
  let gamestatsBody: string | null = null;
  try {
    gamestatsBody = await liveClientRequest('gamestats');
  } catch {
    gamestatsBody = null;
  }

  const inGame = gamestatsBody !== null;

  // 游戏开始 / 结束转换
  if (inGame && !probeState.inGame) {
    probeState.inGame = true;
    probeState.eventsSeen = 0;
    probeState.lastEventId = -1;
    try {
      const gs = JSON.parse(gamestatsBody!);
      probeState.gameMode = gs.gameMode;
      probeLog(`🟢 游戏开始: mode=${gs.gameMode} map=${gs.mapTerrain ?? '?'}`);
    } catch {
      probeLog('🟢 游戏开始（gamestats 解析失败）');
    }
  } else if (!inGame && probeState.inGame) {
    probeState.inGame = false;
    probeLog(`🔴 游戏结束（本局共记录 ${probeState.eventsSeen} 个事件）`);
  }

  if (!inGame) return;

  // 游戏进行中：轮询事件流，逐条记录新事件
  try {
    const body = await liveClientRequest('eventdata');
    const data = JSON.parse(body);
    const events = (data?.Events ?? []) as { EventID: number; EventName: string; EventTime: number }[];
    if (events.length === 0) return;

    // 新对局 EventID 会重新从 0 开始
    const maxId = Math.max(...events.map((e) => e.EventID));
    if (maxId < probeState.lastEventId) probeState.lastEventId = -1;

    for (const ev of events) {
      if (ev.EventID > probeState.lastEventId) {
        probeLog(`📌 事件 #${ev.EventID} [t=${ev.EventTime?.toFixed(1)}s] ${ev.EventName} ${JSON.stringify(ev)}`);
        probeState.eventsSeen++;
        probeState.lastEventId = ev.EventID;
      }
    }
  } catch {
    // eventdata 偶发不可用，忽略
  }
}

/* ── 手动快照 ─────────────────────────────────────────────── */

/** 快照文件名安全化 */
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^\w一-龥-]/g, '_').slice(0, 40);
  return cleaned || 'mark';
}

export interface SnapshotResult {
  dir: string;
  files: string[];
  inGame: boolean;
  phase?: string;
}

/**
 * 抓取所有候选端点的完整响应写入快照目录。
 * 用法：海克斯选择界面打开时访问 /probe/mark?label=augment1
 */
export async function takeSnapshot(label: string, deps: ProbeDeps): Promise<SnapshotResult> {
  const dirName = `${nowForFile()}-${sanitizeLabel(label)}`;
  const dir = path.join(LOGS_DIR, 'snapshots', dirName);
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  const save = (name: string, content: string) => {
    fs.writeFileSync(path.join(dir, name), content);
    files.push(name);
  };

  // Live Client Data 全端点
  for (const ep of LIVE_CLIENT_ENDPOINTS) {
    try {
      const body = await liveClientRequest(ep);
      save(`liveclient-${ep}.json`, body);
    } catch (err) {
      save(`liveclient-${ep}.error.txt`, err instanceof Error ? err.message : String(err));
    }
  }

  // LCU 侧
  if (deps.isLcuConnected()) {
    for (const ep of ['/lol-gameflow/v1/session', '/lol-summoner/v1/current-summoner']) {
      try {
        const body = await deps.lcuRequest('GET', ep);
        save(`lcu${ep.replace(/\//g, '_')}.json`, body);
      } catch (err) {
        save(`lcu${ep.replace(/\//g, '_')}.error.txt`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 元信息
  save('_meta.json', JSON.stringify({
    label,
    time: new Date().toISOString(),
    inGame: probeState.inGame,
    gameMode: probeState.gameMode,
    gameflowPhase: probeState.lastPhase,
    eventsSeenSoFar: probeState.eventsSeen,
  }, null, 2));

  probeLog(`📸 快照已保存 [${label}] → logs/snapshots/${dirName}（${files.length} 个文件，inGame=${probeState.inGame}）`);
  return { dir: dirName, files, inGame: probeState.inGame, phase: probeState.lastPhase };
}

/* ── 对外状态 ─────────────────────────────────────────────── */

export function getProbeStatus() {
  return {
    inGame: probeState.inGame,
    gameMode: probeState.gameMode,
    gameflowPhase: probeState.lastPhase,
    eventsSeen: probeState.eventsSeen,
    logFile: currentLogFile(),
  };
}

/* ── 启动 ─────────────────────────────────────────────────── */

export function startApiProbe(deps: ProbeDeps) {
  probeLog('▶ API 探针已启动（记录 gameflow 阶段 + 游戏事件流到日志文件）');
  probeLog(`  日志目录: ${LOGS_DIR}`);
  probeLog('  海克斯界面打开时请访问: /probe/mark?label=augment');
  setInterval(() => {
    pollGameflow(deps);
    pollLiveClient();
  }, POLL_INTERVAL_MS);
}
