import { Download, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import {
  UPDATE_INSTALL_BLOCKED,
  UPDATE_RUNTIME_UNAVAILABLE,
  type UpdateInfo,
} from "../updater";

interface UpdateModalProps {
  open: boolean;
  updateInfo: UpdateInfo;
  downloading: boolean;
  progress: number;
  error: string | null;
  installed: boolean;
  installBlocked: boolean;
  onClose: () => void;
  onSkip: () => void;
  onInstall: () => void;
  onRelaunch: () => void;
}

function translatedError(error: string, t: (key: TranslationKey) => string) {
  if (error === UPDATE_RUNTIME_UNAVAILABLE) {
    return t("Update checks are only available in the installed desktop app.");
  }
  if (error === UPDATE_INSTALL_BLOCKED) {
    return t("Finish or cancel all queued and running tasks before installing an update.");
  }
  return error;
}

export function UpdateModal({
  open,
  updateInfo,
  downloading,
  progress,
  error,
  installed,
  installBlocked,
  onClose,
  onSkip,
  onInstall,
  onRelaunch,
}: UpdateModalProps) {
  const { t } = useI18n();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-sm border border-cyan-500/30 th-bg-card shadow-2xl shadow-cyan-950/60">
        <div className="flex items-center justify-between border-b th-border bg-cyan-500/5 px-5 py-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-cyan-400" />
            <div>
              <h2 className="font-bold tracking-wide th-text">
                {t("Intervox update available")} · v{updateInfo.version}
              </h2>
              {updateInfo.date && (
                <p className="mt-0.5 text-[10px] uppercase tracking-wider th-text-muted">
                  {updateInfo.date}
                </p>
              )}
            </div>
          </div>
          {!downloading && !installed && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-transparent p-1.5 th-text-muted transition-colors hover:border-cyan-500/30 hover:text-cyan-400"
              aria-label={t("Close update dialog")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="max-h-[45vh] overflow-y-auto px-5 py-4 scrollbar-thin">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400">
            {t("Release notes")}
          </p>
          {updateInfo.notes ? (
            <div className="whitespace-pre-wrap text-xs leading-6 th-text-2">{updateInfo.notes}</div>
          ) : (
            <p className="text-xs italic th-text-muted">{t("No changelog provided.")}</p>
          )}
        </div>

        {installBlocked && !installed && (
          <div className="mx-5 mb-4 border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {t("Finish or cancel all queued and running tasks before installing an update.")}
          </div>
        )}

        {(downloading || installed) && (
          <div className="px-5 pb-4">
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full bg-cyan-400 transition-all duration-300 ${progress === -1 ? "w-full animate-pulse" : ""}`}
                style={{ width: progress === -1 ? "100%" : `${progress}%` }}
              />
            </div>
            <p className="mt-2 text-center text-[11px] th-text-muted">
              {installed
                ? t("Update installed. Restart Intervox to finish.")
                : progress === -1
                  ? t("Downloading update...")
                  : `${t("Downloading update...")} ${progress}%`}
            </p>
          </div>
        )}

        {error && (
          <div className="mx-5 mb-4 border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {translatedError(error, t)}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t th-border bg-black/20 px-5 py-4">
          {!downloading && !installed ? (
            <button
              type="button"
              onClick={onSkip}
              className="border th-border px-3 py-2 text-[11px] font-bold uppercase tracking-wide th-text-muted transition-colors hover:border-slate-500 hover:th-text"
            >
              {t("Skip this version")}
            </button>
          ) : (
            <span />
          )}

          {installed ? (
            <button
              type="button"
              onClick={onRelaunch}
              className="flex items-center gap-2 bg-cyan-500 px-4 py-2 text-[11px] font-extrabold uppercase tracking-wide text-black transition-colors hover:bg-cyan-300"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("Restart now")}
            </button>
          ) : (
            <button
              type="button"
              onClick={onInstall}
              disabled={downloading || installBlocked}
              className="flex items-center gap-2 bg-cyan-500 px-4 py-2 text-[11px] font-extrabold uppercase tracking-wide text-black transition-colors hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              {downloading ? t("Downloading update...") : t("Download and install")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
