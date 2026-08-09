/**
 * 海克斯大乱斗助手 — 本地桥接服务
 *
 * 职责：
 * 1. 自动探测 LOL 国服客户端 LCU API（lockfile + 进程命令行兜底）
 * 2. 启动 HTTP 服务，把 LCU API 数据转发给网页前端
 * 3. 处理 CORS（含 Private-Network 预检），为后续公网部署做准备
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { watch as chokidarWatch } from 'chokidar';
import { startApiProbe, takeSnapshot, getProbeStatus } from './apiProbe.js';

/* ── 配置 ─────────────────────────────────────────────────── */

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '3517', 10);
const POLL_INTERVAL_MS = 3000;

/**
 * 国服 lockfile 候选路径（按常用程度排序）
 *
 * lockfile 由 LeagueClientUx.exe 在其工作目录下创建，
 * 文件名固定为 "lockfile"，格式: LeagueClient:<pid>:<port>:<password>:<protocol>
 */
/**
 * 探测系统上存在的盘符（Windows）
 */
function detectAvailableDrives(): string[] {
  const drives: string[] = [];
  for (const letter of ['C', 'D', 'E', 'F', 'G']) {
    if (fs.existsSync(`${letter}:\\`)) {
      drives.push(letter);
    }
  }
  return drives.length > 0 ? drives : ['C']; // fallback
}

const LOCKFILE_CANDIDATES: string[] = (() => {
  const candidates: string[] = [];

  // 1. 直接指定 lockfile 路径（最高优先级）
  if (process.env.LOL_LOCKFILE_PATH) {
    candidates.push(process.env.LOL_LOCKFILE_PATH);
  }

  // 2. 指定安装目录 → 拼接 lockfile
  if (process.env.LOL_INSTALL_PATH) {
    candidates.push(path.join(process.env.LOL_INSTALL_PATH, 'lockfile'));
  }

  // 3. 多盘符探测（国服 WeGame + 外服 Riot）
  const drives = detectAvailableDrives();
  const relativePaths = [
    // 外服（国际服）
    'Riot Games\\League of Legends\\lockfile',
    // WeGame 根目录
    'WeGameApps\\英雄联盟\\LeagueClient\\lockfile',
    'WeGameApps\\英雄联盟\\TCLS\\lockfile',
    // WeGame 在 Program Files 下
    'Program Files\\WeGameApps\\英雄联盟\\LeagueClient\\lockfile',
    'Program Files\\Tencent\\WeGameApps\\英雄联盟\\lockfile',
    'Program Files\\Tencent\\WeGameApps\\英雄联盟\\LeagueClient\\lockfile',
    'Program Files\\Tencent\\WeGameApps\\英雄联盟\\TCLS\\lockfile',
    // WeGame 在 Program Files (x86) 下
    'Program Files (x86)\\WeGameApps\\英雄联盟\\LeagueClient\\lockfile',
    'Program Files (x86)\\Tencent\\WeGameApps\\英雄联盟\\lockfile',
  ];

  for (const drive of drives) {
    for (const rel of relativePaths) {
      candidates.push(`${drive}:\\${rel}`);
    }
  }

  // 4. 通过进程名反查安装目录（运行时动态追加，见 detectByProcessPath）
  return candidates;
})();

/* ── 全局状态 ─────────────────────────────────────────────── */

interface LcuState {
  port: number | null;
  password: string | null;
  connected: boolean;
  /** lockfile 实际路径（连接成功时记录） */
  lockfilePath?: string;
}

const state: LcuState = {
  port: null,
  password: null,
  connected: false,
};

/** 最近一次探测的诊断信息 */
let lastDetectionDiag: {
  time: string;
  checkedPaths: { path: string; exists: boolean; valid: boolean }[];
  processDetected: boolean;
  processPort: number | null;
} = { time: '', checkedPaths: [], processDetected: false, processPort: null };

/** 日志工具 */
function log(msg: string) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

/* ── Lockfile 解析 ────────────────────────────────────────── */

/**
 * lockfile 格式: `LeagueClient:<pid>:<port>:<password>:<protocol>`
 */
function parseLockfile(content: string): { port: number; password: string } | null {
  const trimmed = content.trim();
  const parts = trimmed.split(':');
  if (parts.length < 5 || parts[0] !== 'LeagueClient') {
    return null;
  }
  const port = parseInt(parts[2], 10);
  const password = parts[3];
  if (isNaN(port) || !password) {
    return null;
  }
  return { port, password };
}

/** 已警告过的「路径 → 内容」，避免同一异常 lockfile 每轮刷屏 */
const warnedLockfiles = new Map<string, string>();

function tryReadLockfile(filePath: string): { port: number; password: string } | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    // 空文件属正常情况（客户端退出后的残留、或刚创建尚未写入），静默跳过
    if (!content.trim()) return null;
    const parsed = parseLockfile(content);
    if (parsed) {
      warnedLockfiles.delete(filePath);
      log(`✓ lockfile 有效: ${filePath} → 端口 ${parsed.port}`);
      return parsed;
    }
    // 同样的异常内容只警告一次
    if (warnedLockfiles.get(filePath) !== content) {
      warnedLockfiles.set(filePath, content);
      log(`⚠ lockfile 格式异常: ${filePath} → "${content.slice(0, 80)}"`);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 通过命令行查询 LeagueClientUx 进程 → 反查安装目录 → 读取其目录下的 lockfile
 */
function detectByProcessPath(): { port: number; password: string; lockfilePath: string } | null {
  try {
    // 方法 A: PowerShell + Get-CimInstance（Win10+ / Win11）
    let output = '';
    try {
      output = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='LeagueClientUx.exe'\\" | Select-Object -ExpandProperty CommandLine"`,
        { encoding: 'utf-8', timeout: 5000, windowsHide: true },
      ).trim();
    } catch {
      // PowerShell 不可用时尝试 WMIC
      try {
        output = execSync(
          `wmic process where "name='LeagueClientUx.exe'" get CommandLine /format:list`,
          { encoding: 'utf-8', timeout: 5000, windowsHide: true },
        ).trim();
      } catch {
        // 都不行
      }
    }

    if (!output) return null;

    // 从命令行提取 LCU 参数
    const portMatch = output.match(/--app-port=(\d+)/);
    const tokenMatch = output.match(/--remoting-auth-token=(\S+)/);

    if (portMatch && tokenMatch) {
      const port = parseInt(portMatch[1], 10);
      const password = tokenMatch[1];

      // 尝试从进程路径反推 lockfile 位置
      // LeagueClientUx.exe 通常位于 .../LeagueClient/ 目录下
      const exeMatch = output.match(/^"?([A-Z]:\\[^"]*?LeagueClientUx\.exe)"?/im);
      let lockfilePath = '';
      if (exeMatch) {
        lockfilePath = path.join(path.dirname(exeMatch[1]), 'lockfile');
      }

      return { port, password, lockfilePath };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 探测 LCU 凭据（lockfile 优先 → 进程命令行兜底）
 */
function detectLcuCredentials(): { port: number; password: string; lockfilePath?: string } | null {
  const checkedPaths: { path: string; exists: boolean; valid: boolean }[] = [];

  for (const candidate of LOCKFILE_CANDIDATES) {
    const exists = fs.existsSync(candidate);
    let valid = false;
    if (exists) {
      const result = tryReadLockfile(candidate);
      if (result) {
        lastDetectionDiag = {
          time: new Date().toISOString(),
          checkedPaths,
          processDetected: false,
          processPort: null,
        };
        return { ...result, lockfilePath: candidate };
      }
      valid = false;
    }
    checkedPaths.push({ path: candidate, exists, valid });
  }

  // 兜底：进程命令行
  const procResult = detectByProcessPath();
  lastDetectionDiag = {
    time: new Date().toISOString(),
    checkedPaths,
    processDetected: procResult !== null,
    processPort: procResult?.port || null,
  };

  if (procResult) {
    log(`✓ 从进程命令行获取凭据: 端口 ${procResult.port}`);
    if (procResult.lockfilePath && !LOCKFILE_CANDIDATES.includes(procResult.lockfilePath)) {
      LOCKFILE_CANDIDATES.push(procResult.lockfilePath);
    }
    return { port: procResult.port, password: procResult.password };
  }

  return null;
}

/**
 * 兜底：解析最新的 LeagueClientUx 日志提取启动参数。
 * 国服客户端以管理员权限运行时，WMI/CIM 读不到进程命令行，
 * 且部分版本不写 lockfile，但 Ux 日志第一行包含完整启动参数。
 */
function detectByUxLog(): { port: number; password: string } | null {
  const logDirs = new Set(LOCKFILE_CANDIDATES.map((p) => path.dirname(p)));

  for (const dir of logDirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('_LeagueClientUx.log'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    // 按修改时间取最新的一份（当前运行会话的日志会持续追加，mtime 最新）
    files.sort((a, b) => {
      try {
        return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs;
      } catch {
        return 0;
      }
    });

    // 启动参数在日志开头，只读前 64KB
    let head: string;
    try {
      const fd = fs.openSync(path.join(dir, files[0]), 'r');
      const buf = Buffer.alloc(64 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf-8', 0, bytesRead);
    } catch {
      continue;
    }

    const portMatch = head.match(/--app-port=(\d+)/);
    const tokenMatch = head.match(/--remoting-auth-token=(\S+)/);
    if (portMatch && tokenMatch) {
      return { port: parseInt(portMatch[1], 10), password: tokenMatch[1] };
    }
  }
  return null;
}

/**
 * 探测指定凭据对应的 LCU 是否真实存活（日志可能是历史会话残留的）
 */
function probeLcu(port: number, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const auth = Buffer.from(`riot:${password}`).toString('base64');
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/lol-gameflow/v1/session',
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
        rejectUnauthorized: false,
        timeout: 3000,
      },
      (res) => {
        res.resume();
        // 401 = 凭据错误（历史日志）；其余状态均说明 LCU 存活且凭据有效
        resolve(res.statusCode !== 401);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** 日志兜底探测互斥锁，避免上一轮探测未结束时重复发起 */
let uxLogProbing = false;

/**
 * lockfile / 进程命令行都失败时，尝试从 Ux 日志提取凭据并验证
 */
async function tryUxLogFallback() {
  if (state.connected || uxLogProbing) return;
  uxLogProbing = true;
  try {
    const creds = detectByUxLog();
    if (creds && (await probeLcu(creds.port, creds.password))) {
      log(`✓ 从客户端日志获取凭据: 端口 ${creds.port}`);
      updateLcuState(creds);
    }
  } finally {
    uxLogProbing = false;
  }
}

/* ── 状态管理 ─────────────────────────────────────────────── */

function updateLcuState(creds: { port: number; password: string; lockfilePath?: string } | null) {
  if (creds) {
    const isNew = state.port !== creds.port || !state.connected;
    state.port = creds.port;
    state.password = creds.password;
    state.connected = true;
    if (creds.lockfilePath) {
      state.lockfilePath = creds.lockfilePath;
    }
    if (isNew) {
      log(`🔗 LCU 已连接 → https://127.0.0.1:${state.port}`);
    }
  } else {
    if (state.connected) {
      log('🔌 LCU 已断开');
    }
    state.connected = false;
  }
}

/* ── LCU 健康检查 ─────────────────────────────────────────── */

async function checkLcuAlive(): Promise<boolean> {
  if (!state.port || !state.password) return false;
  try {
    await lcuRequest('GET', '/lol-summoner/v1/current-summoner');
    return true;
  } catch {
    return false;
  }
}

/* ── LCU 请求 ─────────────────────────────────────────────── */

function lcuRequest(method: string, endpoint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!state.port || !state.password) {
      return reject(new Error('LCU 未连接'));
    }

    const auth = Buffer.from(`riot:${state.password}`).toString('base64');
    const options: https.RequestOptions = {
      hostname: '127.0.0.1',
      port: state.port,
      path: endpoint,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      rejectUnauthorized: false,
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve(body));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LCU 请求超时'));
    });

    req.end();
  });
}

/* ── HTTP 服务器 ──────────────────────────────────────────── */

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${BRIDGE_PORT}`);

  try {
    // GET /status
    if (url.pathname === '/status') {
      let gameflowPhase: string | undefined;
      let summonerName: string | undefined;

      if (state.connected) {
        try {
          const phaseData = await lcuRequest('GET', '/lol-gameflow/v1/session');
          const phaseJson = JSON.parse(phaseData);
          gameflowPhase = phaseJson.phase || undefined;
        } catch {
          // LCU may not respond — that's ok
        }

        if (gameflowPhase) {
          try {
            const summonerData = await lcuRequest('GET', '/lol-summoner/v1/current-summoner');
            const summonerJson = JSON.parse(summonerData);
            summonerName = summonerJson.displayName || undefined;
          } catch {
            // optional
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connected: state.connected,
        port: state.connected ? state.port : undefined,
        summonerName,
        gameflowPhase,
      }));
      return;
    }

    // GET /debug
    if (url.pathname === '/debug') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connected: state.connected,
        port: state.port,
        lockfilePath: state.lockfilePath || null,
        lastDetection: lastDetectionDiag,
        probe: getProbeStatus(),
      }, null, 2));
      return;
    }

    // GET /probe/status — API 探针状态（是否在游戏内、已记录事件数、日志路径）
    if (url.pathname === '/probe/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getProbeStatus(), null, 2));
      return;
    }

    // GET /probe/mark?label=xxx — 海克斯界面打开时抓取全端点快照
    if (url.pathname === '/probe/mark') {
      const label = url.searchParams.get('label') || 'mark';
      const result = await takeSnapshot(label, {
        lcuRequest,
        isLcuConnected: () => state.connected,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // GET /proxy?endpoint=<path>
    if (url.pathname === '/proxy') {
      const endpoint = url.searchParams.get('endpoint');
      if (!endpoint) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing endpoint parameter' }));
        return;
      }

      if (!state.connected) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'LCU client not connected' }));
        return;
      }

      try {
        const body = await lcuRequest('GET', endpoint);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch (err) {
        log(`❌ 转发失败: ${endpoint} — ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'LCU request failed', detail: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    log(`❌ 请求处理异常: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

/* ── 启动 ─────────────────────────────────────────────────── */

function startHttpServer() {
  const server = http.createServer(handleRequest);
  server.listen(BRIDGE_PORT, '0.0.0.0', () => {
    log(`🚀 桥接服务已启动 → http://0.0.0.0:${BRIDGE_PORT}`);
  });
  server.on('error', (err) => {
    log(`❌ HTTP 服务启动失败: ${err.message}`);
    process.exit(1);
  });
}

function startLcuDetection() {
  // 1. 立即探测一次
  log(`🔍 探测 LCU 客户端 (${LOCKFILE_CANDIDATES.length} 个候选路径)...`);
  const creds = detectLcuCredentials();
  updateLcuState(creds);

  if (!creds) {
    log('⚠ 未检测到 LCU 客户端。请确保 LOL 已启动并登录，');
    log('   或设置环境变量 LOL_LOCKFILE_PATH / LOL_INSTALL_PATH');
  }

  // 2. 文件监听（lockfile 变化时快速感知）
  const watchedDirs = new Set<string>();
  const activeWatches: string[] = [];
  for (const candidate of LOCKFILE_CANDIDATES) {
    const dir = path.dirname(candidate);
    if (!watchedDirs.has(dir)) {
      watchedDirs.add(dir);
      if (fs.existsSync(dir)) {
        const watcher = chokidarWatch(dir, {
          depth: 0,
          ignoreInitial: true,
        });
        watcher.on('add', (filePath: string) => {
          if (path.basename(filePath) === 'lockfile') {
            log(`📁 检测到 lockfile: ${filePath}`);
            const result = tryReadLockfile(filePath);
            if (result) updateLcuState({ ...result, lockfilePath: filePath });
          }
        });
        watcher.on('change', (filePath: string) => {
          if (path.basename(filePath) === 'lockfile') {
            const result = tryReadLockfile(filePath);
            if (result) updateLcuState({ ...result, lockfilePath: filePath });
          }
        });
        watcher.on('unlink', (filePath: string) => {
          if (path.basename(filePath) === 'lockfile') {
            const remaining = detectLcuCredentials();
            updateLcuState(remaining);
          }
        });
        activeWatches.push(dir);
      }
    }
  }
  if (activeWatches.length > 0) {
    log(`👁 监听 ${activeWatches.length} 个目录`);
  }

  // 3. 轮询兜底（每 3 秒）
  setInterval(() => {
    const creds = detectLcuCredentials();
    if (creds) {
      updateLcuState(creds);
    } else if (!state.connected) {
      // lockfile / 进程命令行都失败时的最后兜底（国服提权运行场景）
      tryUxLogFallback();
    }
    // creds 为 null 但当前已连接时不主动断开（可能凭据来自日志兜底），
    // 是否真断开交给下面的健康检查判断

    if (state.connected) {
      checkLcuAlive().then((alive) => {
        if (!alive && state.connected) {
          log('🔌 LCU 健康检查失败，标记为断开');
          state.connected = false;
        }
      });
    }
  }, POLL_INTERVAL_MS);
}

/* ── 入口 ─────────────────────────────────────────────────── */

log('═══════════════════════════════════════════');
log('  海克斯大乱斗助手 — 本地桥接服务 v0.1.0');
log('═══════════════════════════════════════════');
log(`  桥接端口: ${BRIDGE_PORT}`);
log(`  轮询间隔: ${POLL_INTERVAL_MS}ms`);
log('');

startHttpServer();
startLcuDetection();
startApiProbe({
  lcuRequest,
  isLcuConnected: () => state.connected,
});
