import { useRef, useState, useCallback, useEffect } from 'react';

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

  const stopCapture = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setState({ status: 'idle' });
  }, []);

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
      </div>
    </div>
  );
}
