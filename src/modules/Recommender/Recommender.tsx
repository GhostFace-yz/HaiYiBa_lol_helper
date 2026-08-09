export default function Recommender() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        style={{ color: 'var(--color-text-secondary)' }}>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <p className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
        推荐引擎
      </p>
      <p className="text-xs text-center" style={{ color: 'var(--color-text-secondary)', opacity: 0.6 }}>
        基于英雄数据与阵容分析的智能推荐将在后续版本上线
      </p>
      <div className="mt-2 px-3 py-1.5 rounded-full text-xs" style={{ backgroundColor: 'var(--color-bg-card)', color: 'var(--color-accent)' }}>
        开发中 🚧
      </div>
    </div>
  );
}
