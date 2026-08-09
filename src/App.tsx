import ScreenCapture from './modules/ScreenCapture';
import BridgePanel from './modules/BridgePanel';
import Recommender from './modules/Recommender';

function App() {
  return (
    <div className="flex flex-col h-screen" style={{ backgroundColor: 'var(--color-bg-primary)' }}>
      {/* Title bar */}
      <header
        className="flex items-center justify-between px-4 py-2 flex-shrink-0 border-b"
        style={{
          backgroundColor: 'var(--color-bg-secondary)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg" role="img" aria-label="logo">⚔️</span>
          <h1
            className="text-sm font-bold tracking-wide"
            style={{ color: 'var(--color-accent)' }}
          >
            海克斯大乱斗助手
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          <span>v0.1.0</span>
          <span
            className="px-1.5 py-0.5 rounded text-xs"
            style={{ backgroundColor: 'var(--color-bg-card)', color: 'var(--color-text-secondary)' }}
          >
            Alpha
          </span>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left: Screen capture */}
        <div
          className="flex-[3] border-r overflow-hidden"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <ScreenCapture />
        </div>

        {/* Right: Panel area */}
        <div className="flex-[2] flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <BridgePanel />
          </div>
          <div
            className="h-48 border-t flex-shrink-0 overflow-hidden"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Recommender />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
