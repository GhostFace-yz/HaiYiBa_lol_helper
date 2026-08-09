import { useState, useEffect, useRef, useCallback } from 'react';
import type { AugmentMatch } from './AugmentOverlay';

interface AugmentIconMeta {
  id: string;
  icon: string;
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  index: number;
}

// 参考分辨率 1920×1080 下的三个海克斯强化槽位（可调整）
const REFERENCE_REGIONS: Omit<Region, 'index'>[] = [
  { x: 660, y: 580, w: 180, h: 180 },
  { x: 870, y: 580, w: 180, h: 180 },
  { x: 1080, y: 580, w: 180, h: 180 },
];

const DETECT_INTERVAL_MS = 500;
const DEFAULT_THRESHOLD = 0.7;

/**
 * useAugmentDetection — 海克斯强化识别 Hook
 *
 * 流程:
 * 1. 挂载时从 /assets/augments 获取图标列表
 * 2. 创建 Web Worker，发送 init（含图标 URL 列表）
 * 3. 检测激活时，每 500ms 截取视频帧，裁剪三个区域，发送给 Worker 匹配
 * 4. 返回匹配结果供 AugmentOverlay 渲染
 *
 * @param videoRef - 视频元素 ref
 * @param isActive - 是否激活检测（通常是选人阶段）
 * @param threshold - 匹配置信度阈值 (0–1)
 */
export function useAugmentDetection(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  isActive: boolean,
  threshold = DEFAULT_THRESHOLD,
) {
  const [matches, setMatches] = useState<AugmentMatch[]>([]);
  const [workerReady, setWorkerReady] = useState(false);
  const [iconCount, setIconCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const mountedRef = useRef(true);

  // 初始化 Worker
  const initWorker = useCallback(async () => {
    try {
      // 1. 获取海克斯图标元数据
      const res = await fetch('/assets/augments');
      if (!res.ok) throw new Error(`获取海克斯列表失败: ${res.status}`);
      const icons = (await res.json()) as AugmentIconMeta[];
      if (!Array.isArray(icons) || icons.length === 0) {
        setError('暂无海克斯图标数据，请先运行 fetch-assets');
        return;
      }

      // 2. 创建 Worker
      const worker = new Worker(
        new URL('./AugmentWorker/worker.ts', import.meta.url),
        { type: 'module' },
      );
      workerRef.current = worker;

      // 3. 监听 Worker 消息
      worker.onmessage = (e: MessageEvent) => {
        if (!mountedRef.current) return;
        const msg = e.data;
        if (msg.type === 'ready') {
          setWorkerReady(true);
          setIconCount(msg.count);
          setError(null);
        } else if (msg.type === 'result') {
          setMatches(msg.matches);
        }
      };

      worker.onerror = (e) => {
        console.error('[AugmentDetection] Worker error:', e);
        if (mountedRef.current) {
          setError(`Worker 错误: ${e.message}`);
        }
      };

      // 4. 构建图标 URL 列表并发送 init
      const augmentIcons = icons.map((icon) => ({
        id: icon.id,
        iconUrl: `/assets/icons/augments/${icon.icon}`,
      }));

      worker.postMessage({ type: 'init', augmentIcons });
    } catch (err) {
      if (mountedRef.current) {
        setError(`初始化失败: ${(err as Error).message}`);
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

    const detect = () => {
      const worker = workerRef.current;
      const video = videoRef.current;
      if (!worker || !video || video.readyState < 2) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      try {
        // 将视频帧绘制到 offscreen canvas
        const canvas = document.createElement('canvas');
        canvas.width = vw;
        canvas.height = vh;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(video, 0, 0, vw, vh);
        const imageData = ctx.getImageData(0, 0, vw, vh);

        // 将参考坐标缩放至实际分辨率
        const scaleX = vw / 1920;
        const scaleY = vh / 1080;
        const regions: Region[] = REFERENCE_REGIONS.map((r, i) => ({
          x: Math.round(r.x * scaleX),
          y: Math.round(r.y * scaleY),
          w: Math.round(r.w * scaleX),
          h: Math.round(r.h * scaleY),
          index: i,
        }));

        worker.postMessage({ type: 'detect', imageData, regions, threshold });
      } catch {
        // 帧读取失败，跳过
      }
    };

    // 执行首次检测，然后定期检测
    detect();
    intervalRef.current = setInterval(detect, DETECT_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = 0;
      }
    };
  }, [isActive, workerReady, videoRef, threshold]);

  // 清理 Worker
  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  return { matches, workerReady, iconCount, error };
}
