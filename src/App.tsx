import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  BadgeCheck,
  Cloud,
  HardDrive,
  Languages,
  Loader2,
  Download,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  SlidersHorizontal,
  Volume2,
} from "lucide-react";
import {
  ASR_PROVIDER_OPTIONS,
  BAILIAN_DEPLOYMENT_OPTIONS,
  BAILIAN_MODEL_OPTIONS,
  DEFAULT_ASR_CONFIG,
  GOOGLE_REGION_OPTIONS,
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  WHISPER_MODEL_OPTIONS,
} from "./lib/asrOptions";
import { invokeOrFallback } from "./lib/tauri";
import type {
  AsrConfig,
  AsrProviderId,
  BailianDeployment,
  BailianModel,
  CredentialValidationResult,
  GoogleRegion,
  SourceLanguageCode,
  TargetLanguageCode,
  TranslationDocument,
  TtsDocument,
  ExportResult,
  TranscriptDocument,
  WhisperModel,
} from "./types/asr";

const providerIcons: Record<AsrProviderId, typeof Cloud> = {
  aliyun_bailian: Cloud,
  google_chirp3: RadioTower,
  volc_doubao: Cloud,
  local_whisper: HardDrive,
};

type MediaInputMode = "public_url" | "local_file";

type AsrProgressEvent = {
  job_id?: string;
  stage?: "started" | "completed" | string;
  progress?: number;
};

type AsrFailedEvent = {
  job_id?: string;
  message?: string;
};

type TranslationProgressEvent = {
  stage?: "queued" | "started" | "batch_completed" | "completed" | string;
  completed_batches?: number;
  total_batches?: number;
  completed_segments?: number;
  total_segments?: number;
  progress?: number;
};

type TranslationFailedEvent = {
  message?: string;
};

type CachedTranscriptEntry = {
  version: 1;
  cache_key: string;
  media_input: string;
  media_input_mode: MediaInputMode;
  updated_at: string;
  document: TranscriptDocument;
};

type CachedTranslationEntry = {
  version: 1;
  cache_key: string;
  asr_cache_key: string;
  target_language: TargetLanguageCode;
  updated_at: string;
  document: TranslationDocument;
};

const ASR_CACHE_PREFIX = "intervox:asr:";
const TRANSLATION_CACHE_PREFIX = "intervox:translation:";
const LEGACY_ASR_CACHE_PREFIX = "video-dubber:asr:";
const LEGACY_TRANSLATION_CACHE_PREFIX = "video-dubber:translation:";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallback;
}

function isYoutubeWatchUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return (
      ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"].includes(
        url.hostname,
      ) &&
      (url.hostname.includes("youtu.be") || url.pathname === "/watch")
    );
  } catch {
    return false;
  }
}

function waitForBrowserPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
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
  } catch {
    // Cache writes are a convenience; the live workflow should keep running if storage is full.
  }
}

function removeLocalJson(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore cache cleanup failures.
  }
}

function asrCacheStorageKey(cacheKey: string) {
  return `${ASR_CACHE_PREFIX}${cacheKey}`;
}

function translationCacheStorageKey(cacheKey: string) {
  return `${TRANSLATION_CACHE_PREFIX}${cacheKey}`;
}

function legacyAsrCacheStorageKey(cacheKey: string) {
  return `${LEGACY_ASR_CACHE_PREFIX}${cacheKey}`;
}

function legacyTranslationCacheStorageKey(cacheKey: string) {
  return `${LEGACY_TRANSLATION_CACHE_PREFIX}${cacheKey}`;
}

function readAsrCache(cacheKey: string) {
  return (
    readLocalJson<CachedTranscriptEntry>(asrCacheStorageKey(cacheKey)) ??
    readLocalJson<CachedTranscriptEntry>(legacyAsrCacheStorageKey(cacheKey))
  );
}

function readTranslationCache(cacheKey: string) {
  return (
    readLocalJson<CachedTranslationEntry>(translationCacheStorageKey(cacheKey)) ??
    readLocalJson<CachedTranslationEntry>(legacyTranslationCacheStorageKey(cacheKey))
  );
}

function removeTranslationCache(cacheKey: string) {
  removeLocalJson(translationCacheStorageKey(cacheKey));
  removeLocalJson(legacyTranslationCacheStorageKey(cacheKey));
}

function buildAsrCacheKey(
  mediaInputMode: MediaInputMode,
  mediaInput: string,
  config: AsrConfig,
) {
  if (!mediaInput.trim()) {
    return null;
  }

  const signature = JSON.stringify({
    media_input_mode: mediaInputMode,
    media_input: mediaInput.trim(),
    provider: config.provider,
    source_language: config.source_language,
    aliyun_bailian: config.aliyun_bailian,
    google_chirp3: config.google_chirp3,
    volc_doubao: config.volc_doubao,
    local_whisper: config.local_whisper,
  });

  return hashString(signature);
}

function buildTranslationCacheKey(
  asrCacheKey: string | null,
  targetLanguage: TargetLanguageCode,
  deployment: BailianDeployment,
  model: string,
) {
  if (!asrCacheKey) {
    return null;
  }

  return hashString(
    JSON.stringify({
      asr_cache_key: asrCacheKey,
      target_language: targetLanguage,
      deployment,
      model,
    }),
  );
}

function formatCacheTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "本机缓存";
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function translationCompletenessIssue(
  transcript: TranscriptDocument,
  translation: TranslationDocument,
) {
  if (translation.segments.length !== transcript.segments.length) {
    return `翻译段数是 ${translation.segments.length}，识别段数是 ${transcript.segments.length}`;
  }

  const translatedIds = new Set(translation.segments.map((segment) => segment.id));
  const missingIds = transcript.segments
    .filter((segment) => !translatedIds.has(segment.id))
    .map((segment) => segment.id);
  if (missingIds.length > 0) {
    return `翻译缺少分段 ${missingIds.slice(0, 8).join(", ")}${
      missingIds.length > 8 ? " ..." : ""
    }`;
  }

  const emptyIds = translation.segments
    .filter((segment) => !segment.translated_text.trim())
    .map((segment) => segment.id);
  if (emptyIds.length > 0) {
    return `翻译存在空内容分段 ${emptyIds.slice(0, 8).join(", ")}${
      emptyIds.length > 8 ? " ..." : ""
    }`;
  }

  return null;
}

function ttsCompletenessIssue(translation: TranslationDocument, tts: TtsDocument) {
  if (tts.segments.length !== translation.segments.length) {
    return `配音段数是 ${tts.segments.length}，翻译段数是 ${translation.segments.length}`;
  }

  const ttsIds = new Set(tts.segments.map((segment) => segment.id));
  const missingIds = translation.segments
    .filter((segment) => !ttsIds.has(segment.id))
    .map((segment) => segment.id);
  if (missingIds.length > 0) {
    return `配音缺少分段 ${missingIds.slice(0, 8).join(", ")}${
      missingIds.length > 8 ? " ..." : ""
    }`;
  }

  return null;
}

function App() {
  const [config, setConfig] = useState<AsrConfig>(DEFAULT_ASR_CONFIG);
  const [credentialDraft, setCredentialDraft] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaInputMode, setMediaInputMode] = useState<MediaInputMode>("public_url");
  const [localMediaPath, setLocalMediaPath] = useState("");
  const [status, setStatus] = useState<CredentialValidationResult | null>(null);
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
  const [cachedTranscript, setCachedTranscript] = useState<CachedTranscriptEntry | null>(null);
  const [cachedTranslation, setCachedTranslation] = useState<CachedTranslationEntry | null>(null);
  const [loadedAsrCacheKey, setLoadedAsrCacheKey] = useState<string | null>(null);
  const [loadedTranslationCacheKey, setLoadedTranslationCacheKey] = useState<string | null>(null);
  const [isSavingCredential, setIsSavingCredential] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState<number | null>(null);
  const [translationProgress, setTranslationProgress] = useState<number | null>(null);
  const [ttsVoice, setTtsVoice] = useState("longxiaochun_v3");
  const [ttsRate, setTtsRate] = useState(1);
  const [outputDir, setOutputDir] = useState("");
  const [replaceOriginalAudio, setReplaceOriginalAudio] = useState(false);
  const [originalAudioVolume, setOriginalAudioVolume] = useState(0.25);
  const [voiceoverVolume, setVoiceoverVolume] = useState(1);

  const activeProvider = useMemo(
    () => ASR_PROVIDER_OPTIONS.find((option) => option.value === config.provider),
    [config.provider],
  );

  const updateConfig = <K extends keyof AsrConfig>(key: K, value: AsrConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const activeMediaInput = mediaInputMode === "public_url" ? mediaUrl.trim() : localMediaPath.trim();
  const activeAsrCacheKey = useMemo(
    () => buildAsrCacheKey(mediaInputMode, activeMediaInput, config),
    [activeMediaInput, config, mediaInputMode],
  );
  const activeTranslationCacheKey = useMemo(
    () =>
      buildTranslationCacheKey(
        activeAsrCacheKey,
        config.target_language,
        config.aliyun_bailian.deployment,
        "qwen-plus",
      ),
    [activeAsrCacheKey, config.aliyun_bailian.deployment, config.target_language],
  );

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let isMounted = true;
    const unlisteners: Array<() => void> = [];

    void listen<AsrProgressEvent>("asr-progress", (event) => {
      if (!isMounted) {
        return;
      }

      if (event.payload.stage === "started") {
        setTranscriptionStatus("百炼 ASR 任务已提交，正在识别...");
        setTranscriptionProgress(0.15);
      }

      if (event.payload.stage === "completed") {
        setTranscriptionStatus("识别完成，正在整理结果...");
        setTranscriptionProgress(1);
      }
    }).then((unlisten) => {
      if (isMounted) {
        unlisteners.push(unlisten);
      } else {
        unlisten();
      }
    });

    void listen<AsrFailedEvent>("asr-failed", (event) => {
      if (!isMounted) {
        return;
      }

      setTranscriptionError(event.payload.message || "识别失败。");
      setTranscriptionStatus(null);
      setIsTranscribing(false);
      setTranscriptionProgress(null);
    }).then((unlisten) => {
      if (isMounted) {
        unlisteners.push(unlisten);
      } else {
        unlisten();
      }
    });

    void listen<TranslationProgressEvent>("translation-progress", (event) => {
      if (!isMounted) {
        return;
      }

      const {
        stage,
        completed_batches: completedBatches = 0,
        total_batches: totalBatches = 0,
        completed_segments: completedSegments = 0,
        total_segments: totalSegments = 0,
        progress = 0,
      } = event.payload;

      setTranslationProgress(progress);

      if (stage === "queued") {
        setTranslationStatus("翻译请求已排队...");
      } else if (stage === "started") {
        setTranslationStatus(
          totalBatches > 0
            ? `正在分批翻译，共 ${totalBatches} 批。`
            : "正在分批翻译...",
        );
      } else if (stage === "batch_completed") {
        setTranslationStatus(
          `已翻译 ${completedSegments}/${totalSegments} 段（第 ${completedBatches}/${totalBatches} 批）。`,
        );
      } else if (stage === "completed") {
        setTranslationStatus("翻译完成，正在整理结果...");
      }
    }).then((unlisten) => {
      if (isMounted) {
        unlisteners.push(unlisten);
      } else {
        unlisten();
      }
    });

    void listen<TranslationFailedEvent>("translation-failed", (event) => {
      if (!isMounted) {
        return;
      }

      setTranslationError(event.payload.message || "翻译失败。");
      setTranslationStatus(null);
      setIsTranslating(false);
      setTranslationProgress(null);
    }).then((unlisten) => {
      if (isMounted) {
        unlisteners.push(unlisten);
      } else {
        unlisten();
      }
    });

    return () => {
      isMounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!activeAsrCacheKey) {
      setCachedTranscript(null);
      setLoadedAsrCacheKey(null);
      return;
    }

    const cached = readAsrCache(activeAsrCacheKey);
    setCachedTranscript(cached);

    if (cached && loadedAsrCacheKey !== activeAsrCacheKey) {
      setTranscript(cached.document);
      setTranslation(null);
      setTts(null);
      setExportResult(null);
      setLoadedAsrCacheKey(activeAsrCacheKey);
      setLoadedTranslationCacheKey(null);
      setTranscriptionError(null);
      setTranscriptionStatus(
        `已从本机恢复识别结果，共 ${cached.document.segments.length} 段（${formatCacheTime(
          cached.updated_at,
        )}）。`,
      );
      return;
    }

    if (!cached && loadedAsrCacheKey !== activeAsrCacheKey) {
      setTranscript(null);
      setTranslation(null);
      setTts(null);
      setExportResult(null);
      setLoadedAsrCacheKey(null);
      setLoadedTranslationCacheKey(null);
      setTranscriptionStatus(null);
      setTranslationStatus(null);
    }
  }, [activeAsrCacheKey]);

  useEffect(() => {
    if (!activeTranslationCacheKey) {
      setCachedTranslation(null);
      setLoadedTranslationCacheKey(null);
      return;
    }

    const cached = readTranslationCache(activeTranslationCacheKey);
    if (cached && transcript) {
      const issue = translationCompletenessIssue(transcript, cached.document);
      if (issue) {
        removeTranslationCache(activeTranslationCacheKey);
        setCachedTranslation(null);
        setTranslation(null);
        setTts(null);
        setExportResult(null);
        setLoadedTranslationCacheKey(null);
        setTranslationStatus(null);
        setTranslationError(`已忽略本机旧翻译缓存：${issue}。请重新翻译。`);
        return;
      }
    }

    setCachedTranslation(cached);

    if (cached && transcript && loadedTranslationCacheKey !== activeTranslationCacheKey) {
      setTranslation(cached.document);
      setTts(null);
      setExportResult(null);
      setLoadedTranslationCacheKey(activeTranslationCacheKey);
      setTranslationError(null);
      setTranslationStatus(
        `已从本机恢复翻译结果，共 ${cached.document.segments.length} 段（${formatCacheTime(
          cached.updated_at,
        )}）。`,
      );
      return;
    }

    if (!cached && loadedTranslationCacheKey !== activeTranslationCacheKey) {
      setTranslation(null);
      setTts(null);
      setExportResult(null);
      setLoadedTranslationCacheKey(null);
      setTranslationStatus(null);
    }
  }, [activeTranslationCacheKey, transcript]);

  useEffect(() => {
    if (!activeAsrCacheKey || !activeMediaInput || !transcript) {
      return;
    }

    const entry: CachedTranscriptEntry = {
      version: 1,
      cache_key: activeAsrCacheKey,
      media_input: activeMediaInput,
      media_input_mode: mediaInputMode,
      updated_at: new Date().toISOString(),
      document: transcript,
    };
    writeLocalJson(asrCacheStorageKey(activeAsrCacheKey), entry);
    setCachedTranscript(entry);
  }, [activeAsrCacheKey, activeMediaInput, mediaInputMode, transcript]);

  useEffect(() => {
    if (!activeTranslationCacheKey || !activeAsrCacheKey || !translation) {
      return;
    }
    if (transcript) {
      const issue = translationCompletenessIssue(transcript, translation);
      if (issue) {
        return;
      }
    }

    const entry: CachedTranslationEntry = {
      version: 1,
      cache_key: activeTranslationCacheKey,
      asr_cache_key: activeAsrCacheKey,
      target_language: translation.target_language,
      updated_at: new Date().toISOString(),
      document: translation,
    };
    writeLocalJson(translationCacheStorageKey(activeTranslationCacheKey), entry);
    setCachedTranslation(entry);
  }, [activeAsrCacheKey, activeTranslationCacheKey, transcript, translation]);

  const saveCredential = async () => {
    setIsSavingCredential(true);
    setStatus(null);

    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_save_credential",
        {
          provider: config.provider,
          secret: credentialDraft,
        },
        {
          ok: credentialDraft.trim().length > 0,
          provider: config.provider,
          message:
            credentialDraft.trim().length > 0
              ? "开发预览模式：已模拟保存凭据。"
              : "请输入当前 ASR 服务商的凭据。",
        },
      );
      setStatus(result);
      if (result.ok) {
        setCredentialDraft("");
      }
    } catch (error) {
      setStatus({
        ok: false,
        provider: config.provider,
        message: error instanceof Error ? error.message : "保存凭据失败。",
      });
    } finally {
      setIsSavingCredential(false);
    }
  };

  const validateProvider = async () => {
    setStatus(null);

    try {
      const result = await invokeOrFallback<CredentialValidationResult>(
        "asr_validate_credentials",
        {
          provider: config.provider,
          config,
        },
        {
          ok: true,
          provider: config.provider,
          message: "开发预览模式：配置结构有效。",
        },
      );
      setStatus(result);
    } catch (error) {
      setStatus({
        ok: false,
        provider: config.provider,
        message: error instanceof Error ? error.message : "校验失败。",
      });
    }
  };

  const startTranscription = async (forceRemote = false) => {
    if (!activeMediaInput) {
      setTranscriptionError(
        mediaInputMode === "public_url"
          ? "请输入公网可访问的音视频文件直链。"
          : "请选择本地音视频文件。",
      );
      return;
    }
    if (!forceRemote && cachedTranscript) {
      setTranscript(cachedTranscript.document);
      setTranslation(null);
      setTts(null);
      setExportResult(null);
      setLoadedAsrCacheKey(cachedTranscript.cache_key);
      setLoadedTranslationCacheKey(null);
      setTranscriptionError(null);
      setTranscriptionProgress(null);
      setTranscriptionStatus(
        `已载入本机保存的识别结果，共 ${cachedTranscript.document.segments.length} 段（${formatCacheTime(
          cachedTranscript.updated_at,
        )}）。`,
      );
      return;
    }
    if (mediaInputMode === "public_url" && isYoutubeWatchUrl(activeMediaInput)) {
      setTranscriptionError(
        "YouTube 视频页面不是音视频文件直链，百炼无法直接读取。请使用公网可访问的 mp3/wav/mp4 文件 URL；本地视频导入和授权下载流程我会继续补上。",
      );
      return;
    }
    if (mediaInputMode === "local_file" && config.provider !== "local_whisper") {
      setTranscriptionError(
        "云端 ASR 不能直接读取本地文件。请先切换到“本地 Whisper”，或等待下一步接入“本地文件上传到 OSS 后再调用百炼”的流程。",
      );
      return;
    }

    setIsTranscribing(true);
    setTranscriptionError(null);
    setTranscript(null);
    setTranslation(null);
    setTts(null);
    setExportResult(null);
    setTranscriptionStatus("正在提交百炼 ASR 任务...");
    setTranscriptionProgress(0.05);

    const jobId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `job_${Date.now()}`;

    try {
      await waitForBrowserPaint();

      const result = await invokeOrFallback<TranscriptDocument>(
        "asr_transcribe",
        {
          request: {
            job_id: jobId,
            audio_path: activeMediaInput,
            config,
          },
        },
        {
          source_language: config.source_language,
          target_language: config.target_language,
          provider: config.provider,
          segments: [
            {
              id: "seg_preview_0001",
              start_ms: 0,
              end_ms: 3200,
              speaker_id: "channel_0",
              text: "开发预览模式：桌面壳中会调用真实 ASR。",
              confidence: null,
            },
          ],
        },
      );
      setTranscript(result);
      setLoadedAsrCacheKey(activeAsrCacheKey);
      setTranslation(null);
      setLoadedTranslationCacheKey(null);
      if (activeAsrCacheKey) {
        const entry: CachedTranscriptEntry = {
          version: 1,
          cache_key: activeAsrCacheKey,
          media_input: activeMediaInput,
          media_input_mode: mediaInputMode,
          updated_at: new Date().toISOString(),
          document: result,
        };
        writeLocalJson(asrCacheStorageKey(activeAsrCacheKey), entry);
        setCachedTranscript(entry);
      }
      setTranscriptionProgress(1);
      setTranscriptionStatus(`识别完成，共 ${result.segments.length} 段，已保存到本机。`);
    } catch (error) {
      setTranscriptionError(errorMessage(error, "识别失败。"));
      setTranscriptionStatus(null);
      setTranscriptionProgress(null);
    } finally {
      setIsTranscribing(false);
    }
  };

  const startTranslation = async (forceRemote = false) => {
    if (!transcript) {
      setTranslationError("请先完成 ASR 识别。");
      return;
    }

    if (!forceRemote && cachedTranslation) {
      const issue = translationCompletenessIssue(transcript, cachedTranslation.document);
      if (issue) {
        if (activeTranslationCacheKey) {
          removeTranslationCache(activeTranslationCacheKey);
        }
        setCachedTranslation(null);
        setTranslationError(`已忽略本机旧翻译缓存：${issue}。请重新翻译。`);
        setTranslationStatus(null);
        return;
      }

      setTranslation(cachedTranslation.document);
      setTts(null);
      setExportResult(null);
      setLoadedTranslationCacheKey(cachedTranslation.cache_key);
      setTranslationError(null);
      setTranslationProgress(null);
      setTranslationStatus(
        `已载入本机保存的翻译结果，共 ${cachedTranslation.document.segments.length} 段（${formatCacheTime(
          cachedTranslation.updated_at,
        )}）。`,
      );
      return;
    }

    setIsTranslating(true);
    setTranslationError(null);
    setTranslationStatus("正在调用百炼 Qwen 翻译...");
    setTranslationProgress(0);

    const transcriptWithLatestTarget: TranscriptDocument = {
      ...transcript,
      target_language: config.target_language,
    };

    try {
      const result = await invokeOrFallback<TranslationDocument>(
        "translate_transcript",
        {
          request: {
            transcript: transcriptWithLatestTarget,
            model: "qwen-plus",
            deployment: config.aliyun_bailian.deployment,
          },
        },
        {
          source_language: String(transcriptWithLatestTarget.source_language),
          target_language: transcriptWithLatestTarget.target_language,
          provider: "aliyun_qwen",
          segments: transcriptWithLatestTarget.segments.map((segment) => ({
            id: segment.id,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id,
            source_text: segment.text,
            translated_text: "开发预览模式：桌面壳中会调用真实翻译。",
          })),
        },
      );
      const issue = translationCompletenessIssue(transcriptWithLatestTarget, result);
      if (issue) {
        throw new Error(`翻译结果不完整：${issue}。请重新翻译，避免生成错位视频。`);
      }

      setTranslation(result);
      setLoadedTranslationCacheKey(activeTranslationCacheKey);
      setTts(null);
      setExportResult(null);
      if (activeTranslationCacheKey && activeAsrCacheKey) {
        const entry: CachedTranslationEntry = {
          version: 1,
          cache_key: activeTranslationCacheKey,
          asr_cache_key: activeAsrCacheKey,
          target_language: result.target_language,
          updated_at: new Date().toISOString(),
          document: result,
        };
        writeLocalJson(translationCacheStorageKey(activeTranslationCacheKey), entry);
        setCachedTranslation(entry);
      }
      setTranslationProgress(1);
      setTranslationStatus(`翻译完成，共 ${result.segments.length} 段，已保存到本机。`);
    } catch (error) {
      setTranslationError(errorMessage(error, "翻译失败。"));
      setTranslationStatus(null);
      setTranslationProgress(null);
    } finally {
      setIsTranslating(false);
    }
  };

  const startTts = async () => {
    if (!translation) {
      setTtsError("请先完成翻译。");
      return;
    }
    if (transcript) {
      const issue = translationCompletenessIssue(transcript, translation);
      if (issue) {
        setTtsError(`不能生成配音：${issue}。请先重新翻译。`);
        return;
      }
    }

    setIsSynthesizing(true);
    setTtsError(null);
    setTtsStatus("正在调用百炼 CosyVoice 生成配音...");
    setTts(null);
    setExportResult(null);

    try {
      const result = await invokeOrFallback<TtsDocument>(
        "synthesize_tts",
        {
          request: {
            translation,
            model: "cosyvoice-v3-flash",
            voice: ttsVoice,
            deployment: config.aliyun_bailian.deployment,
            output_dir: outputDir.trim() || null,
            rate: ttsRate,
            pitch: 1,
            sample_rate: 24000,
          },
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
            audio_url: "开发预览模式",
            audio_path: `/preview/tts/${index.toString().padStart(4, "0")}.wav`,
          })),
        },
      );
      setTts(result);
      setTtsStatus(`配音完成，共 ${result.segments.length} 段音频。`);
    } catch (error) {
      setTtsError(errorMessage(error, "配音失败。"));
      setTtsStatus(null);
    } finally {
      setIsSynthesizing(false);
    }
  };

  const exportVideo = async () => {
    if (!tts) {
      setExportError("请先完成 TTS 配音。");
      return;
    }
    if (translation) {
      const issue = ttsCompletenessIssue(translation, tts);
      if (issue) {
        setExportError(`不能导出：${issue}。请先重新生成配音。`);
        return;
      }
    }
    if (!activeMediaInput) {
      setExportError("请先选择或填写原视频。");
      return;
    }

    setIsExporting(true);
    setExportError(null);
    setExportStatus("正在用 FFmpeg 合成视频...");

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
          },
        },
        {
          voiceover_path: "/preview/exports/voiceover.wav",
          video_path: "/preview/exports/dubbed.mp4",
        },
      );
      setExportResult(result);
      setExportStatus("视频导出完成。");
    } catch (error) {
      setExportError(errorMessage(error, "视频导出失败。"));
      setExportStatus(null);
    } finally {
      setIsExporting(false);
    }
  };

  const previewTranscript: TranscriptDocument = {
    source_language: config.source_language,
    target_language: config.target_language,
    provider: config.provider,
    segments: [
      {
        id: "seg_0001",
        start_ms: 0,
        end_ms: 3200,
        speaker_id: "channel_0",
        text: "Original transcript text",
        confidence: 0.93,
      },
    ],
  };

  return (
    <main className="min-h-screen bg-mist">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-5 px-5 py-5 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-line pb-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-ink">视频翻译配音工具</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              ASR 只负责识别原视频语言；最终输出语言由翻译和 TTS 模块控制，当前默认中文普通话配音。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm text-slate-700 shadow-toolbar">
            <ShieldCheck className="h-4 w-4 text-pine" aria-hidden="true" />
            凭据仅保存到本机安全存储
          </div>
        </header>

        <section className="grid gap-2 md:grid-cols-5">
          {[
            ["1", "素材输入", activeMediaInput ? "ready" : "idle"],
            ["2", "ASR 识别", transcript ? "done" : isTranscribing ? "running" : "idle"],
            ["3", "翻译润色", translation ? "done" : isTranslating ? "running" : "idle"],
            ["4", "TTS 配音", tts ? "done" : isSynthesizing ? "running" : "idle"],
            ["5", "视频导出", exportResult ? "done" : isExporting ? "running" : "idle"],
          ].map(([step, label, state]) => (
            <div
              key={step}
              className={`flex h-14 items-center gap-3 rounded-md border px-3 text-sm shadow-toolbar ${
                state === "done"
                  ? "border-teal-200 bg-teal-50 text-teal-900"
                  : state === "running"
                    ? "border-violet-200 bg-violet-50 text-violet-900"
                    : "border-line bg-white text-slate-600"
              }`}
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-xs font-semibold">
                {step}
              </span>
              <span className="font-medium">{label}</span>
            </div>
          ))}
        </section>

        <section className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="rounded-md border border-line bg-white p-3 shadow-toolbar">
            <div className="mb-3 flex items-center gap-2 px-1 text-sm font-medium text-slate-700">
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              ASR 服务商
            </div>
            <div className="grid gap-2">
              {ASR_PROVIDER_OPTIONS.map((option) => {
                const Icon = providerIcons[option.value];
                const selected = option.value === config.provider;

                return (
                  <button
                    key={option.value}
                    className={`flex min-h-20 w-full items-start gap-3 rounded-md border p-3 text-left transition ${
                      selected
                        ? "border-pine bg-teal-50 text-ink"
                        : "border-line bg-white text-slate-700 hover:border-slate-300"
                    }`}
                    type="button"
                    onClick={() => updateConfig("provider", option.value)}
                    title={`切换到 ${option.label}`}
                  >
                    <Icon
                      className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? "text-pine" : "text-slate-500"}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">
                        {option.summary}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="grid gap-5">
            <section className="rounded-md border border-line bg-white p-5 shadow-toolbar">
              <div className="flex flex-col gap-1 border-b border-line pb-4">
                <h2 className="text-lg font-semibold text-ink">语言与输出</h2>
                <p className="text-sm text-slate-600">
                  原视频语言进入 ASR；目标语言进入后续翻译和 TTS，不会被当作 Google 区域或 ASR 模型参数。
                </p>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  原视频语言
                  <select
                    className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
                    value={config.source_language}
                    onChange={(event) =>
                      updateConfig("source_language", event.target.value as SourceLanguageCode)
                    }
                  >
                    {SOURCE_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  目标语言
                  <select
                    className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
                    value={config.target_language}
                    onChange={(event) =>
                      updateConfig("target_language", event.target.value as TargetLanguageCode)
                    }
                  >
                    {TARGET_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="rounded-md border border-line bg-white p-5 shadow-toolbar">
              <div className="flex flex-col gap-1 border-b border-line pb-4">
                <h2 className="text-lg font-semibold text-ink">{activeProvider?.label}</h2>
                <p className="text-sm text-slate-600">{activeProvider?.summary}</p>
              </div>

              <ProviderSettings config={config} setConfig={setConfig} />

              <div className="mt-5 grid gap-3 rounded-md border border-line bg-slate-50 p-4">
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  当前服务商凭据
                  <textarea
                    className="min-h-24 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
                    placeholder={credentialPlaceholder(config.provider)}
                    value={credentialDraft}
                    onChange={(event) => setCredentialDraft(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="inline-flex h-10 items-center gap-2 rounded-md bg-pine px-4 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
                    type="button"
                    onClick={saveCredential}
                    disabled={isSavingCredential}
                    title="保存凭据"
                  >
                    {isSavingCredential ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Save className="h-4 w-4" aria-hidden="true" />
                    )}
                    保存凭据
                  </button>
                  <button
                    className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-300"
                    type="button"
                    onClick={validateProvider}
                    title="校验当前 ASR 配置"
                  >
                    <BadgeCheck className="h-4 w-4" aria-hidden="true" />
                    校验配置
                  </button>
                </div>
                {status ? (
                  <div
                    className={`rounded-md border px-3 py-2 text-sm ${
                      status.ok
                        ? "border-teal-200 bg-teal-50 text-teal-800"
                        : "border-red-200 bg-red-50 text-red-800"
                    }`}
                  >
                    {status.message}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-md border border-line bg-white p-5 shadow-toolbar">
              <div className="flex flex-col gap-1 border-b border-line pb-4">
                <h2 className="text-lg font-semibold text-ink">开始识别</h2>
                <p className="text-sm text-slate-600">
                  云端 ASR 需要公网音视频文件直链；本地文件可先走本地 Whisper，或后续上传到 OSS 后再调用百炼。
                </p>
              </div>

              <div className="mt-5 grid gap-3">
                <div className="inline-flex w-fit rounded-md border border-line bg-slate-50 p-1">
                  <button
                    className={`h-9 rounded px-3 text-sm font-medium ${
                      mediaInputMode === "public_url"
                        ? "bg-white text-ink shadow-toolbar"
                        : "text-slate-600"
                    }`}
                    type="button"
                    onClick={() => setMediaInputMode("public_url")}
                  >
                    公网文件直链
                  </button>
                  <button
                    className={`h-9 rounded px-3 text-sm font-medium ${
                      mediaInputMode === "local_file"
                        ? "bg-white text-ink shadow-toolbar"
                        : "text-slate-600"
                    }`}
                    type="button"
                    onClick={() => setMediaInputMode("local_file")}
                  >
                    本地文件
                  </button>
                </div>

                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  {mediaInputMode === "public_url" ? "公网音视频文件 URL" : "本地音视频文件"}
                  {mediaInputMode === "public_url" ? (
                    <input
                      className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
                      placeholder="https://example.com/audio-or-video.mp4 或 .mp3/.wav"
                      value={mediaUrl}
                      onChange={(event) => setMediaUrl(event.target.value)}
                    />
                  ) : (
                    <input
                      className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
                      placeholder="/Users/you/Downloads/video.mp4"
                      value={localMediaPath}
                      onChange={(event) => setLocalMediaPath(event.target.value)}
                    />
                  )}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    type="button"
                    onClick={() => startTranscription(false)}
                    disabled={isTranscribing || !activeMediaInput}
                    title={cachedTranscript ? "载入本机保存的 ASR 结果" : "开始 ASR 识别"}
                  >
                    {isTranscribing ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Play className="h-4 w-4" aria-hidden="true" />
                    )}
                    {cachedTranscript ? "载入识别结果" : "开始识别"}
                  </button>
                  {(cachedTranscript || transcript) && activeMediaInput ? (
                    <button
                      className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      onClick={() => startTranscription(true)}
                      disabled={isTranscribing}
                      title="重新调用 ASR，会再次产生服务费用"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      重新识别
                    </button>
                  ) : null}
                  {transcriptionStatus ? (
                    <span className="text-sm text-slate-600">{transcriptionStatus}</span>
                  ) : null}
                </div>
                {isTranscribing ? (
                  <ProgressBar value={transcriptionProgress} label="ASR 识别进度" />
                ) : null}
                {cachedTranscript ? (
                  <div className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
                    已保存识别结果：{cachedTranscript.document.segments.length} 段，更新时间{" "}
                    {formatCacheTime(cachedTranscript.updated_at)}。普通点击会复用缓存，不会重新计费。
                  </div>
                ) : null}
                {transcriptionError ? (
                  <div className="inline-flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{transcriptionError}</span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-md border border-line bg-white p-5 shadow-toolbar">
              <div className="flex flex-col gap-1 border-b border-line pb-4">
                <h2 className="text-lg font-semibold text-ink">翻译润色</h2>
                <p className="text-sm text-slate-600">
                  使用阿里百炼 Qwen 把转写分段翻译成目标语言，保留每段时间轴，后续可直接进入 TTS。
                </p>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-plum px-4 text-sm font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-60"
                  type="button"
                  onClick={() => startTranslation(false)}
                  disabled={isTranslating || !transcript}
                  title={cachedTranslation ? "载入本机保存的翻译结果" : "翻译当前转写"}
                >
                  {isTranslating ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                  )}
                  {cachedTranslation ? "载入翻译结果" : "翻译转写"}
                </button>
                {(cachedTranslation || translation) && transcript ? (
                  <button
                    className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
                    type="button"
                    onClick={() => startTranslation(true)}
                    disabled={isTranslating}
                    title="重新调用 Qwen 翻译，会再次产生服务费用"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    重新翻译
                  </button>
                ) : null}
                {translationStatus ? (
                  <span className="text-sm text-slate-600">{translationStatus}</span>
                ) : (
                  <span className="text-sm text-slate-500">完成 ASR 后即可翻译。</span>
                )}
              </div>
              {isTranslating ? (
                <div className="mt-3">
                  <ProgressBar value={translationProgress} label="翻译进度" tone="plum" />
                </div>
              ) : null}
              {cachedTranslation ? (
                <div className="mt-3 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
                  已保存翻译结果：{cachedTranslation.document.segments.length} 段，更新时间{" "}
                  {formatCacheTime(cachedTranslation.updated_at)}。普通点击会复用缓存，不会重新计费。
                </div>
              ) : null}
              {translationError ? (
                <div className="mt-3 inline-flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{translationError}</span>
                </div>
              ) : null}
            </section>

            <section className="rounded-md border border-line bg-white p-5 shadow-toolbar">
              <div className="flex flex-col gap-1 border-b border-line pb-4">
                <h2 className="text-lg font-semibold text-ink">TTS 配音</h2>
                <p className="text-sm text-slate-600">
                  使用百炼 CosyVoice 为每个翻译分段生成 WAV 音频，后续按时间轴拼成整条配音轨。
                </p>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  音色
                  <input
                    className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
                    value={ttsVoice}
                    onChange={(event) => setTtsVoice(event.target.value)}
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  语速
                  <input
                    className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
                    max="2"
                    min="0.5"
                    step="0.1"
                    type="number"
                    value={ttsRate}
                    onChange={(event) => setTtsRate(Number(event.target.value))}
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  输出目录
                  <input
                    className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
                    placeholder="留空则写入项目 exports/"
                    value={outputDir}
                    onChange={(event) => setOutputDir(event.target.value)}
                  />
                </label>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-pine px-4 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
                  type="button"
                  onClick={startTts}
                  disabled={isSynthesizing || !translation}
                  title="生成目标语言配音"
                >
                  {isSynthesizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Volume2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  生成配音
                </button>
                {ttsStatus ? (
                  <span className="text-sm text-slate-600">{ttsStatus}</span>
                ) : (
                  <span className="text-sm text-slate-500">完成翻译后即可生成配音。</span>
                )}
              </div>
              {ttsError ? (
                <div className="mt-3 inline-flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{ttsError}</span>
                </div>
              ) : null}
            </section>

            <section className="rounded-md border border-line bg-white p-5 shadow-toolbar">
              <div className="flex flex-col gap-1 border-b border-line pb-4">
                <h2 className="text-lg font-semibold text-ink">视频导出</h2>
                <p className="text-sm text-slate-600">
                  用 FFmpeg 将配音轨合成回原视频，默认替换原声；当前需要系统已安装 FFmpeg。
                </p>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                  <input
                    checked={replaceOriginalAudio}
                    type="checkbox"
                    onChange={(event) => setReplaceOriginalAudio(event.target.checked)}
                  />
                  只保留中文配音
                </label>
                <button
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  type="button"
                  onClick={exportVideo}
                  disabled={isExporting || !tts}
                  title="导出配音视频"
                >
                  {isExporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="h-4 w-4" aria-hidden="true" />
                  )}
                  导出 MP4
                </button>
                {exportStatus ? (
                  <span className="text-sm text-slate-600">{exportStatus}</span>
                ) : (
                  <span className="text-sm text-slate-500">完成 TTS 后即可导出。</span>
                )}
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  原声音量
                  <input
                    className="accent-pine"
                    disabled={replaceOriginalAudio}
                    max="1"
                    min="0"
                    step="0.05"
                    type="range"
                    value={originalAudioVolume}
                    onChange={(event) => setOriginalAudioVolume(Number(event.target.value))}
                  />
                  <span className="text-xs text-slate-500">
                    {replaceOriginalAudio
                      ? "当前会移除原音轨，包括背景音乐。"
                      : `${Math.round(originalAudioVolume * 100)}%，会保留背景音乐，也会保留原英文人声。`}
                  </span>
                </label>
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  中文配音音量
                  <input
                    className="accent-plum"
                    max="1.5"
                    min="0.2"
                    step="0.05"
                    type="range"
                    value={voiceoverVolume}
                    onChange={(event) => setVoiceoverVolume(Number(event.target.value))}
                  />
                  <span className="text-xs text-slate-500">
                    {Math.round(voiceoverVolume * 100)}%
                  </span>
                </label>
              </div>
              {exportResult ? (
                <div className="mt-3 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
                  输出视频：{exportResult.video_path}
                </div>
              ) : null}
              {exportError ? (
                <div className="mt-3 inline-flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{exportError}</span>
                </div>
              ) : null}
            </section>

            <section className="rounded-md border border-line bg-white p-5 shadow-toolbar">
              <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-700">
                <Languages className="h-4 w-4 text-plum" aria-hidden="true" />
                统一转写输出
              </div>
              <pre className="overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-6 text-slate-100">
                {JSON.stringify(
                  {
                    transcript: transcript ?? previewTranscript,
                    translation,
                    tts,
                    export_result: exportResult,
                  },
                  null,
                  2,
                )}
              </pre>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function ProgressBar({
  value,
  label,
  tone = "pine",
}: {
  value: number | null;
  label: string;
  tone?: "pine" | "plum";
}) {
  const percentage = value === null ? 35 : Math.max(0, Math.min(100, Math.round(value * 100)));
  const colorClass = tone === "plum" ? "bg-plum" : "bg-pine";

  return (
    <div className="grid gap-1" aria-label={label}>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${colorClass} transition-all duration-300 ${
            value === null ? "progress-indeterminate" : ""
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span>{value === null ? "处理中" : `${percentage}%`}</span>
      </div>
    </div>
  );
}

function ProviderSettings({
  config,
  setConfig,
}: {
  config: AsrConfig;
  setConfig: Dispatch<SetStateAction<AsrConfig>>;
}) {
  if (config.provider === "aliyun_bailian") {
    return (
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          识别模型
          <select
            className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
            value={config.aliyun_bailian.model}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                aliyun_bailian: {
                  ...current.aliyun_bailian,
                  model: event.target.value as BailianModel,
                },
              }))
            }
          >
            {BAILIAN_MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          服务部署
          <select
            className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
            value={config.aliyun_bailian.deployment}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                aliyun_bailian: {
                  ...current.aliyun_bailian,
                  deployment: event.target.value as BailianDeployment,
                },
              }))
            }
          >
            {BAILIAN_DEPLOYMENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-2 text-sm font-medium text-slate-700">
          输出能力
          <div className="flex min-h-10 flex-wrap gap-3 rounded-md border border-line bg-white px-3 py-2 text-sm text-slate-700">
            <label className="inline-flex items-center gap-2">
              <input
                checked={config.aliyun_bailian.enable_word_timestamps}
                type="checkbox"
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    aliyun_bailian: {
                      ...current.aliyun_bailian,
                      enable_word_timestamps: event.target.checked,
                    },
                  }))
                }
              />
              词级时间戳
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                checked={config.aliyun_bailian.enable_speaker_diarization}
                type="checkbox"
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    aliyun_bailian: {
                      ...current.aliyun_bailian,
                      enable_speaker_diarization: event.target.checked,
                    },
                  }))
                }
              />
              说话人分离
            </label>
          </div>
        </div>
      </div>
    );
  }

  if (config.provider === "google_chirp3") {
    return (
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          模型
          <input
            className="h-10 rounded-md border border-line bg-slate-50 px-3 text-sm text-slate-600"
            readOnly
            value={config.google_chirp3.model}
          />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Google 区域
          <select
            className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
            value={config.google_chirp3.region}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                google_chirp3: {
                  ...current.google_chirp3,
                  region: event.target.value as GoogleRegion,
                },
              }))
            }
          >
            {GOOGLE_REGION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Google Project ID
          <input
            className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
            placeholder="my-google-project"
            value={config.google_chirp3.project_id}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                google_chirp3: {
                  ...current.google_chirp3,
                  project_id: event.target.value,
                },
              }))
            }
          />
        </label>
      </div>
    );
  }

  if (config.provider === "volc_doubao") {
    return (
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Resource ID
          <input
            className="h-10 rounded-md border border-line bg-slate-50 px-3 text-sm text-slate-600"
            readOnly
            value={config.volc_doubao.resource_id}
          />
        </label>
      </div>
    );
  }

  return (
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      <label className="grid gap-2 text-sm font-medium text-slate-700">
        Whisper 模型
        <select
          className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
          value={config.local_whisper.model}
          onChange={(event) =>
            setConfig((current) => ({
              ...current,
              local_whisper: {
                ...current.local_whisper,
                model: event.target.value as WhisperModel,
              },
            }))
          }
        >
          {WHISPER_MODEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-2 text-sm font-medium text-slate-700">
        模型文件路径
        <input
          className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink"
          placeholder="/path/to/ggml-small.bin"
          value={config.local_whisper.model_path}
          onChange={(event) =>
            setConfig((current) => ({
              ...current,
              local_whisper: {
                ...current.local_whisper,
                model_path: event.target.value,
              },
            }))
          }
        />
      </label>
    </div>
  );
}

function credentialPlaceholder(provider: AsrProviderId) {
  if (provider === "google_chirp3") {
    return "粘贴 Google 服务账号 JSON。该内容不会写入项目文件。";
  }

  if (provider === "volc_doubao") {
    return "粘贴火山引擎 X-Api-Key。";
  }

  if (provider === "local_whisper") {
    return "本地 Whisper 不需要云端凭据。";
  }

  return "粘贴阿里云百炼 DashScope API Key。";
}

export default App;
