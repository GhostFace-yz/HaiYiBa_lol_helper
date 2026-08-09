import { useRef, useState, useCallback, useEffect } from 'react';
import { useBorderlessDetection } from './useBorderlessDetection';
import AugmentOverlay from './AugmentOverlay';
import { useAugmentDetection } from './useAugmentDetection';
import { usePipOverlay } from './usePipOverlay';

interface CaptureState {
  status: 'idle' | 'capturing' | 'error';
  resolution?: { width: number; height: number };
  errorMessage?: string;
  errorHint?: string;
}

export default function ScreenCapture() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CaptureState>({ status: 'idle' });

  const borderless = useBorderlessDetection(
    streamRef,
    videoRef,
    state.status === 'capturing',
  );

  const augment = useAugmentDetection(
    videoRef,
    state.status === 'capturing',
  );

  const pip = usePipOverlay(streamRef, videoRef, augment.matches);

  const stopCapture = useCallback(() => {
    pip.closePip();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setState({ status: 'idle' });
  }, [pip.closePip]);

  const startCapture = useCallback(async () => {
    try {
      // 1. Secure context check: getDisplayMedia requires HTTPS or localhost
      if (!window.isSecureContext) {
        setState({
          status: 'error',
          errorMessage: '当前页面非安全上下文，浏览器禁止屏幕捕获',
          errorHint: '请通过 http://localhost:5173 访问（不要使用局域网 IP 地址），或通过 HTTPS 部署后使用。',
        });
        return;
      }

      // 2. API availability check
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        setState({
          status: 'error',
          errorMessage: '当前浏览器不支持屏幕捕获 (getDisplayMedia)',
          errorHint: '请使用最新版 Chrome 或 Edge，并通过 localhost 或 HTTPS 访问。',
        });
        return;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        setState({
          status: 'capturing',
          resolution: {
            width: settings.width || 0,
            height: settings.height || 0,
          },
        });

        videoTrack.addEventListener('ended', () => {
          stopCapture();
        });
      }
    } catch (err) {
      const error = err as DOMException;
      if (error.name === 'AbortError') {
        setState({ status: 'idle' });
        return;
      }
      setState({
        status: 'error',
        errorMessage: `屏幕捕获失败：${error.message || '未知错误'}`,
      });
    }
  }, [stopCapture]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          画面预览
        </h3>
        <div className="flex items-center gap-2">
          {state.status === 'capturing' && state.resolution && (
            <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {state.resolution.width} × {state.resolution.height}
            </span>
          )}
          {state.status === 'capturing' && (
            <span
              className="text-xs"
              title={augment.error || undefined}
              style={{
                color: augment.error
                  ? 'var(--color-danger)'
                  : augment.workerReady && augment.iconCount > 0
                    ? 'var(--color-success)'
                    : 'var(--color-warning, #eab308)',
              }}
            >
              {augment.error
                ? `海克斯识别不可用: ${augment.error}`
                : augment.workerReady
                  ? augment.iconCount > 0
                    ? `OCR 词库 ${augment.iconCount} 个`
                    : '词库为空（请运行 pnpm run fetch-assets)'
                  : 'OCR 引擎加载中...'}
            </span>
          )}
          {state.status === 'capturing' && augment.workerReady && augment.debug.length > 0 && (
            <span
              className="text-xs"
              title="三个卡牌区域各自的最佳名称相似度，≥70% 才画框；持续偏低说明区域没框住文字或 OCR 识别质量差"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              区域匹配 {augment.debug.map((d) => `${Math.round(d.bestConfidence * 100)}%`).join(' / ')}
            </span>
          )}
          {state.status === 'capturing' && pip.pipSupported && (
            <button
              onClick={pip.togglePip}
              title="打开置顶悬浮窗：视频画面 + 识别框，拖到游戏窗口上对齐"
              className="px-3 py-1 text-xs rounded transition-colors"
              style={{
                backgroundColor: pip.pipActive ? 'var(--color-danger)' : 'var(--color-success, #22c55e)',
                color: pip.pipActive ? '#fff' : '#000',
              }}
            >
              {pip.pipActive ? '关闭悬浮框' : '游戏悬浮框'}
            </button>
          )}
          {state.status === 'capturing' ? (
            <button
              onClick={stopCapture}
              className="px-3 py-1 text-xs rounded transition-colors"
              style={{
                backgroundColor: 'var(--color-danger)',
                color: '#fff',
              }}
            >
              停止捕获
            </button>
          ) : (
            <button
              onClick={startCapture}
              className="px-3 py-1 text-xs rounded transition-colors"
              style={{
                backgroundColor: 'var(--color-accent)',
                color: '#000',
              }}
            >
              开始捕获
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden" style={{ backgroundColor: '#000' }}>
        {state.status === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
              style={{ color: 'var(--color-text-secondary)' }}>
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              点击「开始捕获」选择 LOL 游戏窗口
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)', opacity: 0.6 }}>
              提示：游戏需使用无边框窗口模式
            </p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
              style={{ color: 'var(--color-danger)' }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="text-sm text-center" style={{ color: 'var(--color-danger)' }}>
              {state.errorMessage}
            </p>
            {state.errorHint && (
              <p className="text-xs text-center mt-1 px-4 py-2 rounded" style={{ backgroundColor: 'var(--color-bg-card)', color: 'var(--color-text-secondary)', maxWidth: '360px' }}>
                💡 {state.errorHint}
              </p>
            )}
            <button
              onClick={startCapture}
              className="mt-2 px-4 py-1.5 text-xs rounded transition-colors"
              style={{ backgroundColor: 'var(--color-bg-hover)', color: 'var(--color-text-primary)' }}
            >
              重试
            </button>
          </div>
        )}

        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          style={{ display: state.status === 'capturing' ? 'block' : 'none' }}
        />
        <AugmentOverlay
          videoRef={videoRef}
          matches={augment.matches}
          isActive={state.status === 'capturing'}
        />
      </div>

      {/* 无边框窗口检测状态栏 */}
      {state.status === 'capturing' && (
        <div
          className="flex items-center justify-between px-4 py-2 border-t text-xs"
          style={{
            borderColor: 'var(--color-border)',
            backgroundColor: borderless.stillnessWarning
              ? 'rgba(234, 179, 8, 0.08)'
              : 'transparent',
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                backgroundColor: borderless.stillnessWarning
                  ? 'var(--color-warning, #eab308)'
                  : borderless.isLikelyBorderless === true
                    ? 'var(--color-success)'
                    : 'var(--color-text-secondary)',
              }}
            />
            {borderless.stillnessWarning ? (
              <span style={{ color: 'var(--color-warning, #eab308)' }}>
                ⚠ {borderless.stillnessWarning}
              </span>
            ) : borderless.isLikelyBorderless === true ? (
              <span style={{ color: 'var(--color-success)' }}>
                画面正常更新 ✓
              </span>
            ) : (
              <span style={{ color: 'var(--color-text-secondary)' }}>
                正在检测画面状态...
              </span>
            )}
          </div>
          {borderless.stillnessWarning && (
            <button
              onClick={borderless.dismissWarning}
              className="px-2 py-0.5 text-xs rounded transition-colors"
              style={{
                backgroundColor: 'var(--color-bg-hover)',
                color: 'var(--color-text-primary)',
              }}
            >
              我知道了
            </button>
          )}
        </div>
      )}
    </div>
  );
}
