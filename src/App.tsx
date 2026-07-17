import React from "react";
import { IntervoxProvider, useIntervox } from "./hooks/useIntervox";
import { Sidebar } from "./components/Sidebar";
import { Player } from "./pages/Player";
import { Translate } from "./pages/Translate";
import { Tasks } from "./pages/Tasks";
import { Settings } from "./pages/Settings";
import { Downloader } from "./pages/Downloader";
import { CheckCircle, AlertTriangle, Info } from "lucide-react";
import { UpdateModal } from "./components/UpdateModal";
import { useUpdater } from "./updater";

function IntervoxContent() {
  const { activePage, toast, tasks } = useIntervox();
  const hasActiveTasks = React.useMemo(
    () => tasks.some((task) => task.status === "queued" || task.status === "running"),
    [tasks],
  );
  const updater = useUpdater({ installBlocked: hasActiveTasks });
  const [showUpdateModal, setShowUpdateModal] = React.useState(false);
  const startupCheckStarted = React.useRef(false);

  React.useEffect(() => {
    if (startupCheckStarted.current || !updater.autoUpdate) return;
    if (import.meta.env.DEV || !("__TAURI_INTERNALS__" in window)) return;
    startupCheckStarted.current = true;
    void updater.checkForUpdate();
  }, [updater.autoUpdate, updater.checkForUpdate]);

  React.useEffect(() => {
    if (!updater.hasUpdate || !updater.updateInfo) return;
    const skippedVersion = localStorage.getItem("intervox_skipped_update_version");
    if (skippedVersion !== updater.updateInfo.version) {
      setShowUpdateModal(true);
    }
  }, [updater.hasUpdate, updater.updateInfo]);

  const skipUpdate = () => {
    if (updater.updateInfo) {
      localStorage.setItem("intervox_skipped_update_version", updater.updateInfo.version);
    }
    setShowUpdateModal(false);
    updater.dismissUpdate();
  };

  return (
    <div className="flex h-screen overflow-hidden font-mono text-[13px] th-text-2 antialiased th-bg-app relative">
      {/* Cyberpunk Floating Toast Notification */}
      {toast && (
        <div className="absolute top-6 right-6 z-[9999] animate-fade-in pointer-events-none">
          <div
            className={`border px-4 py-3 rounded-sm shadow-2xl flex items-center gap-3 backdrop-blur-md ${
              toast.type === "success"
                ? "border-emerald-500/40 bg-emerald-950/80 text-emerald-400 border-glow"
                : toast.type === "error"
                ? "border-red-500/40 bg-red-950/80 text-red-400 border-glow"
                : "border-cyan-500/40 bg-cyan-950/80 text-cyan-400 border-glow"
            }`}
          >
            {toast.type === "success" && <CheckCircle className="w-4 h-4 text-emerald-400 animate-pulse" />}
            {toast.type === "error" && <AlertTriangle className="w-4 h-4 text-red-400 animate-bounce" />}
            {toast.type === "info" && <Info className="w-4 h-4 text-cyan-400 animate-pulse" />}
            <span className="font-extrabold uppercase tracking-widest text-[11px] font-mono">
              {toast.message}
            </span>
          </div>
        </div>
      )}

      {/* Collapsible Left Navigation Bar */}
      <Sidebar hasUpdate={updater.hasUpdate} />

      {/* Main Workspace Frame */}
      <div className="flex-1 flex flex-col min-w-0 th-bg-main relative">
        {/* Futuristic layout header accent */}
        <div className="h-[2px] bg-gradient-to-r from-cyan-500 via-purple-500 to-transparent w-full opacity-60 z-20" />

        <main className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          {activePage === "player" && <Player />}
          {activePage === "translate" && <Translate />}
          {activePage === "tasks" && <Tasks />}
          {activePage === "downloader" && <Downloader />}
          {activePage === "settings" && (
            <Settings updater={updater} onShowUpdate={() => setShowUpdateModal(true)} />
          )}
        </main>
      </div>

      {showUpdateModal && updater.updateInfo && (
        <UpdateModal
          open={showUpdateModal}
          updateInfo={updater.updateInfo}
          downloading={updater.downloading}
          progress={updater.progress}
          error={updater.error}
          installed={updater.installed}
          installBlocked={updater.installBlocked}
          onClose={() => {
            if (!updater.downloading && !updater.installed) {
              setShowUpdateModal(false);
            }
          }}
          onSkip={skipUpdate}
          onInstall={() => void updater.startInstall()}
          onRelaunch={() => void updater.doRelaunch()}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <IntervoxProvider>
      <IntervoxContent />
    </IntervoxProvider>
  );
}
