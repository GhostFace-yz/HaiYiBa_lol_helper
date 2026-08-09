/**
 * fetch-assets.ts — 素材获取管道
 *
 * 从 Data Dragon 拉取英雄/装备图标和元数据，
 * 从 Community Dragon 拉取海克斯强化图标和元数据。
 *
 * 用法: npx tsx scripts/fetch-assets.ts
 * 写入目标: knowledge-server/assets/
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 路径解析 ──────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'knowledge-server', 'assets');
const VERSION_FILE = path.join(ASSETS_DIR, '.version');

const CHAMPIONS_DIR = path.join(ASSETS_DIR, 'champions');
const ITEMS_DIR = path.join(ASSETS_DIR, 'items');
const AUGMENTS_DIR = path.join(ASSETS_DIR, 'augments');
const CHAMPIONS_JSON = path.join(ASSETS_DIR, 'champions.json');
const ITEMS_JSON = path.join(ASSETS_DIR, 'items.json');
const AUGMENTS_JSON = path.join(ASSETS_DIR, 'augments.json');

const DD_BASE = 'https://ddragon.leagueoflegends.com';
const CD_BASE = 'https://raw.communitydragon.org';

// ── 工具函数 ──────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** HTTP GET 请求，返回原始文本 */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      // 处理重定向
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          return httpGet(redirectUrl).then(resolve).catch(reject);
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/** 下载二进制文件到磁盘 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(destPath);
          return downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
        }
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    }).on('error', (err) => {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

/** 带重试的 HTTP GET */
async function httpGetRetry(url: string, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      return await httpGet(url);
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
      log(`  ⚠ 重试 (${i + 1}/${retries}) ${url} — ${(err as Error).message}`);
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}

/** 带重试的下载 */
async function downloadRetry(url: string, dest: string, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await downloadFile(url, dest);
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = Math.pow(2, i) * 1000;
      log(`  ⚠ 下载重试 (${i + 1}/${retries}) ${path.basename(dest)} — ${(err as Error).message}`);
      await sleep(delay);
    }
  }
}

/** 批量下载，显示进度 */
async function downloadBatch(
  items: { id: string; url: string; filename: string }[],
  destDir: string,
  label: string,
) {
  let done = 0;
  const total = items.length;
  const errors: string[] = [];

  // 并发下载（最多 8 个并发）
  const CONCURRENCY = 8;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (item) => {
        const destPath = path.join(destDir, item.filename);
        // 已存在则跳过
        if (fs.existsSync(destPath)) {
          done++;
          return;
        }
        try {
          await downloadRetry(item.url, destPath, 2);
          done++;
          if (done % 20 === 0 || done === total) {
            log(`  ${label}: ${done}/${total}`);
          }
        } catch (err) {
          errors.push(`${item.id}: ${(err as Error).message}`);
          done++;
        }
      }),
    );
  }

  if (errors.length > 0) {
    log(`  ⚠ ${label} 下载失败 ${errors.length} 个: ${errors.slice(0, 5).join(', ')}${errors.length > 5 ? '...' : ''}`);
  }
}

// ── Data Dragon 数据获取 ──────────────────────────────────

interface ChampionMeta {
  id: string;
  name: string;
  key: string;
  icon: string;
}

interface ItemMeta {
  id: string;
  name: string;
  icon: string;
}

interface AugmentMeta {
  id: string;
  name: string;
  description: string;
  icon: string;
}

async function fetchChampions(version: string): Promise<ChampionMeta[]> {
  log('📥 获取英雄数据...');
  const url = `${DD_BASE}/cdn/${version}/data/zh_CN/champion.json`;
  const raw = await httpGetRetry(url);
  const data = JSON.parse(raw).data as Record<string, { id: string; name: string; key: string }>;

  const champions: ChampionMeta[] = [];
  const downloads: { id: string; url: string; filename: string }[] = [];

  for (const [champId, champ] of Object.entries(data)) {
    champions.push({
      id: champId,
      name: champ.name,
      key: champ.key,
      icon: `champions/${champId}.png`,
    });
    downloads.push({
      id: champId,
      url: `${DD_BASE}/cdn/${version}/img/champion/${champId}.png`,
      filename: `${champId}.png`,
    });
  }

  log(`  共 ${champions.length} 个英雄`);
  await downloadBatch(downloads, CHAMPIONS_DIR, '英雄图标');
  return champions;
}

async function fetchItems(version: string): Promise<ItemMeta[]> {
  log('📥 获取装备数据...');
  const url = `${DD_BASE}/cdn/${version}/data/zh_CN/item.json`;
  const raw = await httpGetRetry(url);
  const data = JSON.parse(raw).data as Record<string, { name: string }>;

  const items: ItemMeta[] = [];
  const downloads: { id: string; url: string; filename: string }[] = [];

  for (const [itemId, item] of Object.entries(data)) {
    items.push({
      id: itemId,
      name: item.name,
      icon: `items/${itemId}.png`,
    });
    downloads.push({
      id: itemId,
      url: `${DD_BASE}/cdn/${version}/img/item/${itemId}.png`,
      filename: `${itemId}.png`,
    });
  }

  log(`  共 ${items.length} 件装备`);
  await downloadBatch(downloads, ITEMS_DIR, '装备图标');
  return items;
}

// ── Community Dragon 数据获取 ──────────────────────────────

interface CdragonAugment {
  id: string | number;
  name: string;
  description: string;
  iconPath?: string;
  /** arena JSON 实际提供的图标字段（优先用大图，模板匹配更清晰） */
  iconLarge?: string;
  iconSmall?: string;
}

async function fetchAugments(): Promise<AugmentMeta[]> {
  log('📥 获取海克斯强化数据 (Community Dragon)...');
  const url = `${CD_BASE}/latest/cdragon/arena/zh_cn.json`;
  const raw = await httpGetRetry(url);
  const data = JSON.parse(raw);

  // CDragon arena JSON 的结构可能因版本而异，尝试多种路径
  const augmentsRaw: CdragonAugment[] =
    Array.isArray(data) ? data
    : data.augments || data.stats || data.data || [];

  if (!Array.isArray(augmentsRaw) || augmentsRaw.length === 0) {
    log('  ⚠ 未找到海克斯强化数据，检查 CDragon JSON 结构');
    log(`  顶层 keys: ${Object.keys(data).join(', ')}`);
    return [];
  }

  const augments: AugmentMeta[] = [];
  const downloads: { id: string; url: string; filename: string }[] = [];

  for (const aug of augmentsRaw) {
    const id = String(aug.id || aug.name);
    const name = aug.name || `Augment ${id}`;
    const description = aug.description || '';

    // 从 CDragon 数据中提取图标路径（arena JSON 实际字段为 iconLarge / iconSmall）
    const iconPath = aug.iconPath || aug.iconLarge || aug.iconSmall || '';
    let iconFilename = `${id}.png`;
    let iconUrl = '';

    if (iconPath) {
      // iconPath 形如 "assets/ux/cherry/augments/icons/xxx_large.png"
      // CDragon raw CDN 路径需保留 assets/ 前缀，整体小写
      iconUrl = `${CD_BASE}/latest/game/${iconPath.toLowerCase()}`;
      // 保留原始文件名
      const ext = path.extname(iconPath) || '.png';
      iconFilename = `${id}${ext}`;
    }

    augments.push({
      id,
      name,
      description,
      icon: `augments/${iconFilename}`,
    });

    if (iconUrl) {
      downloads.push({ id, url: iconUrl, filename: iconFilename });
    }
  }

  log(`  共 ${augments.length} 个海克斯强化`);
  if (downloads.length > 0) {
    await downloadBatch(downloads, AUGMENTS_DIR, '海克斯图标');
  } else {
    log('  ⚠ 没有可下载的图标 URL');
  }
  return augments;
}

// ── 主流程 ─────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════');
  log('  海克斯大乱斗助手 — 素材获取管道');
  log('═══════════════════════════════════════════');
  log('');

  // 确保目标目录存在
  for (const d of [CHAMPIONS_DIR, ITEMS_DIR, AUGMENTS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // 1. 获取 Data Dragon 最新版本
  log('🔍 检查 Data Dragon 版本...');
  const versionsRaw = await httpGetRetry(`${DD_BASE}/api/versions.json`);
  const versions = JSON.parse(versionsRaw) as string[];
  const latestVersion = versions[0];
  log(`  最新版本: ${latestVersion}`);

  // 2. 版本变化检测
  let cachedVersion = '';
  try {
    cachedVersion = fs.readFileSync(VERSION_FILE, 'utf-8').trim();
  } catch {
    // 首次运行
  }

  if (cachedVersion === latestVersion) {
    // 版本相同但海克斯图标缺失（如下载失败过）时仍需补全
    let augmentIconCount = 0;
    try {
      augmentIconCount = fs.readdirSync(AUGMENTS_DIR).filter((f) => f.endsWith('.png')).length;
    } catch {
      // 目录不存在按 0 处理
    }
    if (augmentIconCount > 0) {
      log('✓ 素材已是最新版本，跳过下载');
      return;
    }
    log('  ⚠ 版本未变但海克斯图标缺失，重新补全');
  }

  if (cachedVersion) {
    log(`  版本变更: ${cachedVersion} → ${latestVersion}`);
  }

  // 3. 获取英雄数据
  log('');
  const champions = await fetchChampions(latestVersion);
  fs.writeFileSync(CHAMPIONS_JSON, JSON.stringify(champions, null, 2), 'utf-8');
  log('  ✓ champions.json 已保存');

  // 4. 获取装备数据
  log('');
  const items = await fetchItems(latestVersion);
  fs.writeFileSync(ITEMS_JSON, JSON.stringify(items, null, 2), 'utf-8');
  log('  ✓ items.json 已保存');

  // 5. 获取海克斯强化数据
  log('');
  const augments = await fetchAugments();
  fs.writeFileSync(AUGMENTS_JSON, JSON.stringify(augments, null, 2), 'utf-8');
  log('  ✓ augments.json 已保存');

  // 6. 写入版本标记
  fs.writeFileSync(VERSION_FILE, latestVersion, 'utf-8');

  log('');
  log('═══════════════════════════════════════════');
  log(`  ✓ 素材获取完成`);
  log(`    英雄: ${champions.length} | 装备: ${items.length} | 海克斯: ${augments.length}`);
  log(`    版本: ${latestVersion}`);
  log('═══════════════════════════════════════════');
}

main().catch((err) => {
  log(`❌ 素材获取失败: ${err.message}`);
  process.exit(1);
});
