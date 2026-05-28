import React from "react";
import {
  Check,
  AlertTriangle,
  Play,
  RotateCcw,
  Download,
  FolderOpen,
  Terminal,
  FileText,
  Volume2,
  Languages,
  Video,
  Music,
  Tv,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useIntervox } from "../hooks/useIntervox";

export function Tasks() {
  const { tasks, activeTaskId, clearCompletedTasks, retryTask, deleteTask } = useIntervox();

  // Find active task
  const activeTask = tasks.find((t) => t.status === "running") || tasks.find((t) => t.status === "queued" && activeTaskId === t.id);
  const queuedTasks = tasks.filter((t) => t.status === "queued" && t.id !== activeTask?.id);
  const finishedTasks = tasks.filter((t) => t.status === "completed" || t.status === "failed");

  // Pipeline stage icons and names helper
  const pipelineStages = [
    { key: "select_video", label: "Select Video", icon: Video },
    { key: "extract_audio", label: "Extract Audio", icon: Music },
    { key: "asr", label: "ASR (Aliyun)", icon: Volume2 },
    { key: "translate", label: "Translate", icon: Languages },
    { key: "tts_clone", label: "TTS/Clone", icon: Tv },
    { key: "mix_media", label: "Mix Media", icon: Check },
    { key: "final_output", label: "Final Output", icon: Download },
  ];

  const getStageIndex = (stageName: string) => {
    return pipelineStages.findIndex((s) => s.key === stageName);
  };


  const handleOpenFile = async (path: string | undefined) => {
    if (!path) return;
    try {
      await invoke("open_in_default_app", { path });
    } catch (e) {
      console.error("open_in_default_app failed:", e);
    }
  };

  const handleRevealInFinder = async (path: string | undefined) => {
    if (!path) return;
    try {
      await invoke("reveal_in_finder", { path });
    } catch (e) {
      console.error("reveal_in_finder failed:", e);
    }
  };

  return (
    <div className="space-y-6 font-mono text-[13px] animate-fade-in">
      {/* Page Header */}
      <div className="flex items-center justify-between border-b th-border pb-4">
        <div>
          <h2 className="text-xl font-bold th-text tracking-tight uppercase">
            Operation Queue
          </h2>
          <p className="text-xs th-text-muted mt-1 uppercase tracking-wider">
            SYSTEM STATUS: <span className="text-emerald-400 font-bold">OPTIMAL</span> // THREADS: 12/16
          </p>
        </div>
        {finishedTasks.length > 0 && (
          <button
            onClick={clearCompletedTasks}
            className="px-3 py-1 border th-border th-text-3 hover:th-text transition-colors uppercase tracking-widest text-[11px]"
          >
            Clear Finished
          </button>
        )}
      </div>

      {/* Active Process Pipeline */}
      {activeTask ? (
        <div className="border th-border th-bg-card p-5 space-y-6 rounded-sm relative">
          {/* Top Info */}
          <div className="flex items-center justify-between border-b th-border pb-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${activeTask.status === "queued" ? "bg-amber-400" : "bg-cyan-400 animate-ping"}`}></span>
              <span className="font-extrabold th-text tracking-wide text-xs">
                ACTIVE TASK: {activeTask.id}
              </span>
              <span className="text-[10px] th-text-muted">({activeTask.fileName})</span>
              {activeTask.status === "queued" && (
                <span className="text-[9px] text-amber-400 border border-amber-500/30 rounded bg-amber-500/10 px-1.5 py-0.5 font-bold uppercase tracking-wider">
                  IDLE (QUEUED)
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {activeTask.status === "queued" && (
                <>
                  <button
                    onClick={() => retryTask(activeTask.id)}
                    className="flex items-center gap-1 px-2 py-0.5 border border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-black rounded transition-all text-[11px] font-bold"
                    title="立即启动该任务"
                  >
                    <Play className="w-2.5 h-2.5 fill-current" />
                    RUN
                  </button>
                  <button
                    onClick={() => deleteTask(activeTask.id)}
                    className="flex items-center gap-1 px-2 py-0.5 border border-red-500/30 text-red-400 hover:bg-red-500 hover:text-black rounded transition-all text-[11px] font-bold"
                    title="删除该任务"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                    DEL
                  </button>
                </>
              )}
              <div className="text-[11px] th-text-muted">
                ETA: <span className="text-cyan-400 font-bold">02:14:09</span>
              </div>
            </div>
          </div>

          {/* Graphical Progress Pipeline */}
          <div className="flex items-center justify-between px-4 py-2 overflow-x-auto gap-4">
            {pipelineStages.map((stage, idx) => {
              const activeIndex = getStageIndex(activeTask.stage);
              const isCompleted = idx < activeIndex;
              const isActive = idx === activeIndex && activeTask.status === "running";
              const isFuture = idx > activeIndex;
              const StageIcon = stage.icon;

              return (
                <React.Fragment key={stage.key}>
                  {/* Pipeline Step */}
                  <div className="flex flex-col items-center space-y-2 flex-shrink-0 relative">
                    <div
                      className={`w-10 h-10 rounded-full border flex items-center justify-center transition-all ${
                        isCompleted
                          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
                          : isActive
                            ? "border-cyan-400 bg-cyan-500/20 text-cyan-400 border-glow animate-pulse"
                            : "th-border text-slate-600 bg-black/40"
                      }`}
                    >
                      <StageIcon className="w-4 h-4" />
                    </div>
                    <span
                      className={`text-[9px] font-bold uppercase tracking-wider text-center max-w-[80px] ${
                        isActive
                          ? "text-cyan-400 text-glow font-extrabold animate-pulse"
                          : isCompleted
                            ? "th-text"
                            : "th-text-muted"
                      }`}
                    >
                      {stage.label}
                    </span>
                  </div>

                  {/* Connecting line */}
                  {idx < pipelineStages.length - 1 && (
                    <div className="flex-1 h-[2px] bg-slate-800 min-w-[20px] relative overflow-hidden">
                      {isCompleted && <div className="absolute inset-0 bg-cyan-500" />}
                      {isActive && (
                        <div className="absolute inset-0 bg-gradient-to-r from-cyan-500 to-transparent animate-pulse" />
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Sub progress values */}
          <div className="space-y-2 border-t th-border pt-4">
            <div className="flex justify-between items-center text-xs">
              <span className="th-text-2">
                {activeTask.logLines[activeTask.logLines.length - 1] || "Transcribing audio segments..."}
              </span>
              <span className="text-cyan-400 font-bold">{Math.round(activeTask.progress * 100)}%</span>
            </div>
            <div className="h-1.5 bg-slate-800/80 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-400 rounded-full transition-all duration-300 border-glow"
                style={{ width: `${activeTask.progress * 100}%` }}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="border th-border bg-black/20 p-8 rounded-sm text-center flex flex-col items-center justify-center space-y-2">
          <Terminal className="w-8 h-8 th-text-muted" />
          <span className="font-bold th-text text-xs uppercase tracking-widest">
            NO ACTIVE Dubbing tasks
          </span>
          <span className="text-[10px] th-text-muted">
            Go to Player or Translate configuration tab to initiate a new dubbing pipeline.
          </span>
        </div>
      )}

      {/* Columns: Queued and History */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Queued Operations Card */}
        <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
          <div className="flex items-center gap-2 border-b th-border pb-2">
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              QUEUED OPERATIONS
            </span>
          </div>

          <div className="space-y-3">
            {queuedTasks.length > 0 ? (
              queuedTasks.map((t) => (
                <div
                  key={t.id}
                  className="border th-border bg-black/20 p-3.5 flex items-center justify-between rounded-sm"
                >
                  <div className="space-y-1">
                    <span className="font-bold th-text text-xs truncate max-w-[200px] block">
                      {t.fileName}
                    </span>
                    <span className="text-[10px] th-text-muted block">
                      ID: {t.id} // Target: {t.targetLang}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] font-bold text-slate-500 uppercase border border-slate-700/50 px-2 py-0.5 rounded bg-slate-800/40">
                      QUEUED
                    </span>
                    <button
                      onClick={() => retryTask(t.id)}
                      className="w-7 h-7 rounded border border-cyan-500/30 flex items-center justify-center text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all"
                      title="开始执行任务"
                    >
                      <Play className="w-3 h-3 fill-current" />
                    </button>
                    <button
                      onClick={() => deleteTask(t.id)}
                      className="w-7 h-7 rounded border border-red-500/30 flex items-center justify-center text-red-400 hover:bg-red-500 hover:text-black transition-all"
                      title="删除任务"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-6 th-text-muted text-[11px]">
                Queue is empty. No tasks pending.
              </div>
            )}
          </div>
        </div>

        {/* Recent Logs & History Card */}
        <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
          <div className="flex items-center gap-2 border-b th-border pb-2">
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              RECENT LOGS
            </span>
          </div>

          <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
            {finishedTasks.map((t) => (
              <div
                key={t.id}
                className={`border p-3.5 rounded-sm ${
                  t.status === "completed"
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : "border-red-500/20 bg-red-500/5"
                }`}
              >
                {/* Top row: file info + action button */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 min-w-0">
                    <span className="font-bold th-text text-xs truncate max-w-[220px] block">
                      {t.fileName}
                    </span>
                    <span className="text-[10px] th-text-muted block">
                      {t.id} • {t.duration || "N/A"}
                    </span>
                  </div>

                  <div className="flex gap-2 flex-shrink-0">
                    {t.status === "completed" ? (
                      <>
                        {/* Open in default player */}
                        <button
                          onClick={() => handleOpenFile(t.outputVideoPath)}
                          className="w-7 h-7 rounded border border-emerald-500/30 flex items-center justify-center text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all"
                          title="用默认播放器打开视频"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        {/* Reveal in Finder */}
                        <button
                          onClick={() => handleRevealInFinder(t.outputVideoPath)}
                          className="w-7 h-7 rounded border border-emerald-500/30 flex items-center justify-center text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all"
                          title="在 Finder 中显示"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => retryTask(t.id)}
                        className="w-7 h-7 rounded border border-red-500/30 flex items-center justify-center text-red-400 hover:bg-red-500 hover:text-black transition-all animate-pulse"
                        title="重试导出 pipeline"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => deleteTask(t.id)}
                      className="w-7 h-7 rounded border border-red-500/30 flex items-center justify-center text-red-400 hover:bg-red-500 hover:text-black transition-all"
                      title="删除记录"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Error message — shown below, full width, truncated with tooltip */}
                {t.error && (
                  <p
                    className="text-[10px] text-red-400 font-bold mt-2 leading-relaxed line-clamp-3 break-all"
                    title={t.error}
                  >
                    {t.error}
                  </p>
                )}
              </div>
            ))}

            {finishedTasks.length === 0 && (
              <div className="text-center py-6 th-text-muted text-[11px]">
                No recent operations recorded in this session.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
