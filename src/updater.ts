import { useCallback, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export const UPDATE_RUNTIME_UNAVAILABLE = "update-runtime-unavailable";
export const UPDATE_INSTALL_BLOCKED = "update-install-blocked";

export interface UpdateInfo {
  version: string;
  notes: string;
  date: string;
}

export interface UseUpdaterReturn {
  hasUpdate: boolean;
  updateInfo: UpdateInfo | null;
  checking: boolean;
  lastCheckCompleted: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
  installed: boolean;
  installBlocked: boolean;
  autoUpdate: boolean;
  setAutoUpdate: (enabled: boolean) => void;
  checkForUpdate: () => Promise<void>;
  startInstall: () => Promise<void>;
  doRelaunch: () => Promise<void>;
  dismissUpdate: () => void;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useUpdater({ installBlocked }: { installBlocked: boolean }): UseUpdaterReturn {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckCompleted, setLastCheckCompleted] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [autoUpdate, setAutoUpdateState] = useState(() => {
    try {
      const saved = localStorage.getItem("intervox_auto_update");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  const setAutoUpdate = useCallback((enabled: boolean) => {
    setAutoUpdateState(enabled);
    try {
      localStorage.setItem("intervox_auto_update", String(enabled));
    } catch {}
  }, []);

  const checkForUpdate = useCallback(async () => {
    if (!isTauriRuntime() || import.meta.env.DEV) {
      setError(UPDATE_RUNTIME_UNAVAILABLE);
      setLastCheckCompleted(true);
      return;
    }

    setChecking(true);
    setLastCheckCompleted(false);
    setError(null);
    try {
      const update = await check({ timeout: 30_000 });
      if (update?.available) {
        setHasUpdate(true);
        setPendingUpdate(update);
        setUpdateInfo({
          version: update.version,
          notes: update.body ?? "",
          date: update.date ?? "",
        });
      } else {
        setHasUpdate(false);
        setPendingUpdate(null);
        setUpdateInfo(null);
      }
    } catch (updateError) {
      setError(String(updateError));
    } finally {
      setChecking(false);
      setLastCheckCompleted(true);
    }
  }, []);

  const startInstall = useCallback(async () => {
    if (installBlocked) {
      setError(UPDATE_INSTALL_BLOCKED);
      return;
    }
    if (!pendingUpdate) return;

    setDownloading(true);
    setInstalled(false);
    setProgress(0);
    setError(null);
    let downloaded = 0;
    let total = 0;

    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : -1);
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setProgress(100);
      setInstalled(true);
      setDownloading(false);
    } catch (updateError) {
      setError(String(updateError));
      setDownloading(false);
    }
  }, [installBlocked, pendingUpdate]);

  const doRelaunch = useCallback(async () => {
    await relaunch();
  }, []);

  const dismissUpdate = useCallback(() => {
    if (downloading) return;
    setHasUpdate(false);
    setUpdateInfo(null);
    setPendingUpdate(null);
    setInstalled(false);
    setProgress(0);
    setError(null);
  }, [downloading]);

  return {
    hasUpdate,
    updateInfo,
    checking,
    lastCheckCompleted,
    downloading,
    progress,
    error,
    installed,
    installBlocked,
    autoUpdate,
    setAutoUpdate,
    checkForUpdate,
    startInstall,
    doRelaunch,
    dismissUpdate,
  };
}
