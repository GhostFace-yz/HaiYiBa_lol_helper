import { useRef, useEffect } from 'react';

export interface AugmentMatch {
  augmentId: string;
  regionIndex: number;
  confidence: number;
  x: number;
  y: number;
}

interface AugmentOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  matches: AugmentMatch[];
  isActive: boolean;
}

/**
 * AugmentOverlay — Canvas 标注层
 *
 * 在视频元素上方叠加一个等大的 Canvas，绘制海克斯强化图标的匹配框。
 * 坐标自动从视频原生分辨率缩放到显示尺寸。
 */
export default function AugmentOverlay({ videoRef, matches, isActive }: AugmentOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!isActive || matches.length === 0) {
      // 清空画布
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    const draw = () => {
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

      // 坐标缩放因子：原生分辨率 → 显示大小
      const nativeW = video.videoWidth || 1920;
      const nativeH = video.videoHeight || 1080;
      const scaleX = displayW / nativeW;
      const scaleY = displayH / nativeH;

      for (const match of matches) {
        const x = match.x * scaleX;
        const y = match.y * scaleY;
        const w = 180 * scaleX;   // 参考宽度
        const h = 180 * scaleY;

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
        ctx.strokeRect(x, y, w, h);

        // 重置阴影避免文字模糊
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // 标签背景
        const label = `${match.augmentId.slice(0, 12)} (${Math.round(match.confidence * 100)}%)`;
        ctx.font = '11px system-ui, sans-serif';
        const textW = ctx.measureText(label).width + 8;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, y - 18, textW, 18);

        // 标签文字
        ctx.fillStyle = '#000';
        ctx.globalAlpha = 1;
        ctx.fillText(label, x + 4, y - 5);
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [matches, isActive, videoRef]);

  if (!isActive) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 10 }}
    />
  );
}
