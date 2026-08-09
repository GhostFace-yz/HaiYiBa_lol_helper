import { useState, useEffect, useRef, useCallback } from 'react';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import type { AugmentMatch } from './AugmentOverlay';

export interface RegionDebug {
  regionIndex: number;
  bestId: string | null;
  bestConfidence: number;
  x: number;
  y: number;
}

interface AugmentMeta {
  id: string;
  name: string;
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  index: number;
}

// 参考分辨率 1920×1080 下的三个海克斯卡牌区域（可调整）
export const REFERENCE_REGIONS: Omit<Region, 'index'>[] = [
  { x: 450, y: 210, w: 330, h: 520 },
  { x: 820, y: 210, w: 330, h: 520 },
  { x: 1180, y: 210, w: 330, h: 520 },
];

const DETECT_INTERVAL_MS = 800;
const DEFAULT_THRESHOLD = 0.7;

// 二值化阈值：卡牌文字为亮色（白/金），背景深色，亮像素 → 黑字，其余 → 白底
const BINARIZE_THRESHOLD = 150;

// 标题条在卡牌区域内的相对位置（可调整）：OCR 只识别这一条，避免描述文字稀释匹配
export const TITLE_STRIP = { x: 0.1, y: .42, w: .8, h: 0.06 };

// 标题条放大倍数：小字号放大后 OCR 更准
const UPSCALE = 2;

/**
 * 名称覆盖率：名称的字符在 OCR 文本中出现的比例 (0–1)。
 * OCR 文本中的多余内容（稀有度标签、噪点）不扣分；
 * OCR 错字/漏字按比例扣分。
 */
function nameCoverage(name: string, text: string): number {
  if (!name || !text) return 0;
  const pool = new Map<string, number>();
  for (const ch of text) pool.set(ch, (pool.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of name) {
    const n = pool.get(ch) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(ch, n - 1);
    }
  }
  return hit / name.length;
}

/** 归一化 OCR 文本：去除空白和标点，只保留文字/数字 */
function normalizeText(text: string): string {
  return text.replace(/[\s，。、；：！？·…—\-「」『』（）()【】《》<>"'.,;:!?/\\|[\]{}~@#$%^&*_+=`]/g, '');
}

/**
 * useAugmentDetection — 海克斯强化识别 Hook（OCR 方案）
 *
 * 流程:
 * 1. 挂载时从 /assets/augments 获取海克斯词库（id + 中文名）
 * 2. 初始化 tesseract.js（worker / core / 训练数据全部走本地 public/ 目录）
 * 3. 检测激活时，每 800ms 截取视频帧，定位三个卡牌区域
 * 4. 每个区域：只裁顶部标题条（TITLE_STRIP）→ 放大 → 二值化 → OCR
 * 5. OCR 文本与词库做名称覆盖率匹配，≥ threshold 的交给 AugmentOverlay 画整张卡牌框
 *
 * @param videoRef - 视频元素 ref
 * @param isActive - 是否激活检测
 * @param threshold - 名称相似度阈值 (0–1)
 */
export function useAugmentDetection(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  isActive: boolean,
  threshold = DEFAULT_THRESHOLD,
) {
  const [matches, setMatches] = useState<AugmentMatch[]>([]);
  const [debug, setDebug] = useState<RegionDebug[]>([]);
  const [workerReady, setWorkerReady] = useState(false);
  const [iconCount, setIconCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ocrRef = useRef<TesseractWorker | null>(null);
  const augmentNamesRef = useRef<AugmentMeta[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const pendingRef = useRef(false); // 上一轮识别未结束时跳过，防止堆积
  const mountedRef = useRef(true);

  // 初始化：词库 + OCR Worker
  const initWorker = useCallback(async () => {
    try {
      // 1. 获取海克斯词库（名称是 OCR 匹配的目标）
      const res = await fetch('/assets/augments');
      if (!res.ok) throw new Error(`获取海克斯列表失败: ${res.status}`);
      const augments = (await res.json()) as AugmentMeta[];
      if (!Array.isArray(augments) || augments.length === 0) {
        setError('暂无海克斯数据，请先运行 fetch-assets');
        return;
      }
      augmentNamesRef.current = augments;

      // 2. 初始化 tesseract.js（资源全部本地化，不走 CDN）
      const ocr = await createWorker('chi_sim', undefined, {
        workerPath: '/tesseract/worker.min.js',
        corePath: '/tesseract',
        langPath: '/tessdata',
        gzip: true,
      });
      ocrRef.current = ocr;

      if (mountedRef.current) {
        setWorkerReady(true);
        setIconCount(augments.length);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(`OCR 初始化失败: ${(err as Error).message}`);
      }
    }
  }, []);

  // 挂载时初始化
  useEffect(() => {
    mountedRef.current = true;
    initWorker();
    return () => {
      mountedRef.current = false;
    };
  }, [initWorker]);

  // 识别单个卡牌区域：裁剪 → 二值化 → OCR → 名称匹配
  const recognizeRegion = useCallback(
    async (
      frame: HTMLCanvasElement,
      region: Region,
    ): Promise<{ match: AugmentMatch | null; dbg: RegionDebug }> => {
      const ocr = ocrRef.current!;
      const names = augmentNamesRef.current;

      // 只裁卡牌内的标题条，并放大以提升小字号 OCR 精度
      const sx = Math.round(region.x + TITLE_STRIP.x * region.w);
      const sy = Math.round(region.y + TITLE_STRIP.y * region.h);
      const sw = Math.round(region.w * TITLE_STRIP.w);
      const sh = Math.round(region.h * TITLE_STRIP.h);

      const card = document.createElement('canvas');
      card.width = sw * UPSCALE;
      card.height = sh * UPSCALE;
      const ctx = card.getContext('2d');
      if (!ctx) {
        return { match: null, dbg: { regionIndex: region.index, bestId: null, bestConfidence: 0, x: region.x, y: region.y } };
      }
      ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, card.width, card.height);

      // 二值化：亮文字 → 黑，深色背景 → 白（tesseract 偏好黑字白底）
      const img = ctx.getImageData(0, 0, card.width, card.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = gray >= BINARIZE_THRESHOLD ? 0 : 255;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);

      // OCR
      const { data } = await ocr.recognize(card);
      const text = normalizeText(data.text);

      // 与词库做名称覆盖率匹配
      let best: { id: string; name: string; sim: number } | null = null;
      for (const aug of names) {
        const sim = nameCoverage(aug.name, text);
        if (!best || sim > best.sim) best = { id: aug.id, name: aug.name, sim };
      }

      const dbg: RegionDebug = {
        regionIndex: region.index,
        bestId: best?.id ?? null,
        bestConfidence: best ? Math.round(best.sim * 1000) / 1000 : 0,
        x: region.x,
        y: region.y,
      };

      if (best && best.sim >= threshold) {
        return {
          match: {
            augmentId: best.id,
            name: best.name,
            regionIndex: region.index,
            confidence: Math.round(best.sim * 1000) / 1000,
            x: region.x,
            y: region.y,
            w: region.w,
            h: region.h,
          },
          dbg,
        };
      }
      return { match: null, dbg };
    },
    [threshold],
  );

  // 检测循环
  useEffect(() => {
    if (!isActive || !workerReady) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = 0;
      }
      if (!isActive) setMatches([]);
      return;
    }

    const detect = async () => {
      const video = videoRef.current;
      if (!ocrRef.current || !video || video.readyState < 2) return;
      if (pendingRef.current) return; // 上一轮还在识别，跳过

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      pendingRef.current = true;
      try {
        // 整帧绘制一次，三个区域共用
        const frame = document.createElement('canvas');
        frame.width = vw;
        frame.height = vh;
        const ctx = frame.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, vw, vh);

        // 参考坐标 → 实际分辨率
        const scaleX = vw / 1920;
        const scaleY = vh / 1080;
        const regions: Region[] = REFERENCE_REGIONS.map((r, i) => ({
          x: Math.round(r.x * scaleX),
          y: Math.round(r.y * scaleY),
          w: Math.round(r.w * scaleX),
          h: Math.round(r.h * scaleY),
          index: i,
        }));

        // 三个区域依次识别（单 OCR worker，天然串行）
        const newMatches: AugmentMatch[] = [];
        const newDebug: RegionDebug[] = [];
        for (const region of regions) {
          if (!mountedRef.current) return;
          const { match, dbg } = await recognizeRegion(frame, region);
          if (match) newMatches.push(match);
          newDebug.push(dbg);
        }

        if (mountedRef.current) {
          setMatches(newMatches);
          setDebug(newDebug);
        }
      } catch {
        // 帧读取 / OCR 失败，跳过本轮
      } finally {
        pendingRef.current = false;
      }
    };

    detect();
    intervalRef.current = setInterval(detect, DETECT_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = 0;
      }
    };
  }, [isActive, workerReady, videoRef, recognizeRegion]);

  // 清理 OCR Worker
  useEffect(() => {
    return () => {
      if (ocrRef.current) {
        ocrRef.current.terminate();
        ocrRef.current = null;
      }
    };
  }, []);

  return { matches, debug, workerReady, iconCount, error };
}
