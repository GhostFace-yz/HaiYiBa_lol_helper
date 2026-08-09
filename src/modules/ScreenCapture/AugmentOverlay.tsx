import { useRef, useEffect, useCallback } from 'react';
import { REFERENCE_REGIONS, TITLE_STRIP } from './useAugmentDetection';

export interface AugmentMatch {
  augmentId: string;
  name?: string; // OCR 识别出的海克斯名称
  regionIndex: number;
  confidence: number;
  x: number; // 原始帧坐标
  y: number;
  w: number; // 匹配框尺寸（原始帧坐标）
  h: number;
}

interface AugmentOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  matches: AugmentMatch[];
  isActive: boolean;
}

/**
 * AugmentOverlay — Canvas 标注层
 *
 * 在视频元素上方叠加一个等大的 Canvas：
 * - 常显三个搜索区域的虚线框（青色），用于校准槽位坐标是否对准游戏内海克斯图标
 * - 命中时绘制匹配框：高置信度绿框 / 中置信度黄框 + 标签
 *
 * video 使用 object-contain，需先求出实际内容区域（居中 + 黑边）再换算坐标。
 */
export default function AugmentOverlay({ videoRef, matches, isActive }: AugmentOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 同步 Canvas 尺寸与 video 显示尺寸
    const rect = video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const displayW = rect.width;
    const displayH = rect.height;

    if (canvas.width !== displayW * dpr || canvas.height !== displayH * dpr) {
      canvas.width = displayW * dpr;
      canvas.height = displayH * dpr;
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayW, displayH);

    // video 是 object-contain：内容在元素内居中，四周可能有黑边
    const nativeW = video.videoWidth || 1920;
    const nativeH = video.videoHeight || 1080;
    const scale = Math.min(displayW / nativeW, displayH / nativeH);
    const contentW = nativeW * scale;
    const contentH = nativeH * scale;
    const offX = (displayW - contentW) / 2;
    const offY = (displayH - contentH) / 2;

    // 参考分辨率 → 原生帧坐标 → 显示坐标
    const toDisplay = (nx: number, ny: number) => ({
      x: offX + nx * scale,
      y: offY + ny * scale,
    });
    const nativeScaleX = nativeW / 1920;
    const nativeScaleY = nativeH / 1080;

    // 1. 搜索区域校准框（常显）：青色虚线 = 整张卡牌，橙色实线 = OCR 标题条
    for (const r of REFERENCE_REGIONS) {
      const p = toDisplay(r.x * nativeScaleX, r.y * nativeScaleY);
      const rw = r.w * nativeScaleX * scale;
      const rh = r.h * nativeScaleY * scale;

      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.strokeRect(p.x, p.y, rw, rh);

      // OCR 实际识别的标题条（TITLE_STRIP 相对卡牌区域的比例）
      ctx.setLineDash([]);
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.8;
      ctx.strokeRect(
        p.x + TITLE_STRIP.x * rw,
        p.y + TITLE_STRIP.y * rh,
        TITLE_STRIP.w * rw,
        TITLE_STRIP.h * rh,
      );
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 2. 匹配框
    for (const match of matches) {
      const p = toDisplay(match.x, match.y);
      const w = match.w * scale;
      const h = match.h * scale;

      // 颜色：高置信度绿色，中等黄色
      const isHighConf = match.confidence >= 0.85;
      const color = isHighConf ? '#22c55e' : '#eab308';
      const alpha = isHighConf ? 0.9 : 0.7;

      // 外发光效果
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;

      // 矩形框
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = alpha;
      ctx.strokeRect(p.x, p.y, w, h);

      // 重置阴影避免文字模糊
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // 标签背景
      const label = `${match.name ?? match.augmentId} (${Math.round(match.confidence * 100)}%)`;
      ctx.font = '11px system-ui, sans-serif';
      const textW = ctx.measureText(label).width + 8;

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(p.x, p.y - 18, textW, 18);

      // 标签文字
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 1;
      ctx.fillText(label, p.x + 4, p.y - 5);
    }
    ctx.globalAlpha = 1;
  }, [matches, videoRef]);

  useEffect(() => {
    if (!isActive) {
      // 清空画布
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [isActive, draw]);

  if (!isActive) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 10 }}
    />
  );
}
