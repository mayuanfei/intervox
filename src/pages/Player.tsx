import React, { useRef, useState, useEffect } from "react";
import {
  History,
  Languages,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  FolderOpen,
  FileVideo,
  Trash2,
  Plus,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isAbsoluteFilesystemPath = (value: string) =>
  value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);

type PlaybackPreviewProgress = {
  stage: string;
  input_path: string;
  processed_ms: number;
  total_ms: number;
  progress: number;
  message?: string;
};

export function Player() {
  const {
    mediaUrl,
    setMediaUrl,
    activeMediaInput,
    mediaInputMode,
    setMediaInputMode,
    setLocalMediaPath,
    outputDir,
    playbackHistory,
    addPlaybackHistoryItem,
    deletePlaybackHistoryItem,
    clearPlaybackHistory,
  } = useIntervox();

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const browserLocalPreviewRef = useRef<{ input: string; url: string } | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [mediaSrc, setMediaSrc] = useState("");
  const [isDragActive, setIsDragActive] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isPreparingPlayback, setIsPreparingPlayback] = useState(false);
  const [playbackPreviewProgress, setPlaybackPreviewProgress] = useState<PlaybackPreviewProgress | null>(null);
  const [isPlayerExpanded, setIsPlayerExpanded] = useState(false);
  const [videoResolution, setVideoResolution] = useState("");

  useEffect(() => {
    return () => {
      if (browserLocalPreviewRef.current) {
        URL.revokeObjectURL(browserLocalPreviewRef.current.url);
      }
    };
  }, []);

  useEffect(() => {
    if (!isPlayerExpanded) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsPlayerExpanded(false);
        void syncFullscreenMode(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      void syncFullscreenMode(false);
    };
  }, [isPlayerExpanded]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let isMounted = true;
    let unlisten: (() => void) | null = null;
    void listen<PlaybackPreviewProgress>("playback-preview-progress", (event) => {
      if (!isMounted || event.payload.input_path !== activeMediaInput) return;
      setPlaybackPreviewProgress(event.payload);
      if (event.payload.stage === "failed") {
        setPlayerError(event.payload.message || "播放器后台预览转换失败。");
        setIsPreparingPlayback(false);
      }
    }).then((listener) => {
      if (isMounted) unlisten = listener;
      else listener();
    });

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [activeMediaInput]);

  // Resolve media source path safely
  useEffect(() => {
    let isCurrent = true;
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    if (!activeMediaInput) {
      setMediaSrc("");
      setPlayerError(null);
      setIsPreparingPlayback(false);
      setPlaybackPreviewProgress(null);
      setVideoResolution("");
      return;
    }

    setVideoResolution("");
    if (mediaInputMode === "public_url") {
      if (!isTauri && isAbsoluteFilesystemPath(activeMediaInput)) {
        setMediaSrc("");
        setPlayerError("浏览器预览无法直接读取本机绝对路径。请点击 OPEN FILE 重新选择文件，或使用桌面应用。");
        setIsPreparingPlayback(false);
        setPlaybackPreviewProgress(null);
        return;
      }
      setMediaSrc(activeMediaInput);
      setPlayerError(null);
      setIsPreparingPlayback(false);
      setPlaybackPreviewProgress(null);
      return;
    }

    const resolveLocalPath = async () => {
      if (isTauri) {
        try {
          if (isAbsoluteFilesystemPath(activeMediaInput)) {
            setPlaybackPreviewProgress(null);
            setIsPreparingPlayback(true);
            const playableUrl = await invoke<string>("prepare_video_for_playback", {
              inputPath: activeMediaInput,
              outputDir: outputDir.trim() || null,
            });
            if (!isCurrent) return;
            setMediaSrc(playableUrl);
            setPlayerError(null);
          } else {
            setMediaSrc("");
            setPlayerError("请选择有效的本地视频文件。");
          }
        } catch (e: any) {
          console.error("Failed to prepare file for playback:", e);
          if (isCurrent) {
            setPlayerError(e.toString() || "无法转换该媒体以供播放。");
            setMediaSrc("");
          }
        } finally {
          if (isCurrent) {
            setIsPreparingPlayback(false);
          }
        }
      } else {
        const preview = browserLocalPreviewRef.current;
        if (preview?.input === activeMediaInput) {
          setMediaSrc(preview.url);
          setPlayerError(null);
        } else {
          setMediaSrc("");
          setPlayerError("浏览器预览无法直接读取本机绝对路径。请点击 OPEN FILE 重新选择文件，或使用桌面应用。");
        }
        setIsPreparingPlayback(false);
        setPlaybackPreviewProgress(null);
      }
    };

    resolveLocalPath();

    return () => {
      isCurrent = false;
      if (videoRef.current) {
        videoRef.current.pause();
      }
      setMediaSrc("");
    };
  }, [activeMediaInput, mediaInputMode, outputDir]);

  // Handle Play / Pause toggles
  useEffect(() => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.play().catch((err) => {
        console.error("Playback error:", err);
        setIsPlaying(false);
      });
    } else {
      videoRef.current.pause();
    }
  }, [isPlaying, mediaSrc]);

  // Adjust volume & mute status
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.volume = volume;
    videoRef.current.muted = isMuted;
  }, [volume, isMuted]);

  // Adjust playback speed
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = playbackRate;
  }, [playbackRate, mediaSrc]);

  // Format seconds to HH:MM:SS
  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return "00:00:00";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, "0")}:${mins
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const effectiveDuration =
    Number.isFinite(duration) && duration > 0
      ? duration
      : (playbackPreviewProgress?.total_ms || 0) / 1000;

  // Handle left/right arrow keys for seek (forward/backward 10s)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl instanceof HTMLElement && activeEl.isContentEditable))
      ) {
        return;
      }

      if (!videoRef.current || !mediaSrc) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const newTime = Math.max(0, videoRef.current.currentTime - 10);
        videoRef.current.currentTime = newTime;
        setCurrentTime(newTime);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const maxDuration = videoRef.current.duration || effectiveDuration || 0;
        const newTime = Math.min(maxDuration, videoRef.current.currentTime + 10);
        videoRef.current.currentTime = newTime;
        setCurrentTime(newTime);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mediaSrc, effectiveDuration]);

  const cyclePlaybackRate = () => {
    setPlaybackRate((current) => {
      if (current === 1.0) return 1.5;
      if (current === 1.5) return 2.0;
      return 1.0;
    });
  };

  // Video event handlers
  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    setDuration(videoRef.current.duration);
    setVideoResolution(
      videoRef.current.videoWidth && videoRef.current.videoHeight
        ? `${videoRef.current.videoWidth}×${videoRef.current.videoHeight}`
        : "N/A"
    );
    setPlayerError(null);
  };

  const handleVideoEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleTimelineChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const newTime = parseFloat(e.target.value);
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  // Handle media loading errors (such as unsupported codecs in standard Chromium engine)
  const handleVideoError = () => {
    if (!videoRef.current) return;
    const err = videoRef.current.error;
    let message = "视频播放失败。";
    if (err) {
      switch (err.code) {
        case err.MEDIA_ERR_ABORTED:
          message = "播放被中止。";
          break;
        case err.MEDIA_ERR_NETWORK:
          message = "网络加载错误，请检查链接是否有效。";
          break;
        case err.MEDIA_ERR_DECODE:
          message = "解码错误。可能是该格式或编码在浏览器内核中不被支持（如部分 MKV/H.265 编码视频）。";
          break;
        case err.MEDIA_ERR_SRC_NOT_SUPPORTED:
          message = "不支持的视频格式或路径。";
          break;
      }
    }
    setPlayerError(message);
    setIsPlaying(false);
  };

  // File browser and drag drop selection handler
  const handleFileSelected = async (file: File) => {
    const path = (file as any).path || "";
    
    if (path) {
      setLocalMediaPath(path);
      setMediaInputMode("local_file");
    } else {
      // Fallback for standard browser context (play via object stream URL)
      if (browserLocalPreviewRef.current) {
        URL.revokeObjectURL(browserLocalPreviewRef.current.url);
      }
      const url = URL.createObjectURL(file);
      browserLocalPreviewRef.current = { input: file.name, url };
      setLocalMediaPath(file.name);
      setMediaInputMode("local_file");
      setMediaSrc(url);
      setPlayerError(null);
    }
    
    setIsPlaying(true);
  };

  const handleOpenFileClick = async () => {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      try {
        const filePath = await invoke<string | null>("select_local_file");
        if (filePath) {
          setLocalMediaPath(filePath);
          setMediaInputMode("local_file");
          setIsPlaying(true);
        }
      } catch (e: any) {
        console.error("Failed to select or prepare file:", e);
        setPlayerError(e.toString() || "选择文件失败");
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragActive(true);
  };

  const handleDragLeave = () => {
    setIsDragActive(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  };



  async function syncFullscreenMode(expanded: boolean) {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      try {
        await getCurrentWindow().setSimpleFullscreen(expanded);
      } catch (err) {
        console.error("Error toggling desktop fullscreen:", err);
      }
      return;
    }

    try {
      if (expanded && !document.fullscreenElement) {
        await playerContainerRef.current?.requestFullscreen();
      } else if (!expanded && document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error("Error toggling browser fullscreen:", err);
    }
  }

  const toggleFullscreen = () => {
    const expanded = !isPlayerExpanded;
    setIsPlayerExpanded(expanded);
    void syncFullscreenMode(expanded);
  };

  // Handle playing remote URLs
  const handlePlayUrl = () => {
    if (!mediaUrl.trim()) return;
    setLocalMediaPath("");
    setMediaInputMode("public_url");
    setIsPlaying(true);
  };

  // Record playback history when media loaded
  useEffect(() => {
    if (mediaSrc && activeMediaInput) {
      const name = mediaInputMode === "local_file"
        ? activeMediaInput.substring(activeMediaInput.lastIndexOf("/") + 1) || activeMediaInput
        : activeMediaInput;
      addPlaybackHistoryItem(name, activeMediaInput, mediaInputMode);
    }
  }, [mediaSrc, activeMediaInput, mediaInputMode]);

  // Format historical timestamp
  const formatHistoryTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return "未知时间";
    }
  };

  return (
    <div className="space-y-4 font-mono text-[13px] animate-fade-in">
      {/* Hidden File Picker Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        accept="video/*,audio/*,.rm,.rmvb"
        className="hidden"
      />

      {/* Top Playback Control Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-[#0a101f] border th-border p-3 rounded-sm">
        <div className="flex-1 min-w-[280px] flex items-center gap-2 border th-border bg-black/40 px-3 py-1.5 relative">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
          <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider select-none shrink-0 border-r th-border pr-2 mr-1">
            STREAM_PLAY
          </span>
          <input
            type="text"
            value={mediaUrl}
            onChange={(e) => setMediaUrl(e.target.value)}
            placeholder="Paste video stream URL (mp4, webm, mp3...)"
            className="flex-1 bg-transparent border-none text-glow text-cyan-400 placeholder-slate-700 focus:outline-none text-[12px] pr-2"
          />
        </div>

        <button
          onClick={handlePlayUrl}
          disabled={!mediaUrl.trim()}
          className={`flex items-center gap-1.5 px-4 py-2 text-black font-extrabold tracking-widest text-[11px] uppercase transition-all ${
            mediaUrl.trim()
              ? "bg-cyan-400 hover:bg-cyan-300 shadow-md shadow-cyan-500/20"
              : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50"
          }`}
        >
          <Play className="w-3.5 h-3.5 fill-current" /> PLAY
        </button>

        {/* Open File Button */}
        <button
          onClick={handleOpenFileClick}
          className="px-3 py-2 border th-border text-cyan-400 hover:bg-cyan-500/10 transition-all rounded-sm flex items-center gap-1.5 font-bold text-xs shrink-0"
          title="选择并播放本地视频文件"
        >
          <FolderOpen className="w-4 h-4" />
          <span className="hidden sm:inline">OPEN FILE</span>
        </button>
      </div>

      {/* Main Player & Metadata layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Video Player Box with drag and drop */}
        <div className="lg:col-span-2 space-y-4">
          <div
            ref={playerContainerRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onContextMenu={(e) => e.preventDefault()}
            className={`bg-black overflow-hidden flex flex-col justify-between group shadow-lg transition-colors ${
              isPlayerExpanded
                ? "fixed inset-0 z-[100] w-screen h-screen"
                : "aspect-video relative border rounded-sm"
            } ${
              isDragActive && !isPlayerExpanded ? "border-cyan-400 bg-cyan-500/5" : "th-border"
            }`}
          >
            {/* Real HTML Video element */}
            {mediaSrc ? (
              <video
                ref={videoRef}
                src={mediaSrc}
                autoPlay
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={handleVideoEnded}
                onError={handleVideoError}
                onContextMenu={(e) => e.preventDefault()}
                onClick={() => setIsPlaying(!isPlaying)}
                onDoubleClick={toggleFullscreen}
                className="w-full h-full object-contain z-10 cursor-pointer"
              />
            ) : (
              /* Placeholders if no video is loaded */
              <div
                onClick={handleOpenFileClick}
                className="absolute inset-0 z-0 flex flex-col items-center justify-center cursor-pointer space-y-3"
              >
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900/30 via-black/80 to-black pointer-events-none" />
                <div className="absolute inset-0 z-0 opacity-20 mix-blend-color-dodge pointer-events-none flex items-center justify-center">
                  <svg viewBox="0 0 100 100" className="w-full h-full text-slate-800">
                    <path d="M 0 50 Q 25 15 50 50 T 100 50" fill="none" stroke="currentColor" strokeWidth="0.5" />
                    <line x1="0" y1="80" x2="100" y2="80" stroke="currentColor" strokeWidth="0.1" />
                    <circle cx="50" cy="50" r="2" fill="cyan" />
                  </svg>
                </div>
                
                <div className="w-12 h-12 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 z-10 animate-pulse">
                  <FolderOpen className="w-6 h-6" />
                </div>
                <span className="font-extrabold text-xs th-text uppercase tracking-widest z-10 text-glow">
                  DRAG VIDEO FILE HERE
                </span>
                <span className="text-[10px] th-text-muted z-10">
                  Or click anywhere to choose a file from your device
                </span>
              </div>
            )}

            {/* Drag drop overlay text */}
            {isDragActive && (
              <div className="absolute inset-0 bg-cyan-950/70 backdrop-blur-sm z-30 flex flex-col items-center justify-center space-y-2 pointer-events-none border-2 border-dashed border-cyan-400 m-2">
                <Plus className="w-8 h-8 text-cyan-400 animate-bounce" />
                <span className="font-extrabold text-sm text-cyan-300 tracking-widest text-glow uppercase">
                  Drop video file to play
                </span>
              </div>
            )}

            {isPreparingPlayback && (
              <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-sm z-30 flex flex-col items-center justify-center p-6 text-center space-y-3 m-2 border border-cyan-500/30">
                <span className="w-3 h-3 rounded-full bg-cyan-400 animate-ping" />
                <span className="text-cyan-300 font-bold uppercase tracking-widest text-xs">
                  Preparing Compatible Preview
                </span>
                <p className="text-xs text-cyan-100/80 max-w-[440px] leading-relaxed">
                  {playbackPreviewProgress?.stage === "retrying"
                    ? "硬件编码器暂不可用，正在切换兼容模式生成首个播放片段。"
                    : "正在生成首个兼容播放片段。AV1 或 H.265 视频会边转边播，无需等待整部视频处理完成。"}
                </p>
                {playbackPreviewProgress && playbackPreviewProgress.total_ms > 0 && (
                  <div className="w-full max-w-[440px] space-y-1.5">
                    <div className="h-1 bg-slate-800 overflow-hidden rounded-full">
                      <div
                        className="h-full bg-cyan-400 transition-all duration-300"
                        style={{ width: `${Math.max(2, Math.round(playbackPreviewProgress.progress * 100))}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-cyan-200/70">
                      <span>{Math.round(playbackPreviewProgress.progress * 100)}%</span>
                      <span>
                        {formatTime(playbackPreviewProgress.processed_ms / 1000)}
                        {" / "}
                        {formatTime(playbackPreviewProgress.total_ms / 1000)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Error overlay panel */}
            {playerError && (
              <div className="absolute inset-0 bg-red-950/80 backdrop-blur-sm z-30 flex flex-col items-center justify-center p-6 text-center space-y-3 m-2 border border-red-500/30">
                <span className="text-red-400 font-bold uppercase tracking-widest text-xs">
                  Playback Alert
                </span>
                <p className="text-xs text-red-200 max-w-[400px] leading-relaxed">
                  {playerError}
                </p>
                <button
                  onClick={handleOpenFileClick}
                  className="px-4 py-1.5 bg-red-500/15 border border-red-500/30 text-red-200 text-[11px] font-bold tracking-wider hover:bg-red-500 hover:text-black transition-all"
                >
                  CHOOSE OTHER FILE
                </button>
              </div>
            )}

            {/* Top HUD bar overlay */}
            {mediaSrc && (
              <div className="absolute top-0 left-0 right-0 p-3 bg-gradient-to-b from-black/85 to-transparent flex justify-between items-center z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
                <span className="text-[10px] text-cyan-400 font-bold tracking-widest uppercase">
                  {mediaInputMode === "local_file" ? "LOCAL_PLAYBACK" : "LIVE_STREAM_DUB"}
                </span>
                <span className="text-[10px] th-text-muted">DECIMALS // SYNC_ACTIVE</span>
              </div>
            )}

            {/* Big center play icon if paused and video is loaded */}
            {mediaSrc && !isPlaying && !playerError && (
              <button
                onClick={() => setIsPlaying(true)}
                className="absolute inset-0 m-auto w-14 h-14 rounded-full bg-cyan-400/10 border border-cyan-500/40 text-cyan-400 flex items-center justify-center hover:bg-cyan-500 hover:text-black transition-all z-20 border-glow"
              >
                <Play className="w-6 h-6 ml-1" />
              </button>
            )}

            {/* Bottom HUD video control panel overlay */}
            <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex flex-col gap-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              {/* Timeline Progress Slider */}
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max={effectiveDuration || 100}
                  value={currentTime}
                  onChange={handleTimelineChange}
                  className="w-full accent-cyan-400 h-1 bg-slate-800/80 rounded-lg appearance-none cursor-pointer"
                  disabled={!mediaSrc || !!playerError}
                />
              </div>

              {/* Controls bar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setIsPlaying(!isPlaying)}
                    disabled={!mediaSrc || !!playerError}
                    className="text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                  <span className="text-[11px] th-text font-bold">
                    {formatTime(currentTime)} <span className="text-slate-700">/</span> {formatTime(effectiveDuration)}
                  </span>
                </div>

                <div className="flex items-center gap-4 text-slate-400">
                  {/* Volume Slider & Controls */}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setIsMuted(!isMuted)}
                      className="hover:text-cyan-400 transition-colors"
                    >
                      {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      onChange={(e) => {
                        setVolume(parseFloat(e.target.value));
                        setIsMuted(false);
                      }}
                      className="w-16 h-1 accent-cyan-400 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Playback Rate Toggle */}
                  <button
                    onClick={cyclePlaybackRate}
                    className="hover:text-cyan-400 font-extrabold text-[10px] transition-colors min-w-[34px] text-center border border-slate-700/60 rounded px-1.5 py-0.5 bg-black/30 hover:border-cyan-500/30"
                    title="循环切换播放速度 (1.0x / 1.5x / 2.0x)"
                  >
                    {playbackRate.toFixed(1)}x
                  </button>

                  <button
                    onClick={toggleFullscreen}
                    className="hover:text-cyan-400 transition-colors"
                    title={isPlayerExpanded ? "退出全屏" : "全屏播放"}
                  >
                    {isPlayerExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Playback History Card */}
        <div className="border th-border th-bg-card p-4 rounded-sm flex flex-col h-[400px] lg:h-[500px]">
          <div className="border-b th-border pb-2 flex justify-between items-center mb-3">
            <span className="font-extrabold th-text tracking-wide text-xs uppercase text-glow text-cyan-400">
              PLAYBACK HISTORY // 播放历史记录
            </span>
            {playbackHistory.length > 0 && (
              <button
                onClick={clearPlaybackHistory}
                className="text-[10px] text-red-400 hover:text-red-300 font-bold uppercase tracking-wider transition-colors"
              >
                Clear All
              </button>
            )}
          </div>

          {/* History List */}
          <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
            {playbackHistory.length > 0 ? (
              playbackHistory.map((item) => {
                const isLocal = item.inputMode === "local_file";
                const isCurrentlyPlaying = activeMediaInput === item.url;
                
                return (
                  <div
                    key={item.id}
                    className={`group border p-2 flex items-center justify-between rounded-sm transition-all hover:bg-cyan-500/5 ${
                      isCurrentlyPlaying
                        ? "border-cyan-500/40 bg-cyan-500/5 border-glow"
                        : "border-transparent bg-black/20 hover:border-slate-800"
                    }`}
                  >
                    <div
                      onClick={() => {
                        if (isLocal) {
                          setLocalMediaPath(item.url);
                          setMediaInputMode("local_file");
                          setMediaUrl("");
                        } else {
                          setMediaUrl(item.url);
                          setLocalMediaPath("");
                          setMediaInputMode("public_url");
                        }
                        setIsPlaying(true);
                      }}
                      className="flex items-start gap-2.5 min-w-0 flex-1 cursor-pointer"
                    >
                      {isLocal ? (
                        <FileVideo className={`w-4 h-4 mt-0.5 shrink-0 ${isCurrentlyPlaying ? "text-cyan-400" : "text-slate-500"}`} />
                      ) : (
                        <Languages className={`w-4 h-4 mt-0.5 shrink-0 ${isCurrentlyPlaying ? "text-cyan-400" : "text-slate-500"}`} />
                      )}
                      <div className="min-w-0 flex-1">
                        <span
                          className={`font-semibold text-xs block truncate ${
                            isCurrentlyPlaying ? "text-cyan-400 text-glow" : "th-text"
                          }`}
                          title={item.name}
                        >
                          {item.name}
                        </span>
                        <span className="text-[9px] th-text-muted block mt-0.5 font-medium">
                          {formatHistoryTime(item.timestamp)}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deletePlaybackHistoryItem(item.id);
                      }}
                      className="p-1 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ml-2 shrink-0"
                      title="删除该记录"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-600 space-y-2 py-8">
                <FolderOpen className="w-8 h-8 opacity-40 text-slate-500" />
                <span className="text-[11px] font-bold uppercase tracking-wider block">
                  暂无播放记录
                </span>
                <span className="text-[9px] text-slate-700">
                  打开本地文件或粘贴 URL 播放视频后，历史记录将自动显示在此处。
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
