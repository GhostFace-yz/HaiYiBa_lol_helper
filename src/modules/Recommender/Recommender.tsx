import { useState, useEffect, useCallback, useRef } from 'react';

interface KbVersion {
  version: string;
  assetVersion: string | null;
  updatedAt: string | null;
}

interface AssetCounts {
  champions: number;
  items: number;
  augments: number;
}

export default function Recommender() {
  const [kbStatus, setKbStatus] = useState<'loading' | 'connected' | 'error'>('loading');
  const [kbVersion, setKbVersion] = useState<KbVersion | null>(null);
  const [counts, setCounts] = useState<AssetCounts | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchKbData = useCallback(async () => {
    try {
      // 并行请求版本和素材列表
      const [versionRes, championsRes, itemsRes, augmentsRes] = await Promise.allSettled([
        fetch('/kb/version'),
        fetch('/assets/champions'),
        fetch('/assets/items'),
        fetch('/assets/augments'),
      ]);

      if (!mountedRef.current) return;

      // 版本信息（判断连接状态）
      if (versionRes.status === 'fulfilled' && versionRes.value.ok) {
        const v = await versionRes.value.json() as KbVersion;
        setKbVersion(v);
        setKbStatus('connected');
        setLastError(null);
      } else {
        setKbStatus('error');
        if (versionRes.status === 'rejected') {
          setLastError(versionRes.reason?.message || '请求失败');
        }
      }

      // 素材计数
      const newCounts: AssetCounts = { champions: 0, items: 0, augments: 0 };
      if (championsRes.status === 'fulfilled' && championsRes.value.ok) {
        const data = await championsRes.value.json() as unknown[];
        newCounts.champions = Array.isArray(data) ? data.length : 0;
      }
      if (itemsRes.status === 'fulfilled' && itemsRes.value.ok) {
        const data = await itemsRes.value.json() as unknown[];
        newCounts.items = Array.isArray(data) ? data.length : 0;
      }
      if (augmentsRes.status === 'fulfilled' && augmentsRes.value.ok) {
        const data = await augmentsRes.value.json() as unknown[];
        newCounts.augments = Array.isArray(data) ? data.length : 0;
      }
      if (newCounts.champions > 0 || newCounts.items > 0 || newCounts.augments > 0) {
        setCounts(newCounts);
      }
    } catch (err) {
      if (mountedRef.current) {
        setKbStatus('error');
        setLastError((err as Error).message);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchKbData();
    // 知识库数据变化不频繁，30 秒轮询一次
    const interval = setInterval(fetchKbData, 30000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchKbData]);

  const statusColor = kbStatus === 'connected' ? 'var(--color-success)'
    : kbStatus === 'loading' ? 'var(--color-text-secondary)'
    : 'var(--color-danger)';

  const statusText = kbStatus === 'connected' ? '知识库已连接'
    : kbStatus === 'loading' ? '正在连接知识库...'
    : '知识库未连接';

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
      {/* 连接状态 */}
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          {statusText}
        </span>
      </div>

      {/* 版本信息 */}
      {kbVersion && kbStatus === 'connected' && (
        <div className="flex flex-col items-center gap-1">
          {kbVersion.assetVersion && (
            <span className="text-xs" style={{ color: 'var(--color-text-secondary)', opacity: 0.7 }}>
              素材版本: {kbVersion.assetVersion}
            </span>
          )}
          <span className="text-xs" style={{ color: 'var(--color-text-secondary)', opacity: 0.5 }}>
            服务版本: {kbVersion.version}
          </span>
        </div>
      )}

      {/* 素材计数 */}
      {counts && kbStatus === 'connected' && (
        <span className="text-xs" style={{ color: 'var(--color-text-secondary)', opacity: 0.7 }}>
          已加载 {counts.champions} 英雄 · {counts.items} 装备 · {counts.augments} 海克斯
        </span>
      )}

      {/* 错误信息 */}
      {kbStatus === 'error' && lastError && (
        <span className="text-xs text-center px-2" style={{ color: 'var(--color-danger)', opacity: 0.7, maxWidth: '200px' }}>
          {lastError}
        </span>
      )}

      {/* 开发中标记 */}
      <div
        className="mt-2 px-3 py-1.5 rounded-full text-xs"
        style={{ backgroundColor: 'var(--color-bg-card)', color: 'var(--color-accent)' }}
      >
        推荐引擎开发中 🚧
      </div>
    </div>
  );
}
