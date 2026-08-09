/**
 * knowledge-server — 知识库后端服务
 *
 * 提供英雄/装备/海克斯素材及知识库数据查询。
 * 本阶段运行在本地 (127.0.0.1:4000)，未来部署到公网。
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.KB_PORT || '4000', 10);

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const DATA_DIR = path.resolve(__dirname, '..', 'data');

// ── 日志 ──────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

// ── JSON 文件读取 ─────────────────────────────────────────

function readJsonFile(filePath: string): object | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readVersionFile(): { version: string; updatedAt?: string } | null {
  try {
    const raw = fs.readFileSync(path.join(ASSETS_DIR, '.version'), 'utf-8').trim();
    return { version: raw };
  } catch {
    return null;
  }
}

// ── Express 应用 ──────────────────────────────────────────

const app = express();

// CORS 中间件
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  // 请求日志
  const start = Date.now();
  res.on('finish', () => {
    log(`${_req.method} ${_req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ── 静态文件：图标 ────────────────────────────────────────

app.use('/assets/icons/champions', express.static(path.join(ASSETS_DIR, 'champions'), {
  maxAge: '7d',
  etag: true,
  fallthrough: true,
}));

app.use('/assets/icons/items', express.static(path.join(ASSETS_DIR, 'items'), {
  maxAge: '7d',
  etag: true,
  fallthrough: true,
}));

app.use('/assets/icons/augments', express.static(path.join(ASSETS_DIR, 'augments'), {
  maxAge: '7d',
  etag: true,
  fallthrough: true,
}));

// ── 素材元数据端点 ────────────────────────────────────────

function sendJsonFile(res: express.Response, filePath: string, label: string) {
  const data = readJsonFile(filePath);
  if (data) {
    res.json(data);
  } else {
    res.status(503).json({ error: `${label} 数据未加载，请先运行 fetch-assets` });
  }
}

app.get('/assets/champions', (_req, res) => {
  sendJsonFile(res, path.join(ASSETS_DIR, 'champions.json'), '英雄');
});

app.get('/assets/items', (_req, res) => {
  sendJsonFile(res, path.join(ASSETS_DIR, 'items.json'), '装备');
});

app.get('/assets/augments', (_req, res) => {
  sendJsonFile(res, path.join(ASSETS_DIR, 'augments.json'), '海克斯强化');
});

// ── 知识库数据端点 ────────────────────────────────────────

app.get('/kb/tier-list', (_req, res) => {
  sendJsonFile(res, path.join(DATA_DIR, 'tier-list.json'), '英雄梯度表');
});

app.get('/kb/augment-scores', (_req, res) => {
  sendJsonFile(res, path.join(DATA_DIR, 'augment-scores.json'), '海克斯评分表');
});

app.get('/kb/build-rules', (_req, res) => {
  sendJsonFile(res, path.join(DATA_DIR, 'build-rules.json'), '出装规则表');
});

app.get('/kb/combos', (_req, res) => {
  sendJsonFile(res, path.join(DATA_DIR, 'combos.json'), '组合搭配表');
});

// ── 版本信息 ──────────────────────────────────────────────

app.get('/kb/version', (_req, res) => {
  const assetVersion = readVersionFile();
  const pkg = readJsonFile(path.resolve(__dirname, '..', 'package.json')) as { version?: string } | null;
  res.json({
    version: pkg?.version || '0.1.0',
    assetVersion: assetVersion?.version || null,
    updatedAt: assetVersion ? new Date().toISOString() : null,
  });
});

// ── 健康检查 ──────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const assetVersion = readVersionFile();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    assetVersion: assetVersion?.version || null,
  });
});

// ── 404 ───────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── 启动 ──────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  log('═══════════════════════════════════════════');
  log('  海克斯知识库服务 v0.1.0');
  log(`  端口: ${PORT}`);
  log(`  素材目录: ${ASSETS_DIR}`);
  log('═══════════════════════════════════════════');
});
