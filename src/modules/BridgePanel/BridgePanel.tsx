import { useState, useEffect, useCallback, useRef } from 'react';

/* ── types ─────────────────────────────────────────────────── */

interface SummonerInfo {
  displayName: string;
  summonerId: number;
  summonerLevel: number;
  profileIconId: number;
}

interface ChampSelectAction {
  actorCellId: number;
  championId: number;
  completed: boolean;
  type: string;
}

interface ChampSelectSession {
  actions?: ChampSelectAction[][];
  localPlayerCellId: number;
  myTeam?: ChampSelectPlayer[];
  theirTeam?: ChampSelectPlayer[];
  /** 仅大乱斗选人存在；自定义/排位选人无此字段 */
  benchChampionIds?: number[];
  timer?: { phase: string; adjustedTimeLeftInPhase: number };
}

interface ChampSelectPlayer {
  cellId: number;
  championId: number;
  summonerId: number;
  assignedPosition: string;
}

interface BridgeStatus {
  connected: boolean;
  port?: number;
  summonerName?: string;
  gameflowPhase?: string;
}

interface LcuData {
  status: BridgeStatus | null;
  summoner: SummonerInfo | null;
  champSelect: ChampSelectSession | null;
  lastError: string | null;
}

/* ── champion name lookup ──────────────────────────────────── */

// Simplified built-in name cache – production would use full Data Dragon data
const CHAMPION_NAMES: Record<number, string> = {};
let championNamesLoaded = false;

async function ensureChampionNames() {
  if (championNamesLoaded) return;
  try {
    const versionResp = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const versions: string[] = await versionResp.json();
    const latest = versions[0];
    const champResp = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/zh_CN/champion.json`);
    const data = await champResp.json();
    for (const key of Object.keys(data.data)) {
      const champ = data.data[key];
      CHAMPION_NAMES[parseInt(champ.key)] = champ.name;
    }
    championNamesLoaded = true;
  } catch {
    // Silently fail – we'll show champion IDs as fallback
  }
}

function getChampionName(id: number): string {
  return CHAMPION_NAMES[id] || `英雄 #${id}`;
}

/* ── phase display helpers ─────────────────────────────────── */

const PHASE_LABELS: Record<string, string> = {
  None: '大厅',
  Lobby: '大厅',
  Matchmaking: '匹配中',
  ChampSelect: '英雄选择',
  InProgress: '对局中',
  GameStart: '游戏开始',
  WaitingForStats: '等待结算',
  PreEndOfGame: '结算中',
  EndOfGame: '结算完成',
  ReadyCheck: '等待确认',
  Reconnect: '重新连接',
};

function getPhaseLabel(phase: string | undefined): string {
  if (!phase) return '未知';
  return PHASE_LABELS[phase] || phase;
}

function getPhaseColor(phase: string | undefined): string {
  switch (phase) {
    case 'ChampSelect': return 'var(--color-warning)';
    case 'InProgress': return 'var(--color-danger)';
    case 'Lobby': case 'None': return 'var(--color-success)';
    case 'Matchmaking': return 'var(--color-blue)';
    default: return 'var(--color-text-secondary)';
  }
}

/* ── component ─────────────────────────────────────────────── */

export default function BridgePanel() {
  const [data, setData] = useState<LcuData>({
    status: null,
    summoner: null,
    champSelect: null,
    lastError: null,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      // 1. Status
      const statusResp = await fetch('/bridge/status');
      if (!statusResp.ok) {
        setData((prev) => ({
          ...prev,
          status: { connected: false },
          summoner: null,
          champSelect: null,
          lastError: null,
        }));
        return;
      }
      const status: BridgeStatus = await statusResp.json();

      // 2. If connected, fetch LCU data
      if (status.connected) {
        const [summonerResp, champSelectResp] = await Promise.allSettled([
          fetch('/bridge/proxy?endpoint=/lol-summoner/v1/current-summoner'),
          fetch('/bridge/proxy?endpoint=/lol-champ-select/v1/session'),
        ]);

        let summoner: SummonerInfo | null = null;
        let champSelect: ChampSelectSession | null = null;

        if (summonerResp.status === 'fulfilled' && summonerResp.value.ok) {
          summoner = await summonerResp.value.json();
        }
        if (champSelectResp.status === 'fulfilled' && champSelectResp.value.ok) {
          champSelect = await champSelectResp.value.json();
        }

        setData({ status, summoner, champSelect, lastError: null });
      } else {
        setData({
          status,
          summoner: null,
          champSelect: null,
          lastError: null,
        });
      }
    } catch (err) {
      setData((prev) => ({
        ...prev,
        status: { connected: false },
        summoner: null,
        champSelect: null,
        lastError: err instanceof Error ? err.message : '请求失败',
      }));
    }
  }, []);

  useEffect(() => {
    ensureChampionNames();
    fetchData();
    pollRef.current = setInterval(fetchData, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchData]);

  const isConnected = data.status?.connected === true;
  const isChampSelect = data.status?.gameflowPhase === 'ChampSelect';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          桥接状态
        </h3>
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{
              backgroundColor: isConnected ? 'var(--color-success)' : 'var(--color-danger)',
              boxShadow: `0 0 6px ${isConnected ? 'var(--color-success)' : 'var(--color-danger)'}`,
            }}
          />
          <span className="text-xs" style={{ color: isConnected ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {isConnected ? '已连接' : '未连接'}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Not connected state */}
        {!isConnected && (
          <div className="rounded-lg p-6 text-center space-y-3" style={{ backgroundColor: 'var(--color-bg-card)' }}>
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
              className="mx-auto" style={{ color: 'var(--color-text-secondary)' }}>
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                未检测到客户端
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                请确保 LOL 国服客户端已登录，且本地桥接程序已启动
              </p>
            </div>
            <div className="rounded-md p-3 text-xs text-left font-mono" style={{ backgroundColor: 'var(--color-bg-primary)', color: 'var(--color-text-secondary)' }}>
              <p>💡 如何启动桥接程序：</p>
              <p className="mt-1">1. 在项目目录下运行：<code className="text-xs px-1 rounded" style={{ backgroundColor: 'var(--color-bg-hover)' }}>cd bridge &amp;&amp; npm run dev</code></p>
              <p>2. 桥接程序会自动探测 LOL 客户端的 LCU API 端口</p>
              <p>3. 连接成功后本面板将自动刷新</p>
            </div>
          </div>
        )}

        {/* Connected: Summoner info */}
        {isConnected && data.summoner && (
          <div className="rounded-lg p-4" style={{ backgroundColor: 'var(--color-bg-card)' }}>
            <div className="flex items-center gap-3">
              {data.summoner.profileIconId > 0 && (
                <img
                  src={`https://ddragon.leagueoflegends.com/cdn/14.24.1/img/profileicon/${data.summoner.profileIconId}.png`}
                  alt="avatar"
                  className="w-10 h-10 rounded-full border-2"
                  style={{ borderColor: 'var(--color-accent)' }}
                />
              )}
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                  {data.summoner.displayName}
                </p>
                <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  Lv.{data.summoner.summonerLevel}
                </p>
              </div>
              <div className="ml-auto">
                <span
                  className="inline-block px-2 py-0.5 rounded text-xs font-medium"
                  style={{
                    backgroundColor: getPhaseColor(data.status?.gameflowPhase),
                    color: '#000',
                  }}
                >
                  {getPhaseLabel(data.status?.gameflowPhase)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Connected: Champ select data */}
        {isConnected && isChampSelect && data.champSelect && (
          <div className="rounded-lg p-4 space-y-3" style={{ backgroundColor: 'var(--color-bg-card)', borderColor: 'var(--color-warning)', borderWidth: 1 }}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-warning)' }}>
                ⚡ 英雄选择中
              </h4>
              {data.champSelect.timer && (
                <span className="text-xs font-mono" style={{ color: 'var(--color-text-primary)' }}>
                  {Math.ceil(data.champSelect.timer.adjustedTimeLeftInPhase)}s
                </span>
              )}
            </div>

            {/* My champion */}
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--color-text-secondary)' }}>你的英雄</p>
              {(data.champSelect.myTeam ?? [])
                .filter((p) => p.cellId === data.champSelect!.localPlayerCellId)
                .map((player) => (
                  <div key={player.cellId} className="flex items-center gap-2 p-2 rounded" style={{ backgroundColor: 'var(--color-bg-primary)' }}>
                    <span className="text-sm font-semibold" style={{ color: 'var(--color-accent)' }}>
                      {player.championId > 0 ? getChampionName(player.championId) : '尚未选择'}
                    </span>
                  </div>
                ))}
            </div>

            {/* Bench（仅大乱斗选人有备选席） */}
            {(data.champSelect.benchChampionIds?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs mb-1" style={{ color: 'var(--color-text-secondary)' }}>备选席</p>
                <div className="flex gap-2 flex-wrap">
                  {(data.champSelect.benchChampionIds ?? []).map((id, i) => (
                    <span
                      key={i}
                      className="px-2 py-1 rounded text-xs"
                      style={{ backgroundColor: 'var(--color-bg-hover)', color: 'var(--color-text-primary)' }}
                    >
                      {getChampionName(id)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Teammates */}
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--color-text-secondary)' }}>队友</p>
              <div className="space-y-1">
                {(data.champSelect.myTeam ?? [])
                  .filter((p) => p.cellId !== data.champSelect!.localPlayerCellId)
                  .map((player) => (
                    <div key={player.cellId} className="flex items-center gap-2 p-1.5 rounded text-xs" style={{ backgroundColor: 'var(--color-bg-primary)' }}>
                      <span style={{ color: 'var(--color-text-secondary)' }}>#{player.cellId}</span>
                      <span style={{ color: 'var(--color-text-primary)' }}>
                        {player.championId > 0 ? getChampionName(player.championId) : '选择中...'}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* Connected but no summoner data */}
        {isConnected && !data.summoner && (
          <div className="rounded-lg p-4 text-center" style={{ backgroundColor: 'var(--color-bg-card)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              正在获取召唤师数据...
            </p>
          </div>
        )}

        {/* Error display */}
        {data.lastError && (
          <div className="rounded-lg p-3" style={{ backgroundColor: 'rgba(232, 64, 64, 0.1)', borderColor: 'var(--color-danger)', borderWidth: 1 }}>
            <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{data.lastError}</p>
          </div>
        )}

        {/* Debug: raw status */}
        <details className="text-xs cursor-pointer">
          <summary className="px-1 py-0.5 rounded" style={{ color: 'var(--color-text-secondary)' }}>调试信息</summary>
          <pre className="mt-2 p-3 rounded text-xs overflow-x-auto font-mono" style={{ backgroundColor: 'var(--color-bg-primary)', color: 'var(--color-text-secondary)' }}>
            {JSON.stringify({ status: data.status, champSelectPhase: data.champSelect?.timer }, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
