import { useState, useEffect, useRef, useCallback } from 'react';

export interface BorderlessStatus {
  isLikelyBorderless: boolean | null;
  stillnessWarning: string | null;
  detectionMethod: 'track_label' | 'frame_diff' | 'none';
}

interface FrameSample {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const CHECK_INTERVAL_MS = 2000;
const STILLNESS_THRESHOLD = 50; // 像素差异阈值（RGB 总和）
const CONSECUTIVE_STILL_CHECKS = 3; // 连续静止 N 次才报警

/**
 * 从视频帧中采样像素点，用于帧差异比较。
 * 采样 10×10 网格 = 100 个像素，足够判断画面是否有变化。
 */
function sampleFrame(video: HTMLVideoElement, gridSize = 10): FrameSample | null {
  try {
    const canvas = document.createElement('canvas');
    const w = Math.min(video.videoWidth || 640, 320); // 缩小到 320px 宽加快处理
    const h = (w / (video.videoWidth || 640)) * (video.videoHeight || 360);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, w, h);
    // 只采样网格点，不需要全图
    const imageData = ctx.getImageData(0, 0, w, h);
    const sampled = new Uint8ClampedArray(gridSize * gridSize * 3);
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const px = Math.floor((gx / gridSize) * w);
        const py = Math.floor((gy / gridSize) * h);
        const idx = (py * w + px) * 4;
        const si = (gy * gridSize + gx) * 3;
        sampled[si] = imageData.data[idx];
        sampled[si + 1] = imageData.data[idx + 1];
        sampled[si + 2] = imageData.data[idx + 2];
      }
    }
    return { data: sampled, width: gridSize, height: gridSize };
  } catch {
    return null;
  }
}

/**
 * 比较两帧采样数据的差异。
 * 返回差异像素比例 (0–1)。
 */
function computeFrameDiff(prev: FrameSample, curr: FrameSample): number {
  let diffPixels = 0;
  const totalPixels = prev.width * prev.height;
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    const rDiff = Math.abs(prev.data[idx] - curr.data[idx]);
    const gDiff = Math.abs(prev.data[idx + 1] - curr.data[idx + 1]);
    const bDiff = Math.abs(prev.data[idx + 2] - curr.data[idx + 2]);
    if (rDiff + gDiff + bDiff > STILLNESS_THRESHOLD) {
      diffPixels++;
    }
  }
  return diffPixels / totalPixels;
}

/**
 * useBorderlessDetection
 *
 * 检测用户是否选择了无边框窗口（而非独占全屏）。
 * 浏览器无法获取 OS 级别的全屏状态，因此使用启发式方法：
 *
 * 1. 解析 MediaStreamTrack.label — 在 Chrome 中，"window:" 前缀表示窗口捕获
 * 2. 帧差异检测 — 画面长时间静止可能是全屏独占导致黑屏/残留
 *
 * @param streamRef - MediaStream ref（用于读取 track label）
 * @param videoRef - video 元素 ref（用于帧采样）
 * @param isCapturing - 是否正在捕获
 * @returns BorderlessStatus
 */
export function useBorderlessDetection(
  streamRef: React.MutableRefObject<MediaStream | null>,
  videoRef: React.MutableRefObject<HTMLVideoElement | null>,
  isCapturing: boolean,
  onDismissWarning?: () => void,
): BorderlessStatus & { dismissWarning: () => void } {
  const [status, setStatus] = useState<BorderlessStatus>({
    isLikelyBorderless: null,
    stillnessWarning: null,
    detectionMethod: 'none',
  });
  const [dismissed, setDismissed] = useState(false);
  const prevFrameRef = useRef<FrameSample | null>(null);
  const stillCountRef = useRef(0);

  const dismissWarning = useCallback(() => {
    setDismissed(true);
    setStatus(prev => ({ ...prev, stillnessWarning: null }));
    onDismissWarning?.();
  }, [onDismissWarning]);

  useEffect(() => {
    if (!isCapturing) {
      setStatus({
        isLikelyBorderless: null,
        stillnessWarning: null,
        detectionMethod: 'none',
      });
      prevFrameRef.current = null;
      stillCountRef.current = 0;
      setDismissed(false);
      return;
    }

    // 方法 1: Track label 检测
    const stream = streamRef.current;
    if (stream) {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const label = videoTrack.label || '';
        // Chrome: "window:<id>" 或 "screen:<id>" 或 "web-contents-media-stream://..."
        if (label.startsWith('window:')) {
          setStatus({
            isLikelyBorderless: true,
            stillnessWarning: null,
            detectionMethod: 'track_label',
          });
          return; // 检测到窗口捕获，不需要帧差异检测
        }
      }
    }

    // 方法 2: 帧静止检测（仅当 track label 无法判断时）
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled || dismissed) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      const curr = sampleFrame(video);
      if (!curr) return;

      if (prevFrameRef.current) {
        const diff = computeFrameDiff(prevFrameRef.current, curr);
        if (diff < 0.05) {
          // 画面变化很小 — 可能是静止
          stillCountRef.current++;
          if (stillCountRef.current >= CONSECUTIVE_STILL_CHECKS) {
            setStatus({
              isLikelyBorderless: false,
              stillnessWarning: '画面长时间未变化，请确认游戏为无边框窗口模式',
              detectionMethod: 'frame_diff',
            });
          }
        } else {
          // 画面有变化 — 正常
          stillCountRef.current = 0;
          setStatus({
            isLikelyBorderless: true,
            stillnessWarning: null,
            detectionMethod: 'frame_diff',
          });
        }
      }
      prevFrameRef.current = curr;
    }, CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      prevFrameRef.current = null;
      stillCountRef.current = 0;
    };
  }, [isCapturing, streamRef, videoRef, dismissed]);

  return { ...status, dismissWarning };
}
