import React, { createContext, useContext, useState, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeOrFallback } from "../lib/tauri";
import { DEFAULT_ASR_CONFIG } from "../lib/asrOptions";
import type {
  AsrConfig,
  AsrProviderId,
  CredentialValidationResult,
  ExportResult,
  SourceLanguageCode,
  TargetLanguageCode,
  TranscriptDocument,
  TranslationDocument,
  TtsDocument,
  CachedTranscript,
  CachedTranslation,
  CachedTts,
  TtsProviderId,
} from "../types/asr";

export interface PlaybackHistoryItem {
  id: string;
  name: string;
  url: string;
  inputMode: "local_file" | "public_url";
  timestamp: string;
}

export interface IntervoxTask {
  id: string;
  fileName: string;
  mediaUrl: string;
  mediaInputMode: "public_url" | "local_file";
  status: "queued" | "running" | "completed" | "failed";
  stage:
    | "select_video"
    | "extract_audio"
    | "asr"
    | "translate"
    | "tts_clone"
    | "mix_media"
    | "final_output";
  progress: number;
  error?: string | null;
  timestamp: string;
  targetLang: string;
  outputVideoPath?: string;
  duration?: string;
  logLines: string[];
}

interface AsrProgressPayload {
  job_id: string;
  stage: "started" | "completed";
  progress: number;
}

interface AsrFailedPayload {
  job_id: string;
  message: string;
}

interface TranslationProgressPayload {
  stage: "queued" | "started" | "batch_completed" | "completed";
  completed_segments?: number;
  total_segments?: number;
  progress?: number;
}

interface TranslationFailedPayload {
  message: string;
}

interface TtsProgressPayload {
  stage: "started" | "segment_completed" | "completed";
  completed_segments?: number;
  total_segments?: number;
  progress?: number;
}

interface TtsFailedPayload {
  message: string;
}

interface ExportProgressPayload {
  stage: "started" | "completed" | string;
  processed_ms?: number;
  total_ms?: number;
  progress?: number;
}

export type MediaInputMode = "public_url" | "local_file";

interface IntervoxContextType {
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  config: AsrConfig;
  setConfig: React.Dispatch<React.SetStateAction<AsrConfig>>;
  activePage: string;
  setActivePage: (page: string) => void;
  mediaUrl: string;
  setMediaUrl: (url: string) => void;
  mediaInputMode: MediaInputMode;
  setMediaInputMode: (mode: MediaInputMode) => void;
  localMediaPath: string;
  setLocalMediaPath: (path: string) => void;
  credentialDraft: string;
  setCredentialDraft: (draft: string) => void;
  status: CredentialValidationResult | null;
  setStatus: React.Dispatch<React.SetStateAction<CredentialValidationResult | null>>;
  
  // Statuses & Errors
  transcriptionStatus: string | null;
  setTranscriptionStatus: (status: string | null) => void;
  transcriptionError: string | null;
  setTranscriptionError: (error: string | null) => void;
  translationStatus: string | null;
  setTranslationStatus: (status: string | null) => void;
  translationError: string | null;
  setTranslationError: (error: string | null) => void;
  ttsStatus: string | null;
  setTtsStatus: (status: string | null) => void;
  ttsError: string | null;
  setTtsError: (error: string | null) => void;
  exportStatus: string | null;
  setExportStatus: (status: string | null) => void;
  exportError: string | null;
  setExportError: (error: string | null) => void;

  // Documents
  transcript: TranscriptDocument | null;
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptDocument | null>>;
  translation: TranslationDocument | null;
  setTranslation: React.Dispatch<React.SetStateAction<TranslationDocument | null>>;
  tts: TtsDocument | null;
  setTts: React.Dispatch<React.SetStateAction<TtsDocument | null>>;
  exportResult: ExportResult | null;
  setExportResult: React.Dispatch<React.SetStateAction<ExportResult | null>>;

  // Parameters
  synthesisMode: "default" | "clone";
  setSynthesisMode: (mode: "default" | "clone") => void;
  toast: { message: string; type: "success" | "error" | "info" } | null;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
  ttsVoice: string;
  setTtsVoice: (voice: string) => void;
  translationModel: string;
  setTranslationModel: (model: string) => void;
  ttsRate: number;
  setTtsRate: (rate: number) => void;
  outputDir: string;
  setOutputDir: (dir: string) => void;
  replaceOriginalAudio: boolean;
  setReplaceOriginalAudio: (replace: boolean) => void;
  originalAudioVolume: number;
  setOriginalAudioVolume: (volume: number) => void;
  voiceoverVolume: number;
  setVoiceoverVolume: (volume: number) => void;
  showEnglishSubtitles: boolean;
  setShowEnglishSubtitles: (show: boolean) => void;
  showTargetLanguageSubtitles: boolean;
  setShowTargetLanguageSubtitles: (show: boolean) => void;

  // Loading States
  isSavingCredential: boolean;
  isTranscribing: boolean;
  isTranslating: boolean;
  isSynthesizing: boolean;
  isExporting: boolean;

  // Progress Rates
  transcriptionProgress: number | null;
  translationProgress: number | null;

  // Computed Cache properties
  activeMediaInput: string;
  activeAsrCacheKey: string | null;
  activeTranslationCacheKey: string | null;
  cachedTranscript: CachedTranscript | null;
  cachedTranslation: CachedTranslation | null;
  
  // Volcengine Doubao Credential States
  volcCredentialDraft: string;
  setVolcCredentialDraft: (draft: string) => void;
  volcAppIdDraft: string;
  setVolcAppIdDraft: (draft: string) => void;
  volcStatus: CredentialValidationResult | null;
  setVolcStatus: React.Dispatch<React.SetStateAction<CredentialValidationResult | null>>;
  isSavingVolcCredential: boolean;
  saveVolcCredential: () => Promise<void>;
  validateVolcProvider: () => Promise<void>;

  // Deepseek Credential States
  deepseekCredentialDraft: string;
  setDeepseekCredentialDraft: (draft: string) => void;
  deepseekStatus: CredentialValidationResult | null;
  setDeepseekStatus: React.Dispatch<React.SetStateAction<CredentialValidationResult | null>>;
  isSavingDeepseekCredential: boolean;
  saveDeepseekCredential: () => Promise<void>;
  validateDeepseekProvider: () => Promise<void>;

  // Google Translate Credential States
  googleTranslateCredentialDraft: string;
  setGoogleTranslateCredentialDraft: (draft: string) => void;
  googleTranslateStatus: CredentialValidationResult | null;
  setGoogleTranslateStatus: React.Dispatch<React.SetStateAction<CredentialValidationResult | null>>;
  isSavingGoogleTranslateCredential: boolean;
  saveGoogleTranslateCredential: () => Promise<void>;
  validateGoogleTranslateProvider: () => Promise<void>;

  // Actions
  saveCredential: () => Promise<void>;
  validateProvider: () => Promise<void>;
  startTranscription: (forceRemote?: boolean) => Promise<void>;
  startTranslation: (forceRemote?: boolean) => Promise<void>;
  startTts: () => Promise<void>;
  exportVideo: () => Promise<void>;
  startFullPipeline: () => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;

  // Tasks Queue state
  tasks: IntervoxTask[];
  setTasks: React.Dispatch<React.SetStateAction<IntervoxTask[]>>;
  activeTaskId: string | null;
  setActiveTaskId: (id: string | null) => void;
  clearCompletedTasks: () => void;
  addNewTask: (input: string, mode: MediaInputMode) => void;
  deleteTask: (taskId: string) => void;
  cancelTask: (taskId: string) => void;

  // Playback History
  playbackHistory: PlaybackHistoryItem[];
  addPlaybackHistoryItem: (name: string, url: string, mode: "local_file" | "public_url") => void;
  deletePlaybackHistoryItem: (id: string) => void;
  clearPlaybackHistory: () => void;
}

const IntervoxContext = createContext<IntervoxContextType | undefined>(undefined);

// Cache Helpers
const ASR_CACHE_PREFIX = "intervox:asr:v2:";
const TRANSLATION_CACHE_PREFIX = "intervox:translation:v3:";
const TTS_CACHE_PREFIX = "intervox:tts:v2:";
const OUTPUT_DIR_STORAGE_KEY = "intervox_output_dir";

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function hashString(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function readLocalJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLocalJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function isPlaceholderTranscript(document?: TranscriptDocument | null) {
  if (!document?.segments?.length) {
    return false;
  }

  return document.segments.some((segment) => {
    const text = segment.text.trim().toLowerCase();
    return text.includes("placeholder") || text.includes("占位符");
  });
}

function isVolcSpeechMtModel(model: string) {
  return model.trim() === "volc-speech-mt";
}

function outputPath(outputDir: string, fileName: string) {
  const baseDir = outputDir.trim().replace(/[\\/]+$/, "");
  return baseDir ? `${baseDir}/${fileName}` : fileName;
}

function resolveTtsModel(
  provider: TtsProviderId | undefined,
  synthesisMode: "default" | "clone",
  configuredModel?: string,
) {
  if (provider === "local_tts") {
    return configuredModel?.trim() || "omnivoice:8";
  }
  if (provider === "volc_doubao") {
    return synthesisMode === "clone" ? "seed-icl-2.0" : "seed-tts-2.0";
  }
  return synthesisMode === "clone" ? "cosyvoice-v3-clone" : "cosyvoice-v3-flash";
}

export function IntervoxProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem("intervox_theme");
      return (saved as "dark" | "light") || "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("intervox_theme", theme);
    } catch {}
    if (theme === "light") {
      document.documentElement.classList.add("light");
    } else {
      document.documentElement.classList.remove("light");
    }
  }, [theme]);

  const [activePage, setActivePage] = useState("player");
  const [config, setConfig] = useState<AsrConfig>(() => {
    try {
      const saved = localStorage.getItem("intervox_config");
      if (saved) {
        const parsed = JSON.parse(saved) as AsrConfig;
        if (parsed.volc_doubao?.resource_id === "volc.seedasr.auc") {
          parsed.volc_doubao.resource_id = "volc.bigasr.auc_turbo";
        }
        return {
          ...DEFAULT_ASR_CONFIG,
          ...parsed,
          translation: { ...DEFAULT_ASR_CONFIG.translation, ...parsed.translation },
          tts: { ...DEFAULT_ASR_CONFIG.tts, ...parsed.tts },
        };
      }
    } catch {}
    return DEFAULT_ASR_CONFIG;
  });

  useEffect(() => {
    localStorage.setItem("intervox_config", JSON.stringify(config));
  }, [config]);

  const [credentialDraft, setCredentialDraft] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaInputMode, setMediaInputMode] = useState<MediaInputMode>("public_url");
  const [localMediaPath, setLocalMediaPath] = useState("");
  
  const [status, setStatus] = useState<CredentialValidationResult | null>(null);

  const [volcCredentialDraft, setVolcCredentialDraft] = useState("");
  const [volcAppIdDraft, setVolcAppIdDraft] = useState(config.volc_doubao.app_id || "");
  const [volcStatus, setVolcStatus] = useState<CredentialValidationResult | null>(null);
  const [isSavingVolcCredential, setIsSavingVolcCredential] = useState(false);

  const [deepseekCredentialDraft, setDeepseekCredentialDraft] = useState("");
  const [deepseekStatus, setDeepseekStatus] = useState<CredentialValidationResult | null>(null);
  const [isSavingDeepseekCredential, setIsSavingDeepseekCredential] = useState(false);

  const [googleTranslateCredentialDraft, setGoogleTranslateCredentialDraft] = useState("");
  const [googleTranslateStatus, setGoogleTranslateStatus] = useState<CredentialValidationResult | null>(null);
  const [isSavingGoogleTranslateCredential, setIsSavingGoogleTranslateCredential] = useState(false);

  const [transcriptionStatus, setTranscriptionStatus] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [translationStatus, setTranslationStatus] = useState<string | null>(null);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [transcript, setTranscript] = useState<TranscriptDocument | null>(null);
  const [translation, setTranslation] = useState<TranslationDocument | null>(null);
  const [tts, setTts] = useState<TtsDocument | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);

  const [loadedAsrCacheKey, setLoadedAsrCacheKey] = useState<string | null>(null);
  const [loadedTranslationCacheKey, setLoadedTranslationCacheKey] = useState<string | null>(null);

  const [isSavingCredential, setIsSavingCredential] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const [transcriptionProgress, setTranscriptionProgress] = useState<number | null>(null);
  const [translationProgress, setTranslationProgress] = useState<number | null>(null);

  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  const showToast = (message: string, type: "success" | "error" | "info" = "success") => {
    setToast({ message, type });
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const synthesisMode = config.tts?.synthesis_mode || "default";
  const setSynthesisMode = (mode: "default" | "clone") => {
    setConfig((prev) => ({
      ...prev,
      tts: { ...prev.tts, synthesis_mode: mode }
    }));
  };

  const ttsVoice = config.tts?.voice || "longxiaochun_v3";
  const setTtsVoice = (voice: string) => {
    setConfig((prev) => ({
      ...prev,
      tts: { ...prev.tts, voice }
    }));
  };

  const translationModel = config.translation?.model || "qwen-plus";
  const setTranslationModel = (model: string) => {
    setConfig((prev) => ({
      ...prev,
      translation: { ...prev.translation, model }
    }));
  };
  const [ttsRate, setTtsRate] = useState(1);
  const [outputDir, setOutputDir] = useState(() => {
    try {
      return localStorage.getItem(OUTPUT_DIR_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });
  const [replaceOriginalAudio, setReplaceOriginalAudio] = useState(true);
  const [originalAudioVolume, setOriginalAudioVolume] = useState(0.25);
  const [voiceoverVolume, setVoiceoverVolume] = useState(1);
  const [showEnglishSubtitles, setShowEnglishSubtitles] = useState(false);
  const [showTargetLanguageSubtitles, setShowTargetLanguageSubtitles] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(OUTPUT_DIR_STORAGE_KEY, outputDir);
    } catch {}
  }, [outputDir]);

  // Task list and queue states
  const [tasks, setTasks] = useState<IntervoxTask[]>(() => {
    try {
      const saved = localStorage.getItem("intervox_tasks");
      if (saved) return JSON.parse(saved);
    } catch {}
    
    // Default mock history matching screenshot
    return [
      {
        id: "TR-EnFr-093",
        fileName: "Tutorial_Basics_FR.mp4",
        mediaUrl: "Tutorial_Basics_FR.mp4",
        mediaInputMode: "local_file" as const,
        status: "completed" as const,
        stage: "final_output" as const,
        progress: 1.0,
        timestamp: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
        targetLang: "fr-FR",
        duration: "04:12s",
        logLines: ["Extract audio complete", "ASR finished in 1.2s", "Synthesized target language voiceover", "Muxed dubbed video successfully"]
      },
      {
        id: "TR-EnZh-092",
        fileName: "Interview_Raw_CN.mp4",
        mediaUrl: "Interview_Raw_CN.mp4",
        mediaInputMode: "local_file" as const,
        status: "completed" as const,
        stage: "final_output" as const,
        progress: 1.0,
        timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        targetLang: "zh-Hans-CN",
        duration: "12:45s",
        logLines: ["ASR completed", "Translation aligned successfully", "TTS synthesize done", "Exported audio tracks complete"]
      },
      {
        id: "TR-EnRu-091",
        fileName: "Corrupted_File_01.mkv",
        mediaUrl: "Corrupted_File_01.mkv",
        mediaInputMode: "local_file" as const,
        status: "failed" as const,
        stage: "extract_audio" as const,
        progress: 0.15,
        timestamp: new Date(Date.now() - 1000 * 60 * 50).toISOString(),
        targetLang: "de-DE",
        error: "FFMPEG_ERR_04: Stream parsing failed",
        logLines: ["Init extraction sequence", "Error reading audio track index 0", "FFMPEG_ERR_04: Corrupted stream data"]
      }
    ];
  });

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const tasksRef = useRef(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const [playbackHistory, setPlaybackHistory] = useState<PlaybackHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem("intervox_playback_history");
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });

  useEffect(() => {
    localStorage.setItem("intervox_playback_history", JSON.stringify(playbackHistory));
  }, [playbackHistory]);

  const addPlaybackHistoryItem = (name: string, url: string, mode: "local_file" | "public_url") => {
    if (!url.trim()) return;
    setPlaybackHistory((current) => {
      const filtered = current.filter((item) => item.url !== url);
      const newItem: PlaybackHistoryItem = {
        id: `HIST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: name || url.substring(url.lastIndexOf("/") + 1) || "video.mp4",
        url,
        inputMode: mode,
        timestamp: new Date().toISOString(),
      };
      return [newItem, ...filtered];
    });
  };

  const deletePlaybackHistoryItem = (id: string) => {
    setPlaybackHistory((current) => current.filter((item) => item.id !== id));
  };

  const clearPlaybackHistory = () => {
    setPlaybackHistory([]);
  };

  useEffect(() => {
    localStorage.setItem("intervox_tasks", JSON.stringify(tasks));
  }, [tasks]);

  const activeMediaInput = mediaInputMode === "public_url" ? mediaUrl.trim() : localMediaPath.trim();

  // Computed Cache keys
  const activeAsrCacheKey = useMemo(() => {
    if (!activeMediaInput) return null;
    const signature = JSON.stringify({
      media_input_mode: mediaInputMode,
      media_input: activeMediaInput,
      provider: config.provider,
      source_language: config.source_language,
      aliyun_bailian: config.aliyun_bailian,
      google_chirp3: config.google_chirp3,
      volc_doubao: config.volc_doubao,
      local_whisper: config.local_whisper,
    });
    return hashString(signature);
  }, [activeMediaInput, config, mediaInputMode]);

  const activeTranslationCacheKey = useMemo(() => {
    if (!activeAsrCacheKey) return null;
    return hashString(
      JSON.stringify({
        asr_cache_key: activeAsrCacheKey,
        target_language: config.target_language,
        provider: config.translation?.provider || "aliyun_qwen",
        deployment: config.translation?.deployment || "china_mainland",
        model: translationModel,
      }),
    );
  }, [activeAsrCacheKey, config.translation?.provider, config.translation?.deployment, config.target_language, translationModel]);

  const [cachedTranscript, setCachedTranscript] = useState<CachedTranscript | null>(null);
  const [cachedTranslation, setCachedTranslation] = useState<CachedTranslation | null>(null);

  // Read cache entries when key changes
  useEffect(() => {
    if (!activeAsrCacheKey) {
      setCachedTranscript(null);
      return;
    }
    const cached = readLocalJson<CachedTranscript>(`${ASR_CACHE_PREFIX}${activeAsrCacheKey}`);
    setCachedTranscript(isPlaceholderTranscript(cached?.document) ? null : cached);
  }, [activeAsrCacheKey]);

  useEffect(() => {
    if (!activeTranslationCacheKey) {
      setCachedTranslation(null);
      return;
    }
    const cached = readLocalJson<CachedTranslation>(`${TRANSLATION_CACHE_PREFIX}${activeTranslationCacheKey}`);
    setCachedTranslation(cached);
  }, [activeTranslationCacheKey]);

  // Hook up Tauri events
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let isMounted = true;
    const unlisteners: Array<() => void> = [];

    void listen<AsrProgressPayload>("asr-progress", (event) => {
      if (!isMounted) return;
      if (event.payload.stage === "started") {
        setTranscriptionStatus("阿里云百炼 ASR 任务提交，正在识别...");
        setTranscriptionProgress(0.15);
        updateActiveTaskStage("asr", 0.15, "百炼 ASR 识别任务提交，已开始...");
      }
      if (event.payload.stage === "completed") {
        setTranscriptionStatus("识别完成，正在载入结果...");
        setTranscriptionProgress(1);
        updateActiveTaskStage("asr", 1.0, "ASR 识别完成。");
      }
    }).then((unlisten) => {
      if (isMounted) unlisteners.push(unlisten);
      else unlisten();
    });

    void listen<AsrFailedPayload>("asr-failed", (event) => {
      if (!isMounted) return;
      const msg = event.payload.message || "识别失败。";
      setTranscriptionError(msg);
      setTranscriptionStatus(null);
      setIsTranscribing(false);
      setTranscriptionProgress(null);
      failActiveTask(msg);
    }).then((unlisten) => {
      if (isMounted) unlisteners.push(unlisten);
      else unlisten();
    });

    void listen<TranslationProgressPayload>("translation-progress", (event) => {
      if (!isMounted) return;
      const { stage, completed_segments = 0, total_segments = 0, progress = 0 } = event.payload;
      setTranslationProgress(progress);
      
      let statusStr = "正在翻译...";
      if (stage === "queued") {
        statusStr = "翻译请求正在队列排队...";
      } else if (stage === "started") {
        statusStr = "分批翻译任务已启动...";
      } else if (stage === "batch_completed") {
        statusStr = `已翻译 ${completed_segments}/${total_segments} 段。`;
      } else if (stage === "completed") {
        statusStr = "翻译任务已全部完成！";
      }

      setTranslationStatus(statusStr);
      updateActiveTaskStage("translate", progress, statusStr);
    }).then((unlisten) => {
      if (isMounted) unlisteners.push(unlisten);
      else unlisten();
    });

    void listen<TranslationFailedPayload>("translation-failed", (event) => {
      if (!isMounted) return;
      const msg = event.payload.message || "翻译失败。";
      setTranslationError(msg);
      setTranslationStatus(null);
      setIsTranslating(false);
      setTranslationProgress(null);
      failActiveTask(msg);
    }).then((unlisten) => {
      if (isMounted) unlisteners.push(unlisten);
      else unlisten();
    });

    void listen<TtsProgressPayload>("tts-progress", (event) => {
      if (!isMounted) return;
      const { stage, completed_segments = 0, total_segments = 0, progress = 0 } = event.payload;

      let statusStr = "正在合成配音...";
      if (stage === "started") {
        statusStr = "配音合成任务已启动...";
      } else if (stage === "segment_completed") {
        statusStr = `已合成 ${completed_segments}/${total_segments} 段配音。`;
      } else if (stage === "completed") {
        statusStr = "配音合成任务已全部完成！";
      }

      const shouldLog =
        stage !== "segment_completed" ||
        completed_segments === total_segments ||
        completed_segments % 10 === 0;
      setTtsStatus(statusStr);
      updateActiveTaskStage("tts_clone", progress, shouldLog ? statusStr : undefined);
    }).then((unlisten) => {
      if (isMounted) unlisteners.push(unlisten);
      else unlisten();
    });

    void listen<TtsFailedPayload>("tts-failed", (event) => {
      if (!isMounted) return;
      const msg = event.payload.message || "TTS 配音失败。";
      setTtsError(msg);
      setTtsStatus(null);
      setIsSynthesizing(false);
      failActiveTask(msg);
    }).then((unlisten) => {
      if (isMounted) unlisteners.push(unlisten);
      else unlisten();
    });

    void listen<ExportProgressPayload>("export-progress", (event) => {
      if (!isMounted) return;
      const { stage, processed_ms = 0, total_ms = 0, progress = 0 } = event.payload;
      const percent = Math.round(progress * 100);
      const statusStr = stage === "completed"
        ? "输出视频生成完成。"
        : `FFmpeg 正在生成输出视频：${percent}%（${formatDuration(processed_ms)} / ${formatDuration(total_ms)}）`;
      setExportStatus(statusStr);
      updateActiveTaskStage(
        stage === "completed" ? "final_output" : "mix_media",
        progress,
        stage === "started" || stage === "completed" ? statusStr : undefined,
      );
    }).then((unlisten) => {
      if (isMounted) unlisteners.push(unlisten);
      else unlisten();
    });

    return () => {
      isMounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [activeTaskId]);

  // Tasks mutation helpers
  const updateActiveTaskStage = (stage: IntervoxTask["stage"], progress: number, logMsg?: string) => {
    setTasks((current) =>
      current.map((t) => {
        if (t.status === "running") {
          const lines = logMsg ? [...t.logLines, `[${new Date().toLocaleTimeString()}] ${logMsg}`] : t.logLines;
          return { ...t, stage, progress, logLines: lines };
        }
        return t;
      })
    );
  };

  const failActiveTask = (errorMsg: string) => {
    setTasks((current) =>
      current.map((t) => {
        if (t.status === "running") {
          return {
            ...t,
            status: "failed" as const,
            error: errorMsg,
            logLines: [...t.logLines, `[${new Date().toLocaleTimeString()}] ERROR: ${errorMsg}`]
          };
        }
        return t;
      })
    );
    setActiveTaskId(null);
  };

  const completeActiveTask = (videoPath: string) => {
    setTasks((current) =>
      current.map((t) => {
        if (t.status === "running") {
          return {
            ...t,
            status: "completed" as const,
            progress: 1.0,
            outputVideoPath: videoPath,
            logLines: [...t.logLines, `[${new Date().toLocaleTimeString()}] 任务圆满完成。视频保存在：${videoPath}`]
          };
        }
        return t;
      })
    );
    setActiveTaskId(null);
  };

  const addNewTask = (input: string, mode: MediaInputMode) => {
    const filename = input.substring(input.lastIndexOf("/") + 1) || "dub_project.mp4";
    const taskId = `TR-${config.source_language.toUpperCase().substring(0,2)}${config.target_language.substring(0,2).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
    const newTask: IntervoxTask = {
      id: taskId,
      fileName: filename,
      mediaUrl: input,
      mediaInputMode: mode,
      status: "queued",
      stage: "select_video",
      progress: 0.0,
      timestamp: new Date().toISOString(),
      targetLang: config.target_language,
      logLines: [`[${new Date().toLocaleTimeString()}] 任务已创建并排队中。目标语言：${config.target_language}`]
    };
    setTasks((current) => [newTask, ...current]);
  };

  const clearCompletedTasks = () => {
    setTasks((current) => current.filter((t) => t.status === "running" || t.status === "queued"));
  };

  const deleteTask = (taskId: string) => {
    setTasks((current) => current.filter((t) => t.id !== taskId));
    if (activeTaskId === taskId) {
      setActiveTaskId(null);
    }
  };

  const cancelTask = (taskId: string) => {
    setTasks((current) =>
      current.map((t) => {
        if (t.id === taskId && t.status === "running") {
          return {
            ...t,
            status: "failed" as const,
            error: "任务被用户手动取消。",
            logLines: [...t.logLines, `[${new Date().toLocaleTimeString()}] 任务已被用户手动取消。`],
          };
        }
        return t;
      })
    );
    if (activeTaskId === taskId) {
      setActiveTaskId(null);
    }
  };

  // Actions
  const saveCredential = async () => {
    setIsSavingCredential(true);
    setStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_save_credential",
        { provider: config.provider, secret: credentialDraft },
        { ok: credentialDraft.trim().length > 0, provider: config.provider, message: "开发预览：凭据已保存。" }
      );
      setStatus(result);
      if (result.ok) setCredentialDraft("");
    } catch (e: any) {
      setStatus({ ok: false, provider: config.provider, message: e.message || "保存失败。" });
    } finally {
      setIsSavingCredential(false);
    }
  };

  const validateProvider = async () => {
    setStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_validate_credentials",
        { provider: config.provider, config },
        { ok: true, provider: config.provider, message: "配置校验结构成功。" }
      );
      setStatus(result);
    } catch (e: any) {
      setStatus({ ok: false, provider: config.provider, message: e.message || "校验失败。" });
    }
  };

  const saveVolcCredential = async () => {
    setIsSavingVolcCredential(true);
    setVolcStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_save_credential",
        { provider: "volc_doubao", secret: volcCredentialDraft },
        { ok: volcCredentialDraft.trim().length > 0, provider: "volc_doubao" as AsrProviderId, message: "开发预览：火山引擎凭据已保存。" }
      );
      setVolcStatus(result);
      if (result.ok) {
        setVolcCredentialDraft("");
      }
    } catch (e: any) {
      setVolcStatus({ ok: false, provider: "volc_doubao" as AsrProviderId, message: e.message || "保存失败。" });
    } finally {
      setIsSavingVolcCredential(false);
    }
  };

  const validateVolcProvider = async () => {
    setVolcStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_validate_credentials",
        { provider: "volc_doubao", config },
        { ok: true, provider: "volc_doubao" as AsrProviderId, message: "火山引擎配置校验成功。" }
      );
      setVolcStatus(result);
    } catch (e: any) {
      setVolcStatus({ ok: false, provider: "volc_doubao" as AsrProviderId, message: e.message || "校验失败。" });
    }
  };

  const saveDeepseekCredential = async () => {
    setIsSavingDeepseekCredential(true);
    setDeepseekStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_save_credential",
        { provider: "deepseek" as any, secret: deepseekCredentialDraft },
        { ok: deepseekCredentialDraft.trim().length > 0, provider: "deepseek" as any, message: "DeepSeek 凭据已保存。" }
      );
      setDeepseekStatus(result);
      if (result.ok) setDeepseekCredentialDraft("");
    } catch (e: any) {
      setDeepseekStatus({ ok: false, provider: "deepseek" as any, message: e.message || "保存失败。" });
    } finally {
      setIsSavingDeepseekCredential(false);
    }
  };

  const validateDeepseekProvider = async () => {
    setDeepseekStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_validate_credentials",
        { provider: "deepseek" as any, config },
        { ok: true, provider: "deepseek" as any, message: "DeepSeek 配置有效。" }
      );
      setDeepseekStatus(result);
    } catch (e: any) {
      setDeepseekStatus({ ok: false, provider: "deepseek" as any, message: e.message || "校验失败。" });
    }
  };

  const saveGoogleTranslateCredential = async () => {
    setIsSavingGoogleTranslateCredential(true);
    setGoogleTranslateStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_save_credential",
        { provider: "google_translate" as any, secret: googleTranslateCredentialDraft },
        { ok: googleTranslateCredentialDraft.trim().length > 0, provider: "google_translate" as any, message: "Google 翻译凭据已保存。" }
      );
      setGoogleTranslateStatus(result);
      if (result.ok) setGoogleTranslateCredentialDraft("");
    } catch (e: any) {
      setGoogleTranslateStatus({ ok: false, provider: "google_translate" as any, message: e.message || "保存失败。" });
    } finally {
      setIsSavingGoogleTranslateCredential(false);
    }
  };

  const validateGoogleTranslateProvider = async () => {
    setGoogleTranslateStatus(null);
    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_validate_credentials",
        { provider: "google_translate" as any, config },
        { ok: true, provider: "google_translate" as any, message: "Google 翻译配置有效。" }
      );
      setGoogleTranslateStatus(result);
    } catch (e: any) {
      setGoogleTranslateStatus({ ok: false, provider: "google_translate" as any, message: e.message || "校验失败。" });
    }
  };

  useEffect(() => {
    // Validate credentials on initial load so the UI knows if keys exist
    validateProvider();
    validateVolcProvider();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const startTranscription = async (forceRemote = false) => {
    if (isTranscribing) return;
    if (!activeMediaInput) {
      setTranscriptionError("请提供音视频源。");
      return;
    }

    if (!forceRemote && cachedTranscript && !isPlaceholderTranscript(cachedTranscript.document)) {
      setTranscript(cachedTranscript.document);
      setTranscriptionProgress(1);
      setTranscriptionStatus("从本机缓存载入成功。");
      return;
    }

    setIsTranscribing(true);
    setTranscriptionError(null);
    setTranscriptionProgress(0.05);
    setTranscriptionStatus("提交任务中...");

    try {
      const result = await invokeOrFallback<TranscriptDocument>(
        "asr_transcribe",
        {
          request: {
            job_id: `job_${Date.now()}`,
            audio_path: activeMediaInput,
            output_dir: outputDir.trim() || null,
            config,
          }
        },
        {
          source_language: config.source_language,
          target_language: config.target_language,
          provider: config.provider,
          segments: [
            {
              id: "seg_001",
              start_ms: 0,
              end_ms: 3500,
              speaker_id: "channel_0",
              text: "Hello! Welcome to the premium AI dubbing demonstration. Initiating sequence alpha.",
            },
            {
              id: "seg_002",
              start_ms: 3800,
              end_ms: 7800,
              speaker_id: "channel_0",
              text: "All critical systems are nominal. Standing by for transcription alignment.",
            }
          ]
        }
      );
      setTranscript(result);
      setTranscriptionProgress(1);
      setTranscriptionStatus(`识别成功，共 ${result.segments.length} 段。`);
      
      if (activeAsrCacheKey) {
        writeLocalJson(`${ASR_CACHE_PREFIX}${activeAsrCacheKey}`, {
          version: 1,
          cache_key: activeAsrCacheKey,
          media_input: activeMediaInput,
          media_input_mode: mediaInputMode,
          updated_at: new Date().toISOString(),
          document: result,
        });
        setCachedTranscript(readLocalJson(`${ASR_CACHE_PREFIX}${activeAsrCacheKey}`));
      }
    } catch (e: any) {
      setTranscriptionError(e.message || "语音识别出错。");
      setTranscriptionStatus(null);
      setTranscriptionProgress(null);
    } finally {
      setIsTranscribing(false);
    }
  };

  const startTranslation = async (forceRemote = false) => {
    if (isTranslating) return;
    if (!transcript) {
      setTranslationError("请先完成 ASR 识别。");
      return;
    }

    if (!forceRemote && cachedTranslation) {
      setTranslation(cachedTranslation.document);
      setTranslationProgress(1);
      setTranslationStatus("从本机缓存载入翻译结果。");
      return;
    }

    if (config.translation?.provider === "volc_speech_mt" && !translationModel.trim()) {
      setTranslationError("请选择火山机器翻译。");
      return;
    }

    setIsTranslating(true);
    setTranslationError(null);
    setTranslationStatus(
      isVolcSpeechMtModel(translationModel)
        ? "正在调用火山引擎机器翻译..."
        : config.translation?.provider === "volc_speech_mt" || config.translation?.provider === "volc_ark"
          ? "正在调用火山翻译模型..."
          : config.translation?.provider === "deepseek"
            ? "正在调用 DeepSeek 翻译中..."
            : config.translation?.provider === "google_translate"
              ? "正在调用 Google 翻译中..."
              : config.translation?.provider === "local_llm"
                ? "正在调用本地 LLM 翻译中..."
                : "正在调用百炼 Qwen 模型翻译..."
    );
    setTranslationProgress(0.1);

    try {
      const result = await invokeOrFallback<TranslationDocument>(
        "translate_transcript",
        {
          request: {
            transcript: { ...transcript, target_language: config.target_language },
            provider: config.translation?.provider || "aliyun_qwen",
            model: translationModel,
            deployment: config.translation?.deployment || "china_mainland",
            local_endpoint: config.local_whisper?.translation_endpoint || "http://localhost:11434/v1",
          }
        },
        {
          source_language: String(transcript.source_language),
          target_language: config.target_language,
          provider: config.translation?.provider || "aliyun_qwen",
          segments: transcript.segments.map((segment) => ({
            id: segment.id,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id,
            source_text: segment.text,
            translated_text: segment.text.includes("Welcome to the premium")
              ? "你好！欢迎来到高级 AI 配音演示。正在启动 alpha 序列。"
              : "所有关键系统均正常。等待转录对齐。",
          }))
        }
      );

      setTranslation(result);
      setTranslationProgress(1);
      setTranslationStatus("翻译全部完成。");

      if (activeTranslationCacheKey && activeAsrCacheKey) {
        writeLocalJson(`${TRANSLATION_CACHE_PREFIX}${activeTranslationCacheKey}`, {
          version: 2,
          cache_key: activeTranslationCacheKey,
          asr_cache_key: activeAsrCacheKey,
          target_language: result.target_language,
          updated_at: new Date().toISOString(),
          document: result,
        });
        setCachedTranslation(readLocalJson(`${TRANSLATION_CACHE_PREFIX}${activeTranslationCacheKey}`));
      }
    } catch (e: any) {
      setTranslationError(e.message || "翻译接口出错。");
      setTranslationStatus(null);
      setTranslationProgress(null);
    } finally {
      setIsTranslating(false);
    }
  };

  const startTts = async () => {
    if (!translation) {
      setTtsError("请先完成翻译润色。");
      return;
    }

    setIsSynthesizing(true);
    setTtsError(null);
    setTtsStatus(
      config.tts?.provider === "local_tts"
        ? "调用本地语音合成中..."
        : config.tts?.provider === "volc_doubao"
          ? "调用豆包语音配音合成中..."
          : "调用 CosyVoice 配音合成中..."
    );

    try {
      const ttsProvider = config.tts?.provider || "aliyun_cosyvoice";
      const ttsModel = resolveTtsModel(ttsProvider, synthesisMode, config.tts?.model);
      const result = await invokeOrFallback<TtsDocument>(
        "synthesize_tts",
        {
          request: {
            translation,
            provider: ttsProvider,
            model: ttsModel,
            voice: synthesisMode === "clone" ? "" : ttsVoice,
            deployment: config.translation?.deployment || config.aliyun_bailian?.deployment || "china_mainland",
            output_dir: outputDir.trim() || null,
            rate: ttsRate,
            pitch: 1,
            sample_rate: 24000,
            original_video_path: synthesisMode === "clone" ? activeMediaInput : null,
            app_id: config.volc_doubao?.app_id || null,
            tts_resource_id: config.tts?.tts_resource_id || null,
            tts_endpoint: config.tts?.endpoint || null,
          }
        },
        {
          target_language: translation.target_language,
          provider: "aliyun_cosyvoice",
          model: "cosyvoice-v3-flash",
          voice: ttsVoice,
          segments: translation.segments.map((segment, index) => ({
            id: segment.id,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id,
            text: segment.translated_text,
            audio_url: "mock_url",
            audio_path: `mock_tts_file_${index}.wav`,
          }))
        }
      );
      setTts(result);
      setTtsStatus(`配音合成完成，共 ${result.segments.length} 个音轨。`);
    } catch (e: any) {
      setTtsError(e.message || "TTS 配音出错。");
      setTtsStatus(null);
    } finally {
      setIsSynthesizing(false);
    }
  };

  const exportVideo = async () => {
    if (!tts || !activeMediaInput) {
      setExportError("参数不齐，请确认已生成配音并填入视频地址。");
      return;
    }
    if ((showEnglishSubtitles || showTargetLanguageSubtitles) && !translation) {
      setExportError("字幕导出需要先完成翻译。");
      return;
    }

    setIsExporting(true);
    setExportError(null);
    setExportStatus("FFmpeg 正在生成输出视频。较长视频转码需要几分钟，请保持应用运行。");

    try {
      const result = await invokeOrFallback<ExportResult>(
        "export_dubbed_video",
        {
          request: {
            media_url: activeMediaInput,
            tts,
            output_dir: outputDir.trim() || null,
            replace_original_audio: replaceOriginalAudio,
            original_audio_volume: originalAudioVolume,
            voiceover_volume: voiceoverVolume,
            subtitles: translation && (showEnglishSubtitles || showTargetLanguageSubtitles)
              ? {
                  show_english: showEnglishSubtitles,
                  show_target_language: showTargetLanguageSubtitles,
                  translation,
                }
              : null,
          }
        },
        {
          voiceover_path: outputPath(outputDir, "voiceover.wav"),
          video_path: outputPath(outputDir, "dubbed_completed.mp4"),
        }
      );
      setExportResult(result);
      setExportStatus("视频混合并合成成功！");
    } catch (e: any) {
      setExportError(e.message || "导出混合视频失败。");
      setExportStatus(null);
    } finally {
      setIsExporting(false);
    }
  };

  // Shared pipeline execution logic — used by both startFullPipeline and retryTask
  const runPipelineFor = async (
    mediaInput: string,
    inputMode: MediaInputMode,
    taskId: string,
  ) => {
    const isTaskStillRunning = () => {
      const currentTasks = tasksRef.current;
      const task = currentTasks.find((t) => t.id === taskId);
      return task && task.status === "running";
    };

    const configToUse = config;

    // Compute cache keys for ASR and Translation
    const signature = JSON.stringify({
      media_input_mode: inputMode,
      media_input: mediaInput,
      provider: configToUse.provider,
      source_language: configToUse.source_language,
      aliyun_bailian: configToUse.aliyun_bailian,
      google_chirp3: configToUse.google_chirp3,
      volc_doubao: configToUse.volc_doubao,
      local_whisper: configToUse.local_whisper,
    });
    const asrCacheKey = hashString(signature);

    const translationSignature = JSON.stringify({
      asr_cache_key: asrCacheKey,
      target_language: configToUse.target_language,
      deployment: configToUse.aliyun_bailian.deployment,
      model: translationModel,
    });
    const translationCacheKey = hashString(translationSignature);
    const ttsProvider = configToUse.tts?.provider || "aliyun_cosyvoice";
    const ttsModel = resolveTtsModel(ttsProvider, synthesisMode, configToUse.tts?.model);
    const ttsSignature = JSON.stringify({
      translation_cache_key: translationCacheKey,
      provider: ttsProvider,
      synthesis_mode: synthesisMode,
      model: ttsModel,
      voice: synthesisMode === "clone" ? "" : ttsVoice,
      rate: ttsRate,
      sample_rate: 24000,
      output_dir: outputDir.trim(),
      app_id: configToUse.volc_doubao.app_id,
      tts_resource_id: configToUse.tts?.tts_resource_id || "",
      tts_endpoint: configToUse.tts?.endpoint || "",
      local_tts_preset_version: ttsProvider === "local_tts" ? 4 : 1,
    });
    const ttsCacheKey = hashString(ttsSignature);

    try {
      if (!isTaskStillRunning()) return;
      // Step 1: Extract Audio
      updateActiveTaskStage("extract_audio", 0.5, "提取主音轨成功，文件准备上传百炼。");
      await new Promise((r) => setTimeout(r, 800));

      if (!isTaskStillRunning()) return;
      // Step 2: ASR
      let asrResult: TranscriptDocument;
      const cachedAsr = readLocalJson<CachedTranscript>(`${ASR_CACHE_PREFIX}${asrCacheKey}`);

      if (cachedAsr && cachedAsr.document && !isPlaceholderTranscript(cachedAsr.document)) {
        asrResult = cachedAsr.document;
        if (!isTaskStillRunning()) return;
        updateActiveTaskStage("asr", 1.0, "检测到本地 ASR 识别缓存，已直接载入（跳过 API 调用）。");
        await new Promise((r) => setTimeout(r, 600));
      } else {
        if (!isTaskStillRunning()) return;
        updateActiveTaskStage(
          "asr",
          0.1,
          configToUse.provider === "volc_doubao"
            ? "火山引擎豆包录音识别任务提交中..."
            : "阿里云百炼 ASR 任务提交中..."
        );
        asrResult = await invokeOrFallback<TranscriptDocument>(
          "asr_transcribe",
          {
            request: {
              job_id: `job_${Date.now()}`,
              audio_path: mediaInput,
              output_dir: outputDir.trim() || null,
              config: configToUse,
            }
          },
          {
            source_language: configToUse.source_language,
            target_language: configToUse.target_language,
            provider: configToUse.provider,
            segments: [
              {
                id: "seg_pipeline_001",
                start_ms: 0,
                end_ms: 3500,
                speaker_id: "channel_0",
                text: "Hello! Welcome to the premium AI dubbing demonstration. Initiating sequence alpha.",
              },
              {
                id: "seg_pipeline_002",
                start_ms: 3800,
                end_ms: 7800,
                speaker_id: "channel_0",
                text: "All critical systems are nominal. Standing by for transcription alignment.",
              }
            ]
          }
        );
        if (!isTaskStillRunning()) return;
        // Write ASR Cache
        writeLocalJson(`${ASR_CACHE_PREFIX}${asrCacheKey}`, {
          version: 1,
          cache_key: asrCacheKey,
          media_input: mediaInput,
          media_input_mode: inputMode,
          updated_at: new Date().toISOString(),
          document: asrResult,
        });
      }

      if (!isTaskStillRunning()) return;
      setTranscript(asrResult);
      updateActiveTaskStage(
        "translate",
        0.1,
        isVolcSpeechMtModel(translationModel)
          ? "ASR 语音识别顺利完成。启动火山机器翻译。"
          : configToUse.provider === "volc_doubao"
            ? "ASR 语音识别顺利完成。启动火山翻译。"
            : "ASR 语音识别顺利完成。启动百炼 Qwen 翻译。"
      );
      await new Promise((r) => setTimeout(r, 800));

      if (configToUse.provider === "volc_doubao" && !translationModel.trim()) {
        throw new Error("请选择火山机器翻译。");
      }

      // Step 3: Translate
      if (!isTaskStillRunning()) return;
      let translateResult: TranslationDocument;
      const cachedTrans = readLocalJson<CachedTranslation>(`${TRANSLATION_CACHE_PREFIX}${translationCacheKey}`);

      if (cachedTrans && cachedTrans.document) {
        translateResult = cachedTrans.document;
        if (!isTaskStillRunning()) return;
        updateActiveTaskStage("translate", 1.0, "检测到本地翻译缓存，已直接载入（跳过 API 调用）。");
        await new Promise((r) => setTimeout(r, 600));
      } else {
        if (!isTaskStillRunning()) return;
        translateResult = await invokeOrFallback<TranslationDocument>(
          "translate_transcript",
          {
            request: {
              transcript: { ...asrResult, target_language: configToUse.target_language },
              provider: configToUse.translation?.provider || "aliyun_qwen",
              model: translationModel,
              deployment: configToUse.aliyun_bailian.deployment,
              local_endpoint: configToUse.local_whisper?.translation_endpoint || "http://localhost:11434/v1",
            }
          },
          {
            source_language: String(asrResult.source_language),
            target_language: configToUse.target_language,
            provider: isVolcSpeechMtModel(translationModel) ? "volc_speech_mt" : "aliyun_qwen",
            segments: asrResult.segments.map((segment) => ({
              id: segment.id,
              start_ms: segment.start_ms,
              end_ms: segment.end_ms,
              speaker_id: segment.speaker_id,
              source_text: segment.text,
              translated_text: segment.text.includes("Welcome to the premium")
                ? "你好！欢迎来到高级 AI 配音演示。正在启动 alpha 序列。"
                : "所有关键系统均正常。等待转录对齐。",
            }))
          }
        );
        if (!isTaskStillRunning()) return;
        // Write Translation Cache
        writeLocalJson(`${TRANSLATION_CACHE_PREFIX}${translationCacheKey}`, {
          version: 2,
          cache_key: translationCacheKey,
          asr_cache_key: asrCacheKey,
          target_language: translateResult.target_language,
          updated_at: new Date().toISOString(),
          document: translateResult,
        });
      }

      if (!isTaskStillRunning()) return;
      setTranslation(translateResult);
      updateActiveTaskStage(
        "tts_clone",
        0.1,
        configToUse.provider === "volc_doubao"
          ? "翻译完毕。正在请求豆包语音合成/复刻。"
          : "翻译完毕。正在请求百炼 CosyVoice 语音合成/复刻。"
      );
      await new Promise((r) => setTimeout(r, 800));

      // Step 4: TTS / Voice Cloning
      if (!isTaskStillRunning()) return;
      let ttsResult: TtsDocument;
      const cachedTts = readLocalJson<CachedTts>(`${TTS_CACHE_PREFIX}${ttsCacheKey}`);
      const hasValidTtsCache = cachedTts?.document
        ? await invokeOrFallback<boolean>("validate_tts_cache", { tts: cachedTts.document }, false)
        : false;

      if (!isTaskStillRunning()) return;
      if (hasValidTtsCache && cachedTts) {
        ttsResult = cachedTts.document;
        if (!isTaskStillRunning()) return;
        updateActiveTaskStage("tts_clone", 1.0, "检测到本地配音缓存，已直接载入（跳过重复 TTS 合成）。");
        await new Promise((r) => setTimeout(r, 600));
      } else {
        if (!isTaskStillRunning()) return;
        ttsResult = await invokeOrFallback<TtsDocument>(
          "synthesize_tts",
          {
            request: {
              translation: translateResult,
              provider: ttsProvider,
              model: ttsModel,
              voice: synthesisMode === "clone" ? "" : ttsVoice,
              deployment: configToUse.aliyun_bailian.deployment,
              output_dir: outputDir.trim() || null,
              rate: ttsRate,
              pitch: 1,
              sample_rate: 24000,
              original_video_path: synthesisMode === "clone" ? mediaInput : null,
              app_id: configToUse.volc_doubao.app_id || null,
              tts_resource_id: configToUse.tts?.tts_resource_id || null,
              tts_endpoint: configToUse.tts?.endpoint || null,
            }
          },
          {
            target_language: translateResult.target_language,
            provider: "aliyun_cosyvoice",
            model: "cosyvoice-v3-flash",
            voice: ttsVoice,
            segments: translateResult.segments.map((segment, index) => ({
              id: segment.id,
              start_ms: segment.start_ms,
              end_ms: segment.end_ms,
              speaker_id: segment.speaker_id,
              text: segment.translated_text,
              audio_url: "mock_url",
              audio_path: `mock_tts_file_${index}.wav`,
            }))
          }
        );
        if (!isTaskStillRunning()) return;
        writeLocalJson(`${TTS_CACHE_PREFIX}${ttsCacheKey}`, {
          version: 2,
          cache_key: ttsCacheKey,
          translation_cache_key: translationCacheKey,
          updated_at: new Date().toISOString(),
          document: ttsResult,
        });
      }

      if (!isTaskStillRunning()) return;
      setTts(ttsResult);
      updateActiveTaskStage("mix_media", 0.5, "声轨合成结束。FFmpeg 正在生成输出视频；较长视频转码需要几分钟，请保持应用运行。");
      await new Promise((r) => setTimeout(r, 800));

      // Step 5: Export Video
      if (!isTaskStillRunning()) return;
      const exportRes = await invokeOrFallback<ExportResult>(
        "export_dubbed_video",
        {
          request: {
            media_url: mediaInput,
            tts: ttsResult,
            output_dir: outputDir.trim() || null,
            replace_original_audio: replaceOriginalAudio,
            original_audio_volume: originalAudioVolume,
            voiceover_volume: voiceoverVolume,
            subtitles: showEnglishSubtitles || showTargetLanguageSubtitles
              ? {
                  show_english: showEnglishSubtitles,
                  show_target_language: showTargetLanguageSubtitles,
                  translation: translateResult,
                }
              : null,
          }
        },
        {
          voiceover_path: outputPath(outputDir, "voiceover.wav"),
          video_path: outputPath(outputDir, `dubbed_${Date.now()}.mp4`),
        }
      );

      setExportResult(exportRes);
      completeActiveTask(exportRes.video_path);
    } catch (err: any) {
      console.error("Pipeline failure details:", err);
      const errorMsg = typeof err === "string" ? err : err?.message || JSON.stringify(err) || "Pipeline execution failed.";
      failActiveTask(errorMsg);
    }
  };

  // Full Dubbing pipeline handler that executes all steps automatically
  const startFullPipeline = async () => {
    if (!activeMediaInput) return;

    // Add to task queue
    addNewTask(activeMediaInput, mediaInputMode);

    // Switch to active page tasks to visualize progress
    setActivePage("tasks");

    // Give React one tick to commit the new task, then start it
    setTimeout(async () => {
      let taskId = "";
      setTasks((current) => {
        const list = [...current];
        if (list.length > 0 && list[0].status === "queued") {
          list[0].status = "running";
          list[0].logLines.push(`[${new Date().toLocaleTimeString()}] Pipeline triggered. Extraction initialized.`);
          taskId = list[0].id;
          setActiveTaskId(list[0].id);
        }
        return list;
      });

      // Wait another tick so taskId is captured
      await new Promise((r) => setTimeout(r, 50));
      await runPipelineFor(activeMediaInput, mediaInputMode, taskId);
    }, 500);
  };

  // Retry an existing failed task — resets it and re-runs the pipeline
  const retryTask = async (taskId: string) => {
    // Find the task to retry
    const taskToRetry = tasks.find((t) => t.id === taskId);
    if (!taskToRetry) return;

    const { mediaUrl: taskMedia, mediaInputMode: taskInputMode } = taskToRetry;

    // Reset task state to running
    setTasks((current) =>
      current.map((t) => {
        if (t.id === taskId) {
          return {
            ...t,
            status: "running" as const,
            stage: "select_video" as const,
            progress: 0,
            error: null,
            logLines: [`[${new Date().toLocaleTimeString()}] 重试任务，正在检查缓存并恢复 Pipeline...`],
          };
        }
        return t;
      })
    );
    setActiveTaskId(taskId);
    setActivePage("tasks");

    // Small delay to let the state commit before starting pipeline steps
    await new Promise((r) => setTimeout(r, 300));

    await runPipelineFor(taskMedia, taskInputMode, taskId);
  };

  return (
    <IntervoxContext.Provider
      value={{
        config,
        setConfig,
        activePage,
        setActivePage,
        mediaUrl,
        setMediaUrl,
        mediaInputMode,
        setMediaInputMode,
        localMediaPath,
        setLocalMediaPath,
        credentialDraft,
        setCredentialDraft,
        status,
        setStatus,
        transcriptionStatus,
        setTranscriptionStatus,
        transcriptionError,
        setTranscriptionError,
        translationStatus,
        setTranslationStatus,
        translationError,
        setTranslationError,
        ttsStatus,
        setTtsStatus,
        ttsError,
        setTtsError,
        exportStatus,
        setExportStatus,
        exportError,
        setExportError,
        transcript,
        setTranscript,
        translation,
        setTranslation,
        tts,
        setTts,
        exportResult,
        theme,
        setTheme,
        setExportResult,
        synthesisMode,
        setSynthesisMode,
        toast,
        showToast,
        ttsVoice,
        setTtsVoice,
        translationModel,
        setTranslationModel,
        ttsRate,
        setTtsRate,
        outputDir,
        setOutputDir,
        replaceOriginalAudio,
        setReplaceOriginalAudio,
        originalAudioVolume,
        setOriginalAudioVolume,
        voiceoverVolume,
        setVoiceoverVolume,
        showEnglishSubtitles,
        setShowEnglishSubtitles,
        showTargetLanguageSubtitles,
        setShowTargetLanguageSubtitles,
        isSavingCredential,
        isTranscribing,
        isTranslating,
        isSynthesizing,
        isExporting,
        transcriptionProgress,
        translationProgress,
        activeMediaInput,
        activeAsrCacheKey,
        activeTranslationCacheKey,
        cachedTranscript,
        cachedTranslation,
        saveCredential,
        validateProvider,
        volcCredentialDraft,
        setVolcCredentialDraft,
        volcAppIdDraft,
        setVolcAppIdDraft,
        volcStatus,
        setVolcStatus,
        isSavingVolcCredential,
        saveVolcCredential,
        validateVolcProvider,
        deepseekCredentialDraft,
        setDeepseekCredentialDraft,
        deepseekStatus,
        setDeepseekStatus,
        isSavingDeepseekCredential,
        saveDeepseekCredential,
        validateDeepseekProvider,
        googleTranslateCredentialDraft,
        setGoogleTranslateCredentialDraft,
        googleTranslateStatus,
        setGoogleTranslateStatus,
        isSavingGoogleTranslateCredential,
        saveGoogleTranslateCredential,
        validateGoogleTranslateProvider,
        startTranscription,
        startTranslation,
        startTts,
        exportVideo,
        startFullPipeline,
        tasks,
        setTasks,
        activeTaskId,
        setActiveTaskId,
        clearCompletedTasks,
        addNewTask,
        retryTask,
        deleteTask,
        cancelTask,
        playbackHistory,
        addPlaybackHistoryItem,
        deletePlaybackHistoryItem,
        clearPlaybackHistory,
      }}
    >
      {children}
    </IntervoxContext.Provider>
  );
}

export function useIntervox() {
  const context = useContext(IntervoxContext);
  if (context === undefined) {
    throw new Error("useIntervox must be used within an IntervoxProvider");
  }
  return context;
}
