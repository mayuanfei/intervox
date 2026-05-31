import React, { useRef, useState, useEffect } from "react";
import {
  Download,
  History,
  Languages,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  FolderOpen,
  ShieldCheck,
  FileVideo,
  Plus,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export function Player() {
  const {
    mediaUrl,
    setMediaUrl,
    activeMediaInput,
    mediaInputMode,
    setMediaInputMode,
    setLocalMediaPath,
    transcript,
    translation,
    startFullPipeline,
    showToast,
  } = useIntervox();

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [videoResolution, setVideoResolution] = useState("");

  // Resolve media source path safely
  useEffect(() => {
    let isCurrent = true;

    if (!activeMediaInput) {
      setMediaSrc("");
      setPlayerError(null);
      setIsPreparingPlayback(false);
      setVideoResolution("");
      return;
    }

    setVideoResolution("");
    if (mediaInputMode === "public_url") {
      setMediaSrc(activeMediaInput);
      setPlayerError(null);
      setIsPreparingPlayback(false);
      return;
    }

    const resolveLocalPath = async () => {
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        try {
          if (activeMediaInput.startsWith("/") || activeMediaInput.includes(":/") || activeMediaInput.includes(":\\")) {
            setIsPreparingPlayback(true);
            const playablePath = await invoke<string>("prepare_video_for_playback", { inputPath: activeMediaInput });
            if (!isCurrent) return;
            const converted = convertFileSrc(playablePath);
            setMediaSrc(converted);
            setPlayerError(null);
          } else {
            setMediaSrc("");
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
        setMediaSrc("");
        setIsPreparingPlayback(false);
      }
    };

    resolveLocalPath();

    return () => {
      isCurrent = false;
    };
  }, [activeMediaInput, mediaInputMode]);

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
    if (isNaN(seconds)) return "00:00:00";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, "0")}:${mins
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

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
      setLocalMediaPath(file.name);
      setMediaInputMode("local_file");
      setMediaSrc(URL.createObjectURL(file));
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

  // Metadata properties
  const mediaExtension = activeMediaInput.split(".").pop()?.toUpperCase() || "VIDEO";
  const isAudioFile = /\.(mp3|wav|m4a|flac)$/i.test(activeMediaInput);
  const metadata = {
    format: isAudioFile ? `${mediaExtension} / AUDIO` : `${mediaExtension} / AUTO`,
    resolution: isAudioFile ? "N/A (Audio)" : videoResolution || "N/A",
    audioTracks: "AUTO",
    size: activeMediaInput ? "LOADED" : "0.0 GB",
  };

  const handleDownload = () => {
    if (!mediaUrl) return;
    showToast(`Downie 下载队列已加入：${mediaUrl}`, "info");
  };

  const toggleFullscreen = () => {
    if (!playerContainerRef.current) return;
    if (!document.fullscreenElement) {
      playerContainerRef.current.requestFullscreen().catch((err) => {
        console.error("Error enabling fullscreen:", err);
      });
    } else {
      document.exitFullscreen();
    }
  };

  // Compile transcription segments with translated text matching segment ID
  const displaySegments = transcript?.segments.map((seg) => {
    const transSeg = translation?.segments.find((t) => t.id === seg.id);
    return {
      id: seg.id,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      source_text: seg.text,
      translated_text: transSeg ? transSeg.translated_text : "",
    };
  }) || [
    {
      id: "seg_1",
      start_ms: 0,
      end_ms: 5000,
      source_text: "Initiating sequence alpha.",
      translated_text: "正在启动 alpha 序列 / アルファシーケンスを開始します。",
    },
    {
      id: "seg_2",
      start_ms: 5000,
      end_ms: 15000,
      source_text: "Systems nominal. Awaiting command.",
      translated_text: "系统正常。等待命令 / 系统正常。コマンドを待机中。",
    },
  ];

  // Auto detect current segment ID based on video playback currentTime
  const currentMs = currentTime * 1000;
  const activeSegment = displaySegments.find(
    (seg) => currentMs >= seg.start_ms && currentMs <= seg.end_ms
  );
  const activeSegmentId = activeSegment ? activeSegment.id : "";

  // Auto-scroll transcript container to active segment
  useEffect(() => {
    if (!activeSegmentId || !transcriptContainerRef.current) return;
    const activeEl = document.getElementById(`seg-item-${activeSegmentId}`);
    if (activeEl) {
      activeEl.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeSegmentId]);

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

      {/* Top Search & Download Control Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-[#0a101f] border th-border p-3 rounded-sm">
        <div className="flex-1 min-w-[280px] flex items-center gap-2 border th-border bg-black/40 px-3 py-1.5 relative">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
          <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider select-none shrink-0 border-r th-border pr-2 mr-1">
            PARSING_READY
          </span>
          <input
            type="text"
            value={mediaUrl}
            onChange={(e) => setMediaUrl(e.target.value)}
            placeholder="Paste video URL (YouTube, Twitter, Bilibili...)"
            className="flex-1 bg-transparent border-none text-glow text-cyan-400 placeholder-slate-700 focus:outline-none text-[12px] pr-2"
          />
        </div>

        <button
          onClick={handleDownload}
          disabled={!mediaUrl}
          className={`flex items-center gap-1.5 px-4 py-2 text-black font-extrabold tracking-widest text-[11px] uppercase transition-all ${
            mediaUrl
              ? "bg-cyan-400 hover:bg-cyan-300 shadow-md shadow-cyan-500/20"
              : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50"
          }`}
        >
          <Download className="w-3.5 h-3.5" /> DOWNLOAD
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

        <button className="p-2 border th-border hover:bg-cyan-500/10 text-cyan-400 transition-all rounded-sm">
          <History className="w-4 h-4" />
        </button>

        <button
          onClick={startFullPipeline}
          disabled={!activeMediaInput}
          className="flex items-center gap-1.5 px-4 py-2 border border-cyan-500/40 text-cyan-400 font-extrabold tracking-widest text-[11px] hover:bg-cyan-500 hover:text-black transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Languages className="w-3.5 h-3.5" /> NEW TRANSLATION
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
            className={`aspect-video bg-black border rounded-sm relative overflow-hidden flex flex-col justify-between group shadow-lg transition-colors ${
              isDragActive ? "border-cyan-400 bg-cyan-500/5" : "th-border"
            }`}
          >
            {/* Real HTML Video element */}
            {mediaSrc ? (
              <video
                ref={videoRef}
                src={mediaSrc}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={handleVideoEnded}
                onError={handleVideoError}
                onContextMenu={(e) => e.preventDefault()}
                className="w-full h-full object-contain z-10"
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
                  正在将 AV1、H.265 或 MKV 视频转换为播放器兼容的 H.264 预览。首次打开较大的 4K 文件需要等待一段时间。
                </p>
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
                  max={duration || 100}
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
                    {formatTime(currentTime)} <span className="text-slate-700">/</span> {formatTime(duration)}
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

                  <button onClick={toggleFullscreen} className="hover:text-cyan-400 transition-colors">
                    <Maximize2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Info panels */}
        <div className="space-y-4">
          {/* Analysis Active status panel */}
          <div className="border th-border th-bg-card p-4 rounded-sm flex items-center justify-between border-l-2 border-l-cyan-400">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span>
              <span className="font-extrabold th-text tracking-wide text-xs uppercase text-glow text-cyan-400">
                ANALYSIS_ACTIVE
              </span>
            </div>
            <span className="text-[10px] text-cyan-400/80 font-bold uppercase tracking-wider">
              NODE_09 _
            </span>
          </div>

          {/* Source Metadata Card */}
          <div className="border th-border th-bg-card p-4 space-y-3 rounded-sm">
            <div className="border-b th-border pb-1.5 flex justify-between items-center text-[10px] font-bold text-slate-500">
              <span className="uppercase">SOURCE_METADATA</span>
              <ShieldCheck className="w-3.5 h-3.5 text-cyan-400/60" />
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="space-y-0.5">
                <span className="th-text-muted text-[10px] uppercase font-bold">
                  FORMAT
                </span>
                <span className="th-text font-bold block">{metadata.format}</span>
              </div>
              <div className="space-y-0.5">
                <span className="th-text-muted text-[10px] uppercase font-bold">
                  RESOLUTION
                </span>
                <span className="th-text font-bold block">{metadata.resolution}</span>
              </div>
              <div className="space-y-0.5">
                <span className="th-text-muted text-[10px] uppercase font-bold">
                  AUDIO_TRACKS
                </span>
                <span className="th-text font-bold block">{metadata.audioTracks}</span>
              </div>
              <div className="space-y-0.5">
                <span className="th-text-muted text-[10px] uppercase font-bold">
                  SIZE
                </span>
                <span className="th-text font-bold block">{metadata.size}</span>
              </div>
            </div>
          </div>

          {/* Live Transcript / Subtitle Sync Card */}
          <div className="border th-border th-bg-card p-4 space-y-3 rounded-sm flex flex-col justify-between h-[230px]">
            <div className="border-b th-border pb-1.5 flex justify-between items-center text-[10px] font-bold text-slate-500">
              <span className="uppercase">LIVE_TRANSCRIPT</span>
              <div className="flex gap-1">
                <span className="bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-1 py-0.2 rounded text-[8px]">
                  EN
                </span>
                <span className="text-[8px] self-center">→</span>
                <span className="bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1 py-0.2 rounded text-[8px]">
                  ZH
                </span>
              </div>
            </div>

            {/* Scrollable list of syncing subtitles */}
            <div
              ref={transcriptContainerRef}
              className="flex-1 space-y-3 overflow-y-auto pr-1 scrollbar-thin"
            >
              {displaySegments.map((seg) => {
                const isActive = seg.id === activeSegmentId;
                return (
                  <div
                    key={seg.id}
                    id={`seg-item-${seg.id}`}
                    className={`p-2 transition-all rounded-sm border ${
                      isActive
                        ? "border-cyan-500/40 bg-cyan-500/5 border-glow text-cyan-100"
                        : "border-transparent th-text-muted"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[9px] font-bold text-cyan-400/80 mb-0.5">
                      <span>{formatTime(Math.floor(seg.start_ms / 1000))}</span>
                    </div>
                    <p className="font-semibold text-xs leading-normal">{seg.source_text}</p>
                    {seg.translated_text && (
                      <p className="text-[11px] text-purple-400 font-medium leading-relaxed mt-1">
                        {seg.translated_text}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
