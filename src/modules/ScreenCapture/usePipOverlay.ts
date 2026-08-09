import { useState, useEffect, useRef, useCallback } from 'react';
import type { AugmentMatch } from './AugmentOverlay';

interface DocumentPip {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

function getDocumentPip(): DocumentPip | undefined {
  return (window as unknown as { documentPictureInPicture?: DocumentPip })
    .documentPictureInPicture;
}

/**
 * usePipOverlay — Document Picture-in-Picture 游戏悬浮标注窗
 *
 * 把捕获的视频流 + 海克斯匹配框渲染到一个永远置顶的悬浮窗里。
 * 用户把悬浮窗拖到游戏窗口上对齐（视频 object-fit: fill，
 * 框坐标按窗口尺寸等比缩放，任意窗口大小都对得上）。
 */
export function usePipOverlay(
  streamRef: React.RefObject<MediaStream | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  matches: AugmentMatch[],
) {
  const [pipActive, setPipActive] = useState(false);
  const pipWinRef = useRef<Window | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const matchesRef = useRef(matches);
  const rafRef = useRef(0);

  useEffect(() => {
    matchesRef.current = matches;
  }, [matches]);

  const draw = useCallback(() => {
    const canvas = pipCanvasRef.current;
    const pipWin = pipWinRef.current;
    if (!canvas || !pipWin) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = pipWin.devicePixelRatio || 1;
    const w = pipWin.innerWidth;
    const h = pipWin.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 悬浮窗内视频是 fill 拉伸的，框按同样比例缩放即可对齐
    const nativeW = videoRef.current?.videoWidth || 1920;
    const nativeH = videoRef.current?.videoHeight || 1080;
    const sx = w / nativeW;
    const sy = h / nativeH;

    for (const m of matchesRef.current) {
      const x = m.x * sx;
      const y = m.y * sy;
      const bw = m.w * sx;
      const bh = m.h * sy;

      const isHighConf = m.confidence >= 0.85;
      const color = isHighConf ? '#22c55e' : '#eab308';

      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, bw, bh);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      const label = `${m.name ?? m.augmentId} (${Math.round(m.confidence * 100)}%)`;
      ctx.font = 'bold 16px system-ui, sans-serif';
      const textW = ctx.measureText(label).width + 10;

      ctx.fillStyle = color;
      ctx.fillRect(x, y - 26, textW, 26);
      ctx.fillStyle = '#000';
      ctx.fillText(label, x + 5, y - 7);
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [videoRef]);

  const closePip = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    pipCanvasRef.current = null;
    if (pipWinRef.current) {
      pipWinRef.current.close();
      pipWinRef.current = null;
    }
    setPipActive(false);
  }, []);

  const openPip = useCallback(async () => {
    const dpip = getDocumentPip();
    const stream = streamRef.current;
    if (!dpip || !stream) return;

    const pipWin = await dpip.requestWindow({ width: 480, height: 270 });
    pipWinRef.current = pipWin;

    const doc = pipWin.document;
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden';

    const video = doc.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:fill';

    const canvas = doc.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    pipCanvasRef.current = canvas;

    doc.body.append(video, canvas);

    // 用户手动关闭悬浮窗时同步状态
    pipWin.addEventListener('pagehide', () => {
      cancelAnimationFrame(rafRef.current);
      pipCanvasRef.current = null;
      pipWinRef.current = null;
      setPipActive(false);
    });

    setPipActive(true);
    rafRef.current = requestAnimationFrame(draw);
  }, [streamRef, draw]);

  const togglePip = useCallback(() => {
    if (pipWinRef.current) {
      closePip();
    } else {
      openPip().catch((e) => console.error('[PiP] 悬浮窗打开失败:', e));
    }
  }, [openPip, closePip]);

  // 卸载时清理
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      pipWinRef.current?.close();
      pipWinRef.current = null;
    };
  }, []);

  return {
    pipActive,
    togglePip,
    closePip,
    pipSupported: typeof window !== 'undefined' && !!getDocumentPip(),
  };
}
