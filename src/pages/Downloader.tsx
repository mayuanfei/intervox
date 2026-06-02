import React from "react";
import {
  Captions,
  Clipboard,
  Download as DownloadIcon,
  ExternalLink,
  Film,
  FolderOpen,
  Loader2,
  Play,
  Search,
  Settings,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useIntervox } from "../hooks/useIntervox";
import { useI18n } from "../i18n";

type DownloadResource = {
  id: string;
  kind: "media" | "subtitle";
  url: string;
  label: string;
  extension: string;
  protocol: string;
  language?: string | null;
  size_bytes?: number | null;
  format_id?: string | null;
  source: string;
};

type DownloadAnalysis = {
  source_url: string;
  title: string;
  extractor: string;
  duration_seconds?: number | null;
  thumbnail_url?: string | null;
  video_options: VideoDownloadOption[];
  subtitle_languages: SubtitleLanguageOption[];
  resources: DownloadResource[];
  subtitles: DownloadResource[];
  message: string;
};

type VideoDownloadOption = {
  id: string;
  label: string;
  height: number;
  extension: string;
  size_bytes?: number | null;
  recommended: boolean;
};

type SubtitleLanguageOption = {
  id: string;
  language: string;
  label: string;
  automatic: boolean;
};

type DownloadProgress = {
  resource_id: string;
  file_name: string;
  stage: string;
  downloaded_bytes: number;
  total_bytes?: number | null;
  progress: number;
  eta_seconds?: number | null;
  speed_bytes_per_second?: number | null;
};

type DownloadResult = {
  resource_id: string;
  path: string;
  size_bytes: number;
  subtitle_paths?: string[];
  warnings?: string[];
};

const YT_DLP_DOWNLOAD_ID = "yt-dlp-video";
const DOWNLOADER_STATE_KEY = "intervox-downloader-state";

const isDesktopApp = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function formatBytes(value?: number | null) {
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(value?: number | null) {
  if (!value) return "";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatEta(value?: number | null) {
  if (value === null || value === undefined) return "";
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function readSavedDownloaderState() {
  if (typeof window === "undefined") {
    return { url: "", analysis: null as DownloadAnalysis | null };
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(DOWNLOADER_STATE_KEY) ?? "{}");
    const analysis = saved.analysis
      ? {
          ...saved.analysis,
          video_options: saved.analysis.video_options ?? [],
          subtitle_languages: saved.analysis.subtitle_languages ?? [],
        }
      : null;
    return { url: typeof saved.url === "string" ? saved.url : "", analysis };
  } catch {
    return { url: "", analysis: null as DownloadAnalysis | null };
  }
}

export function Downloader() {
  const {
    outputDir,
    setActivePage,
    setMediaInputMode,
    setMediaUrl,
    showToast,
  } = useIntervox();
  const { t } = useI18n();
  const savedState = React.useMemo(readSavedDownloaderState, []);
  const [url, setUrl] = React.useState(savedState.url);
  const [analysis, setAnalysis] = React.useState<DownloadAnalysis | null>(savedState.analysis);
  const [error, setError] = React.useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = React.useState(false);
  const [activeDownloadId, setActiveDownloadId] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState<DownloadProgress | null>(null);
  const [completedDownloads, setCompletedDownloads] = React.useState<Record<string, DownloadResult>>({});
  const [selectedQualityHeight, setSelectedQualityHeight] = React.useState<number | null>(null);
  const [selectedSubtitleId, setSelectedSubtitleId] = React.useState("");

  React.useEffect(() => {
    if (!isDesktopApp()) return;
    let isMounted = true;
    let unlisten: (() => void) | null = null;
    void listen<DownloadProgress>("download-progress", (event) => {
      if (!isMounted) return;
      setDownloadProgress(event.payload);
    }).then((listener) => {
      if (isMounted) unlisten = listener;
      else listener();
    });
    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, []);

  React.useEffect(() => {
    sessionStorage.setItem(DOWNLOADER_STATE_KEY, JSON.stringify({ url, analysis }));
  }, [analysis, url]);

  React.useEffect(() => {
    if (!analysis || analysis.extractor !== "yt-dlp") return;
    setSelectedQualityHeight((current) => {
      if (analysis.video_options.some((option) => option.height === current)) return current;
      return analysis.video_options.find((option) => option.recommended)?.height
        ?? analysis.video_options[0]?.height
        ?? null;
    });
    setSelectedSubtitleId((current) => (
      analysis.subtitle_languages.some((option) => option.id === current) ? current : ""
    ));
  }, [analysis]);

  const handleAnalyze = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    if (!isDesktopApp()) {
      showToast(t("Downloader requires the desktop app."), "info");
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setAnalysis(null);
    try {
      const result = await invoke<DownloadAnalysis>("analyze_download_url", {
        url: trimmedUrl,
      });
      setAnalysis(result);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleYtDlpDownload = async () => {
    if (!analysis) return;
    if (!outputDir.trim()) {
      showToast(t("Configure an output directory before downloading."), "info");
      setActivePage("settings");
      return;
    }

    const selectedSubtitle = analysis.subtitle_languages.find(
      (option) => option.id === selectedSubtitleId,
    );
    setActiveDownloadId(YT_DLP_DOWNLOAD_ID);
    setDownloadProgress({
      resource_id: YT_DLP_DOWNLOAD_ID,
      file_name: "",
      stage: "muxing",
      downloaded_bytes: 0,
      total_bytes: null,
      progress: 0,
    });
    try {
      const result = await invoke<DownloadResult>("download_page_with_yt_dlp", {
        request: {
          source_url: analysis.source_url,
          output_dir: outputDir.trim(),
          title: analysis.title,
          quality_height: selectedQualityHeight,
          subtitle_language: selectedSubtitle?.language ?? null,
          subtitle_automatic: selectedSubtitle?.automatic ?? false,
        },
      });
      setCompletedDownloads((current) => ({ ...current, [YT_DLP_DOWNLOAD_ID]: result }));
      showToast(
        result.warnings?.length ? t("Video downloaded, but subtitles could not be downloaded.") : t("Download completed."),
        result.warnings?.length ? "info" : "success",
      );
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setActiveDownloadId(null);
    }
  };

  const handleDownload = async (resource: DownloadResource) => {
    if (!analysis) return;
    if (!outputDir.trim()) {
      showToast(t("Configure an output directory before downloading."), "info");
      setActivePage("settings");
      return;
    }

    setActiveDownloadId(resource.id);
    setDownloadProgress({
      resource_id: resource.id,
      file_name: "",
      stage: "started",
      downloaded_bytes: 0,
      total_bytes: resource.size_bytes,
      progress: 0,
    });
    try {
      const result = await invoke<DownloadResult>("download_remote_resource", {
        request: {
          source_url: analysis.source_url,
          output_dir: outputDir.trim(),
          resource,
          title: analysis.title,
        },
      });
      setCompletedDownloads((current) => ({ ...current, [resource.id]: result }));
      showToast(t("Download completed."), "success");
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setActiveDownloadId(null);
    }
  };

  const handleCopy = async (resourceUrl: string) => {
    try {
      await navigator.clipboard.writeText(resourceUrl);
      showToast(t("URL copied."), "success");
    } catch {
      showToast(t("Unable to copy URL."), "error");
    }
  };

  const handlePlay = (resourceUrl: string) => {
    setMediaUrl(resourceUrl);
    setMediaInputMode("public_url");
    setActivePage("player");
  };

  const handleReveal = async (path: string) => {
    try {
      await invoke("reveal_in_finder", { path });
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const renderResourceList = (
    resources: DownloadResource[],
    emptyMessage: string,
    allowPlayback: boolean,
  ) => {
    if (resources.length === 0) {
      return <div className="py-8 text-center text-[11px] th-text-muted">{emptyMessage}</div>;
    }

    return (
      <div className="space-y-3">
        {resources.map((resource) => {
          const isDownloading = activeDownloadId === resource.id;
          const result = completedDownloads[resource.id];
          const progress = isDownloading ? downloadProgress : null;
          return (
            <div key={resource.id} className="border th-border bg-black/20 p-3.5 rounded-sm space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold th-text text-xs">{resource.label}</span>
                    <span className="px-1.5 py-0.5 border border-cyan-500/20 bg-cyan-500/5 text-cyan-400 text-[9px] uppercase rounded">
                      {resource.protocol}
                    </span>
                    {resource.size_bytes ? (
                      <span className="text-[10px] th-text-muted">{formatBytes(resource.size_bytes)}</span>
                    ) : null}
                  </div>
                  <p className="text-[10px] th-text-muted truncate" title={resource.url}>
                    {resource.url}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleCopy(resource.url)}
                    className="w-8 h-8 rounded border th-border flex items-center justify-center th-text-3 hover:text-cyan-400 hover:border-cyan-500/40 transition-all"
                    title={t("COPY URL")}
                  >
                    <Clipboard className="w-3.5 h-3.5" />
                  </button>
                  {allowPlayback && (
                    <button
                      onClick={() => handlePlay(resource.url)}
                      className="w-8 h-8 rounded border th-border flex items-center justify-center th-text-3 hover:text-cyan-400 hover:border-cyan-500/40 transition-all"
                      title={t("PLAY URL")}
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                    </button>
                  )}
                  {result ? (
                    <button
                      onClick={() => handleReveal(result.path)}
                      className="w-8 h-8 rounded border border-emerald-500/30 flex items-center justify-center text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all"
                      title={t("Reveal in Finder")}
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleDownload(resource)}
                      disabled={activeDownloadId !== null}
                      className="w-8 h-8 rounded border border-cyan-500/30 flex items-center justify-center text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      title={t("DOWNLOAD")}
                    >
                      {isDownloading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <DownloadIcon className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {progress && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] th-text-muted">
                    <span>
                      {progress.stage === "muxing" ? t("Downloading stream with FFmpeg...") : t("DOWNLOADING")}
                    </span>
                    <span>
                      {progress.total_bytes
                        ? `${Math.round(progress.progress * 100)}% · ${formatBytes(progress.downloaded_bytes)} / ${formatBytes(progress.total_bytes)}`
                        : formatBytes(progress.downloaded_bytes)}
                    </span>
                  </div>
                  <div className="h-1 bg-slate-800 overflow-hidden rounded-full">
                    {progress.total_bytes ? (
                      <div
                        className="h-full bg-cyan-400 transition-all"
                        style={{ width: `${progress.progress * 100}%` }}
                      />
                    ) : (
                      <div className="h-full w-1/3 bg-cyan-400 progress-indeterminate" />
                    )}
                  </div>
                </div>
              )}

              {result && (
                <div className="text-[10px] text-emerald-400 break-all">
                  {t("Downloaded")}: {result.path} ({formatBytes(result.size_bytes)})
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const ytDlpResult = completedDownloads[YT_DLP_DOWNLOAD_ID];
  const ytDlpProgress = activeDownloadId === YT_DLP_DOWNLOAD_ID ? downloadProgress : null;
  const ytDlpProgressDetail = ytDlpProgress
    ? [
        ytDlpProgress.total_bytes
          ? `${Math.round(ytDlpProgress.progress * 100)}% · ${formatBytes(ytDlpProgress.downloaded_bytes)} / ${formatBytes(ytDlpProgress.total_bytes)}`
          : formatBytes(ytDlpProgress.downloaded_bytes),
        ytDlpProgress.speed_bytes_per_second
          ? `${formatBytes(ytDlpProgress.speed_bytes_per_second)}/s`
          : "",
        ytDlpProgress.eta_seconds !== null && ytDlpProgress.eta_seconds !== undefined
          ? `${t("ETA")} ${formatEta(ytDlpProgress.eta_seconds)}`
          : "",
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <div className="space-y-6 font-mono text-[13px] animate-fade-in">
      <div className="flex items-center justify-between border-b th-border pb-4">
        <div className="flex items-center gap-3">
          <DownloadIcon className="w-6 h-6 text-cyan-400" />
          <div>
            <h2 className="text-xl font-bold th-text tracking-tight">{t("Downloader")}</h2>
            <p className="text-[10px] th-text-muted mt-1">
              {t("Resolve downloadable media and subtitle tracks from a page URL.")}
            </p>
          </div>
        </div>
      </div>

      <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
        <div className="flex items-center gap-2 border-b th-border pb-2">
          <Search className="w-4 h-4 text-cyan-400" />
          <span className="font-bold th-text uppercase tracking-widest text-xs">{t("Page URL")}</span>
        </div>
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleAnalyze();
            }}
            placeholder={t("Paste a video page URL or direct media URL")}
            className="flex-1 px-3 py-2.5 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50"
          />
          <button
            onClick={handleAnalyze}
            disabled={!url.trim() || isAnalyzing}
            className="px-5 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-black font-extrabold rounded-sm transition-all text-xs uppercase tracking-widest whitespace-nowrap flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isAnalyzing ? t("ANALYZING") : t("ANALYZE")}
          </button>
        </div>
        <p className="text-[10px] th-text-muted leading-relaxed">
          {t("Use only for content you are authorized to save. DRM-protected media is not supported.")}
        </p>
        {error && (
          <div className="border border-red-500/30 bg-red-500/5 text-red-400 p-3 text-[11px] break-all">
            {error}
          </div>
        )}
      </div>

      <div className="border th-border th-bg-card p-4 rounded-sm flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest th-text-muted">{t("Output directory")}</div>
          <div className="text-xs th-text break-all">
            {outputDir.trim() ? `${outputDir.replace(/[\\/]+$/, "")}/downloads` : t("Not configured")}
          </div>
        </div>
        <button
          onClick={() => setActivePage("settings")}
          className="flex items-center gap-2 px-3 py-2 border th-border text-cyan-400 hover:bg-cyan-500/10 transition-all text-[11px] uppercase tracking-widest"
        >
          <Settings className="w-3.5 h-3.5" />
          {t("Open settings")}
        </button>
      </div>

      {analysis && (
        <>
          <div className="border th-border th-bg-card p-4 rounded-sm space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold th-text">{analysis.title}</span>
              <span className="text-[10px] th-text-muted">
                {t("Parse engine")}: <span className="text-cyan-400">{analysis.extractor}</span>
              </span>
            </div>
            <p className="text-[11px] th-text-3">{analysis.message}</p>
          </div>

          {analysis.extractor === "yt-dlp" ? (
            <div className="border th-border th-bg-card p-5 rounded-sm space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b th-border pb-3">
                <div className="flex items-center gap-2">
                  <Film className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold th-text uppercase tracking-widest text-xs">
                    {t("Recommended video")}
                  </span>
                </div>
                <span className="text-[10px] th-text-muted">
                  {analysis.video_options.length} {t("qualities")} · {analysis.subtitle_languages.length} {t("subtitle languages")}
                </span>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
                <div className="flex flex-col sm:flex-row gap-4 min-w-0">
                  {analysis.thumbnail_url ? (
                    <img
                      src={analysis.thumbnail_url}
                      alt=""
                      className="w-full sm:w-56 aspect-video object-cover border th-border bg-black/30"
                    />
                  ) : (
                    <div className="w-full sm:w-56 aspect-video border th-border bg-black/30 flex items-center justify-center">
                      <Film className="w-8 h-8 th-text-muted" />
                    </div>
                  )}
                  <div className="space-y-2 min-w-0">
                    <h3 className="font-bold th-text text-base leading-snug">{analysis.title}</h3>
                    <p className="text-[11px] th-text-muted break-all">{analysis.source_url}</p>
                    {analysis.duration_seconds ? (
                      <p className="text-[11px] text-cyan-400">{formatDuration(analysis.duration_seconds)} · MP4</p>
                    ) : null}
                    <p className="text-[11px] th-text-3 leading-relaxed">
                      {t("Video and audio will be downloaded and merged automatically.")}
                      {" "}
                      {t("Selected subtitles will be downloaded beside the video.")}
                      {" "}
                      {t("Interrupted downloads resume when you click download again.")}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="block space-y-1.5">
                    <span className="text-[10px] uppercase tracking-widest th-text-muted">{t("Quality")}</span>
                    <select
                      value={selectedQualityHeight ?? ""}
                      onChange={(event) => setSelectedQualityHeight(event.target.value ? Number(event.target.value) : null)}
                      className="w-full px-3 py-2.5 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50"
                    >
                      {analysis.video_options.map((option) => (
                        <option key={option.id} value={option.height}>
                          {option.label}{option.size_bytes ? ` · ${formatBytes(option.size_bytes)}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-[10px] uppercase tracking-widest th-text-muted">{t("Optional subtitle")}</span>
                    <select
                      value={selectedSubtitleId}
                      onChange={(event) => setSelectedSubtitleId(event.target.value)}
                      className="w-full px-3 py-2.5 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="">{t("No subtitle")}</option>
                      {analysis.subtitle_languages.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>

                  {ytDlpResult ? (
                    <button
                      onClick={() => handleReveal(ytDlpResult.path)}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all font-bold uppercase tracking-widest text-xs"
                    >
                      <FolderOpen className="w-4 h-4" />
                      {t("Reveal in Finder")}
                    </button>
                  ) : (
                    <button
                      onClick={handleYtDlpDownload}
                      disabled={activeDownloadId !== null || analysis.video_options.length === 0}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-cyan-400 hover:bg-cyan-300 text-black transition-all font-extrabold uppercase tracking-widest text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {activeDownloadId === YT_DLP_DOWNLOAD_ID ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <DownloadIcon className="w-4 h-4" />
                      )}
                      {t("Download video")}
                    </button>
                  )}
                </div>
              </div>

              {ytDlpProgress && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] th-text-muted">
                    <span>
                      {ytDlpProgress.stage === "subtitles"
                        ? t("Video downloaded. Trying to download the selected subtitles...")
                        : ytDlpProgress.stage === "downloading"
                          ? t("Downloading video and best audio track...")
                          : ytDlpProgress.stage === "muxing"
                            ? t("Merging video and best audio track...")
                            : t("Preparing video download...")}
                    </span>
                    <span>{ytDlpProgressDetail}</span>
                  </div>
                  <div className="h-1 bg-slate-800 overflow-hidden rounded-full">
                    {ytDlpProgress.total_bytes && ytDlpProgress.stage === "downloading" ? (
                      <div
                        className="h-full bg-cyan-400 transition-all"
                        style={{ width: `${ytDlpProgress.progress * 100}%` }}
                      />
                    ) : (
                      <div className="h-full w-1/3 bg-cyan-400 progress-indeterminate" />
                    )}
                  </div>
                </div>
              )}

              {ytDlpResult && (
                <div className="space-y-1 text-[10px] text-emerald-400 break-all">
                  <div>{t("Downloaded")}: {ytDlpResult.path} ({formatBytes(ytDlpResult.size_bytes)})</div>
                  {(ytDlpResult.subtitle_paths ?? []).map((path) => (
                    <div key={path}>{t("Downloaded subtitles")}: {path}</div>
                  ))}
                  {(ytDlpResult.warnings ?? []).map((warning) => (
                    <div key={warning} className="text-amber-400">{warning}</div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
                <div className="flex items-center gap-2 border-b th-border pb-2">
                  <Film className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold th-text uppercase tracking-widest text-xs">
                    {t("Media resources")} ({analysis.resources.length})
                  </span>
                </div>
                {renderResourceList(analysis.resources, t("No media resources discovered."), true)}
              </div>

              <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
                <div className="flex items-center gap-2 border-b th-border pb-2">
                  <Captions className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold th-text uppercase tracking-widest text-xs">
                    {t("Subtitle tracks")} ({analysis.subtitles.length})
                  </span>
                </div>
                {renderResourceList(analysis.subtitles, t("No subtitle tracks discovered."), false)}
              </div>
            </div>
          )}
        </>
      )}

      {!analysis && !isAnalyzing && (
        <div className="border th-border bg-black/20 p-10 rounded-sm text-center space-y-3">
          <ExternalLink className="w-8 h-8 th-text-muted mx-auto" />
          <p className="font-bold th-text text-xs uppercase tracking-widest">{t("Ready to inspect a URL")}</p>
          <p className="text-[10px] th-text-muted max-w-2xl mx-auto leading-relaxed">
            {t("Install yt-dlp to improve parsing for dynamic video sites.")}
          </p>
        </div>
      )}
    </div>
  );
}
