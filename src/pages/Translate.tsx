import React from "react";
import {
  FileVideo,
  Cpu,
  Volume2,
  Sliders,
  Sparkles,
  Zap,
  Captions,
  Languages,
  FolderOpen,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";
import { useI18n } from "../i18n";
import {
  BAILIAN_MODEL_OPTIONS,
  BAILIAN_TRANSLATION_MODEL_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  DOUBAO_TRANSLATION_MODEL_OPTIONS,
  DOUBAO_TTS_VOICE_OPTIONS,
  BAILIAN_TTS_VOICE_OPTIONS,
  ASR_PROVIDER_OPTIONS,
  TRANSLATION_PROVIDER_OPTIONS,
  TTS_PROVIDER_OPTIONS,
  DEEPSEEK_TRANSLATION_MODEL_OPTIONS,
  GOOGLE_TRANSLATION_MODEL_OPTIONS,
  LOCAL_LLM_TRANSLATION_MODEL_OPTIONS,
  SOURCE_LANGUAGE_OPTIONS,
  GOOGLE_REGION_OPTIONS,
  BAILIAN_DEPLOYMENT_OPTIONS,
  LOCAL_TTS_VOICE_OPTIONS,
} from "../lib/asrOptions";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CustomSelect } from "../components/CustomSelect";

export function Translate() {
  const {
    mediaInputMode,
    setMediaInputMode,
    mediaUrl,
    setMediaUrl,
    localMediaPath,
    setLocalMediaPath,
    config,
    setConfig,
    originalAudioVolume,
    setOriginalAudioVolume,
    replaceOriginalAudio,
    setReplaceOriginalAudio,
    ttsVoice,
    setTtsVoice,
    translationModel,
    setTranslationModel,
    showEnglishSubtitles,
    setShowEnglishSubtitles,
    showTargetLanguageSubtitles,
    setShowTargetLanguageSubtitles,
    startFullPipeline,
    synthesisMode,
    setSynthesisMode,
  } = useIntervox();

  const { t } = useI18n();

  const [isDragOver, setIsDragOver] = React.useState(false);
  const [currentStep, setCurrentStep] = React.useState<number>(1);
  const [thumbnailPath, setThumbnailPath] = React.useState<string | null>(null);
  const [thumbnailLoading, setThumbnailLoading] = React.useState(false);
  const [thumbnailError, setThumbnailError] = React.useState<string | null>(null);

  // Ensure we are in local_file mode when Translate page is loaded
  React.useEffect(() => {
    setMediaInputMode("local_file");
  }, [setMediaInputMode]);

  // Generate thumbnail via ffmpeg backend when localMediaPath changes
  React.useEffect(() => {
    if (!localMediaPath || !localMediaPath.trim()) {
      setThumbnailPath(null);
      setThumbnailError(null);
      return;
    }
    let cancelled = false;
    const generateThumbnail = async () => {
      setThumbnailLoading(true);
      setThumbnailError(null);
      setThumbnailPath(null);
      try {
        const result = await invoke<string>("generate_video_thumbnail", {
          inputPath: localMediaPath,
        });
        if (!cancelled) {
          setThumbnailPath(result);
        }
      } catch (e: any) {
        if (!cancelled) {
          console.error("Thumbnail generation failed:", e);
          setThumbnailError(typeof e === "string" ? e : e?.message || "缩略图生成失败");
        }
      } finally {
        if (!cancelled) {
          setThumbnailLoading(false);
        }
      }
    };
    generateThumbnail();
    return () => { cancelled = true; };
  }, [localMediaPath]);

  // Listen to Tauri native drag-drop events
  React.useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let isMounted = true;
    let unlisten: (() => void) | null = null;

    const setupDragDrop = async () => {
      try {
        const unsubscribe = await getCurrentWindow().onDragDropEvent((event) => {
          if (!isMounted) return;
          const type = event.payload.type;
          if (type === "enter" || type === "over") {
            setIsDragOver(true);
          } else if (type === "drop") {
            setIsDragOver(false);
            const paths = (event.payload as any).paths;
            if (paths && paths.length > 0) {
              const path = paths[0];
              setLocalMediaPath(path);
              setMediaInputMode("local_file");
            }
          } else if (type === "leave") {
            setIsDragOver(false);
          }
        });
        if (isMounted) {
          unlisten = unsubscribe;
        } else {
          unsubscribe();
        }
      } catch (err) {
        console.error("Failed to setup Tauri drag-drop event listener in Translate page:", err);
      }
    };

    void setupDragDrop();

    return () => {
      isMounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const handleSelectFile = async () => {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      try {
        const filePath = await invoke<string | null>("select_local_file");
        if (filePath) {
          setLocalMediaPath(filePath);
          setMediaInputMode("local_file");
        }
      } catch (e) {
        console.error("Failed to select file:", e);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const path = (file as any).path || "";
      if (path) {
        setLocalMediaPath(path);
        setMediaInputMode("local_file");
      } else {
        setLocalMediaPath(file.name);
        setMediaInputMode("local_file");
      }
    }
  };

  const activePath = localMediaPath;
  const isInputReady = activePath.trim().length > 0;
  const targetLanguageLabel =
    TARGET_LANGUAGE_OPTIONS.find((option) => option.value === config.target_language)?.label ||
    config.target_language;

  return (
    <div className="space-y-6 font-mono text-[13px] animate-fade-in">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b th-border pb-4">
        <div className="flex items-center gap-3">
          <Languages className="w-6 h-6 text-cyan-400" />
          <h2 className="text-xl font-bold th-text tracking-tight">
            {t("Translate")}
          </h2>
        </div>
      </div>

      <div className="flex flex-col gap-6 w-full">
        {/* Step Navigation Indicator */}
        <div className="flex items-center justify-between border th-border th-bg-card p-4 rounded-sm select-none">
          {[
            { step: 1, label: "资源选择" },
            { step: 2, label: "语音转录" },
            { step: 3, label: "文本翻译" },
            { step: 4, label: "配音合成" },
          ].map((item, idx) => {
            const isActive = currentStep === item.step;
            const isCompleted = currentStep > item.step;
            return (
              <React.Fragment key={item.step}>
                <button
                  onClick={() => setCurrentStep(item.step)}
                  className={`flex items-center gap-2.5 px-4 py-2 rounded transition-all font-bold text-xs uppercase tracking-widest border cursor-pointer ${
                    isActive
                      ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-sm text-glow"
                      : isCompleted
                      ? "border-cyan-500/20 text-cyan-400/70 hover:text-cyan-400 bg-cyan-950/5"
                      : "border-transparent th-text-muted hover:th-text"
                  }`}
                >
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] border transition-all ${
                    isActive
                      ? "border-cyan-400 bg-cyan-950 text-cyan-400 text-glow font-extrabold"
                      : isCompleted
                      ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-400"
                      : "th-border th-text-muted bg-black/20"
                  }`}>
                    {item.step}
                  </span>
                  <span>{item.label}</span>
                </button>

                {idx < 3 && (
                  <div className="flex-1 h-[2px] mx-4 bg-slate-800/80 relative overflow-hidden hidden md:block">
                    {currentStep > item.step && (
                      <div className="absolute inset-0 bg-gradient-to-r from-cyan-500 to-cyan-400" />
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Step Content */}
        {currentStep === 1 && (
          <div className="space-y-6 animate-fade-in">
            {/* Drag and Drop & File Select Area */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <FileVideo className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  第一步：选择视频/音频资源
                </span>
              </div>

              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border border-dashed p-8 rounded-sm text-center transition-all ${
                  isDragOver
                    ? "border-cyan-400 bg-cyan-500/10 scale-[1.01]"
                    : "th-border bg-black/10 hover:border-cyan-500/30"
                }`}
              >
                <FileVideo className={`w-12 h-12 mx-auto mb-3 transition-transform ${isDragOver ? "text-cyan-400 scale-110" : "th-text-muted"}`} />
                <p className="font-bold th-text mb-1">拖拽视频/音频文件到此处，或点击下方按钮选择</p>
                <p className="text-[11px] th-text-muted mb-4">支持 .mp4, .mp3, .wav, .mov, .mkv 等媒体格式</p>
                <div className="flex items-center gap-3 justify-center max-w-xl mx-auto">
                  <button
                    onClick={handleSelectFile}
                    className="px-4 py-2 bg-cyan-500/10 border border-cyan-500/30 hover:border-cyan-400 hover:bg-cyan-500/20 text-cyan-400 font-extrabold rounded-sm transition-all text-xs uppercase tracking-widest cursor-pointer flex-shrink-0"
                  >
                    选择本地文件
                  </button>
                  <input
                    type="text"
                    value={localMediaPath}
                    onChange={(e) => {
                      setLocalMediaPath(e.target.value);
                      setMediaInputMode("local_file");
                    }}
                    placeholder="或手动输入本地视频文件路径..."
                    className="flex-1 px-3 py-1.5 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 text-xs rounded-sm"
                  />
                </div>
              </div>
            </div>

            {/* Video Thumbnail Preview */}
            {localMediaPath && (
              <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
                <div className="flex items-center gap-2 border-b th-border pb-2">
                  <FileVideo className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold th-text uppercase tracking-widest text-xs">
                    媒体资源预览画面
                  </span>
                </div>
                <div className="border th-border rounded-sm overflow-hidden bg-black/40 flex flex-col items-center justify-center p-2 relative max-w-md mx-auto min-h-[180px]">
                  {thumbnailLoading && (
                    <div className="flex flex-col items-center gap-2 py-8">
                      <span className="w-3 h-3 rounded-full bg-cyan-400 animate-ping" />
                      <span className="text-[11px] text-cyan-400 font-bold uppercase tracking-widest">正在生成预览...</span>
                    </div>
                  )}
                  {thumbnailPath && !thumbnailLoading && (
                    <img
                      key={thumbnailPath}
                      src={convertFileSrc(thumbnailPath)}
                      alt="视频预览"
                      className="w-full h-auto max-h-[260px] object-contain rounded-sm"
                    />
                  )}
                  {thumbnailError && !thumbnailLoading && (
                    <div className="flex flex-col items-center gap-2 py-8">
                      <FileVideo className="w-10 h-10 th-text-muted" />
                      <span className="text-[11px] th-text-muted">无法生成预览画面</span>
                      <span className="text-[10px] th-text-muted break-all max-w-xs text-center">{thumbnailError}</span>
                    </div>
                  )}
                  {!thumbnailLoading && !thumbnailPath && !thumbnailError && (
                    <div className="flex flex-col items-center gap-2 py-8">
                      <FileVideo className="w-10 h-10 th-text-muted" />
                      <span className="text-[11px] th-text-muted">等待预览生成...</span>
                    </div>
                  )}
                  <div className="absolute top-4 right-4 bg-black/70 backdrop-blur-sm px-2 py-1 rounded text-[10px] text-cyan-400 font-bold border border-cyan-500/30">
                    画面自动预览
                  </div>
                </div>
                <div className="text-[11px] th-text-muted text-center break-all">
                  文件绝对路径: {localMediaPath}
                </div>
              </div>
            )}

            {/* Bottom Actions */}
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setCurrentStep(2)}
                disabled={!isInputReady}
                className={`px-6 py-2.5 font-extrabold rounded-sm transition-all shadow-md text-xs uppercase tracking-widest cursor-pointer ${
                  isInputReady
                    ? "bg-cyan-400 text-black hover:bg-cyan-300"
                    : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/30"
                }`}
              >
                下一步
              </button>
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-6 animate-fade-in">
            {/* ASR Config Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  第二步：ASR (语音识别与转录) 配置
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    ASR 引擎提供商
                  </label>
                  <CustomSelect
                    value={config.provider}
                    onChange={(provider) =>
                      setConfig((prev) => ({
                        ...prev,
                        provider,
                      }))
                    }
                    options={ASR_PROVIDER_OPTIONS}
                    className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    源视频语音语言 (Source Language)
                  </label>
                  <CustomSelect
                    value={config.source_language}
                    onChange={(sourceLang) =>
                      setConfig((prev) => ({
                        ...prev,
                        source_language: sourceLang as any,
                      }))
                    }
                    options={SOURCE_LANGUAGE_OPTIONS}
                    className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>

                {config.provider === "aliyun_bailian" && (
                  <>
                    <div className="space-y-1">
                      <label className="th-text-3 text-[10px] uppercase font-bold">
                        ASR 识别模型
                      </label>
                      <CustomSelect
                        value={config.aliyun_bailian.model}
                        onChange={(model) =>
                          setConfig((prev) => ({
                            ...prev,
                            aliyun_bailian: {
                              ...prev.aliyun_bailian,
                              model: model as any,
                            },
                          }))
                        }
                        options={BAILIAN_MODEL_OPTIONS}
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="th-text-3 text-[10px] uppercase font-bold">
                        阿里云部署节点
                      </label>
                      <CustomSelect
                        value={config.aliyun_bailian.deployment}
                        onChange={(deployment) =>
                          setConfig((prev) => ({
                            ...prev,
                            aliyun_bailian: {
                              ...prev.aliyun_bailian,
                              deployment: deployment as any,
                            },
                          }))
                        }
                        options={BAILIAN_DEPLOYMENT_OPTIONS}
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                      />
                    </div>
                  </>
                )}

                {config.provider === "local_whisper" && (
                  <>
                    <div className="space-y-1">
                      <label className="th-text-3 text-[10px] uppercase font-bold">
                        Whisper 本地模型规格 (请确保相应 bin 文件已在 models 目录下)
                      </label>
                      <CustomSelect
                        value={config.local_whisper.model}
                        onChange={(model) =>
                          setConfig((prev) => ({
                            ...prev,
                            local_whisper: {
                              ...prev.local_whisper,
                              model: model as any,
                            },
                          }))
                        }
                        options={[
                          { value: "small", label: "Small (推荐，速度与准确率平衡)" },
                          { value: "medium", label: "Medium (准确率更高，显存占用大)" },
                        ]}
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="th-text-3 text-[10px] uppercase font-bold">
                        Whisper 本地模型文件路径 (.bin)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={config.local_whisper.model_path || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setConfig((prev) => ({
                              ...prev,
                              local_whisper: {
                                ...prev.local_whisper,
                                model_path: val,
                              },
                            }));
                          }}
                          placeholder="例如: /Users/you/AI/whisper/models/ggml-small.bin"
                          className="flex-1 px-3 py-1.5 border th-border th-bg-input th-text rounded-lg focus:outline-none focus:border-cyan-500/50 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
                            try {
                              const filePath = await invoke<string | null>("select_whisper_model_file");
                              if (filePath) {
                                setConfig((prev) => ({
                                  ...prev,
                                  local_whisper: { ...prev.local_whisper, model_path: filePath },
                                }));
                              }
                            } catch (e) {
                              console.error("Browse model file failed:", e);
                            }
                          }}
                          className="px-3 py-1.5 border th-border text-slate-300 hover:border-cyan-500/40 hover:text-cyan-300 transition-all flex items-center gap-1 rounded-lg uppercase text-[10px] font-bold cursor-pointer whitespace-nowrap bg-black/20"
                          title="浏览文件系统选择模型"
                        >
                          <FolderOpen className="w-3.5 h-3.5" /> 浏览
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {config.provider === "google_chirp3" && (
                  <>
                    <div className="space-y-1">
                      <label className="th-text-3 text-[10px] uppercase font-bold">
                        Google Cloud Project ID
                      </label>
                      <input
                        type="text"
                        value={config.google_chirp3.project_id}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            google_chirp3: {
                              ...prev.google_chirp3,
                              project_id: e.target.value,
                            },
                          }))
                        }
                        placeholder="your-gcp-project-id"
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text focus:outline-none focus:border-cyan-500/50"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="th-text-3 text-[10px] uppercase font-bold">
                        GCP 区域节点 (Region)
                      </label>
                      <CustomSelect
                        value={config.google_chirp3.region}
                        onChange={(region) =>
                          setConfig((prev) => ({
                            ...prev,
                            google_chirp3: {
                              ...prev.google_chirp3,
                              region: region as any,
                            },
                          }))
                        }
                        options={GOOGLE_REGION_OPTIONS}
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                      />
                    </div>
                  </>
                )}

                {config.provider === "volc_doubao" && (
                  <div className="space-y-1 md:col-span-2">
                    <label className="th-text-3 text-[10px] uppercase font-bold">
                      火山引擎接入点 ID (Resource ID)
                    </label>
                    <input
                      type="text"
                      value={config.volc_doubao.resource_id}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          volc_doubao: {
                            ...prev.volc_doubao,
                            resource_id: e.target.value,
                          },
                        }))
                      }
                      placeholder="例如 volc.bigasr.auc_turbo"
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text focus:outline-none focus:border-cyan-500/50"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Source Subtitle Checkbox */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Captions className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  原文字幕配置
                </span>
              </div>
              <div>
                <label className="flex items-start gap-3 border th-border bg-black/20 p-3 cursor-pointer hover:border-cyan-500/40 transition-colors rounded-sm">
                  <input
                    type="checkbox"
                    checked={showEnglishSubtitles}
                    onChange={(event) => setShowEnglishSubtitles(event.target.checked)}
                    className="w-4 h-4 mt-0.5 border th-border rounded bg-transparent checked:bg-cyan-500 focus:outline-none"
                  />
                  <span className="space-y-1">
                    <span className="block th-text font-bold text-xs">
                      显示/刻录原语言字幕 (Source Subtitles)
                    </span>
                    <span className="block text-[10px] th-text-muted leading-relaxed">
                      开启后，将保留原视频音频转录出的字幕轨，并刻录在视频画面中。
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="flex justify-between pt-2">
              <button
                onClick={() => setCurrentStep(1)}
                className="px-6 py-2.5 border th-border th-text-3 hover:th-text hover:bg-cyan-950/10 font-extrabold rounded-sm transition-all text-xs uppercase tracking-widest cursor-pointer"
              >
                上一步
              </button>
              <button
                onClick={() => setCurrentStep(3)}
                className="px-6 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-black font-extrabold rounded-sm transition-all shadow-md text-xs uppercase tracking-widest cursor-pointer"
              >
                下一步
              </button>
            </div>
          </div>
        )}

        {currentStep === 3 && (
          <div className="space-y-6 animate-fade-in">
            {/* Translation Config Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Languages className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  第三步：Translation (文本翻译大模型) 配置
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    翻译引擎提供商
                  </label>
                  <CustomSelect
                    value={config.translation.provider}
                    onChange={(translationProvider) =>
                      setConfig((prev) => ({
                        ...prev,
                        translation: {
                          ...prev.translation,
                          provider: translationProvider as any,
                          model:
                            translationProvider === "aliyun_qwen"
                              ? "qwen-plus"
                              : translationProvider === "deepseek"
                              ? "deepseek-v4-flash"
                              : translationProvider === "google_translate"
                              ? "google-translate"
                              : translationProvider === "volc_speech_mt"
                              ? "volc-speech-mt"
                              : translationProvider === "local_llm"
                              ? "qwen2.5"
                              : "",
                        },
                      }))
                    }
                    options={TRANSLATION_PROVIDER_OPTIONS}
                    className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    目标语言 (Target Language)
                  </label>
                  <CustomSelect
                    value={config.target_language}
                    onChange={(targetLanguage) =>
                      setConfig((prev) => ({
                        ...prev,
                        target_language: targetLanguage,
                      }))
                    }
                    options={TARGET_LANGUAGE_OPTIONS}
                    className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    翻译模型选择 / 自定义输入
                  </label>
                  {config.translation.provider === "aliyun_qwen" && (
                    <CustomSelect
                      value={translationModel}
                      onChange={setTranslationModel}
                      options={BAILIAN_TRANSLATION_MODEL_OPTIONS}
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                    />
                  )}

                  {config.translation.provider === "deepseek" && (
                    <CustomSelect
                      value={translationModel}
                      onChange={setTranslationModel}
                      options={DEEPSEEK_TRANSLATION_MODEL_OPTIONS}
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                    />
                  )}

                  {config.translation.provider === "google_translate" && (
                    <CustomSelect
                      value={translationModel}
                      onChange={setTranslationModel}
                      options={GOOGLE_TRANSLATION_MODEL_OPTIONS}
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                    />
                  )}

                  {config.translation.provider === "volc_speech_mt" && (
                    <div className="p-3 border th-border bg-black/10 rounded text-[11px] th-text-muted leading-relaxed">
                      使用火山翻译服务进行高速机器翻译，无需额外选择大模型规格。
                    </div>
                  )}

                  {config.translation.provider === "local_llm" && (
                    <div className="space-y-2">
                      <CustomSelect
                        value={translationModel}
                        onChange={setTranslationModel}
                        options={LOCAL_LLM_TRANSLATION_MODEL_OPTIONS}
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                      />
                      <input
                        type="text"
                        value={translationModel}
                        onChange={(e) => setTranslationModel(e.target.value)}
                        placeholder="或者手动输入 Ollama 模型名称 (如 gemma2)..."
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text focus:outline-none focus:border-cyan-500/50"
                      />
                    </div>
                  )}

                  {config.translation.provider === "volc_ark" && (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={translationModel}
                        onChange={(e) => setTranslationModel(e.target.value)}
                        placeholder="请输入火山方舟大模型 Endpoint ID (例如 ep-202606...)"
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text focus:outline-none focus:border-cyan-500/50"
                      />
                      <p className="text-[10px] th-text-muted">
                        提示：请在火山方舟后台获取在线推理的 Endpoint 接入点 ID。
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Target Subtitle Checkbox */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Captions className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  目标字幕配置
                </span>
              </div>
              <div>
                <label className="flex items-start gap-3 border th-border bg-black/20 p-3 cursor-pointer hover:border-purple-500/40 transition-colors rounded-sm">
                  <input
                    type="checkbox"
                    checked={showTargetLanguageSubtitles}
                    onChange={(event) => setShowTargetLanguageSubtitles(event.target.checked)}
                    className="w-4 h-4 mt-0.5 border th-border rounded bg-transparent checked:bg-purple-500 focus:outline-none"
                  />
                  <span className="space-y-1">
                    <span className="block th-text font-bold text-xs">
                      显示/刻录翻译目标字幕 (Target Subtitles: {targetLanguageLabel})
                    </span>
                    <span className="block text-[10px] th-text-muted leading-relaxed">
                      开启后，将把翻译出的目标语言字幕刻录在视频画面底部。
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="flex justify-between pt-2">
              <button
                onClick={() => setCurrentStep(2)}
                className="px-6 py-2.5 border th-border th-text-3 hover:th-text hover:bg-cyan-950/10 font-extrabold rounded-sm transition-all text-xs uppercase tracking-widest cursor-pointer"
              >
                上一步
              </button>
              <button
                onClick={() => setCurrentStep(4)}
                className="px-6 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-black font-extrabold rounded-sm transition-all shadow-md text-xs uppercase tracking-widest cursor-pointer"
              >
                下一步
              </button>
            </div>
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-6 animate-fade-in">
            {/* TTS Engine Config Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Volume2 className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  第四步：TTS (语音合成) 引擎与音色配置
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1 md:col-span-2">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    TTS 语音合成提供商
                  </label>
                  <CustomSelect
                    value={config.tts.provider}
                    onChange={(ttsProvider) =>
                      setConfig((prev) => ({
                        ...prev,
                        tts: {
                          ...prev.tts,
                          provider: ttsProvider as any,
                          model:
                            ttsProvider === "aliyun_cosyvoice"
                              ? "cosyvoice-v3-flash"
                              : ttsProvider === "volc_doubao"
                              ? "seed-tts-2.0"
                              : "omnivoice:8",
                          voice:
                            ttsProvider === "volc_doubao"
                              ? "zh_female_vv_uranus_bigtts"
                              : ttsProvider === "aliyun_cosyvoice"
                              ? "longxiaochun_v3"
                              : "default",
                        },
                      }))
                    }
                    options={TTS_PROVIDER_OPTIONS}
                    className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    TTS 模型规格
                  </label>
                  {config.tts.provider === "aliyun_cosyvoice" && (
                    <CustomSelect
                      value={config.tts.model}
                      onChange={(model) =>
                        setConfig((prev) => ({
                          ...prev,
                          tts: { ...prev.tts, model },
                        }))
                      }
                      options={[
                        { value: "cosyvoice-v3-flash", label: "cosyvoice-v3-flash (闪电版)" },
                        { value: "cosyvoice-v3-clone", label: "cosyvoice-v3-clone (克隆版)" },
                      ]}
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                    />
                  )}

                  {config.tts.provider === "volc_doubao" && (
                    <CustomSelect
                      value={config.tts.model}
                      onChange={(model) =>
                        setConfig((prev) => ({
                          ...prev,
                          tts: { ...prev.tts, model },
                        }))
                      }
                      options={[
                        { value: "seed-tts-2.0", label: "Seed-TTS 2.0 (超真实语音合成)" },
                        { value: "seed-icl-2.0", label: "Seed-ICL 2.0 (情感与音色克隆)" },
                      ]}
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                    />
                  )}

                  {config.tts.provider === "local_tts" && (
                    <input
                      type="text"
                      value={config.tts.model}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          tts: { ...prev.tts, model: e.target.value },
                        }))
                      }
                      placeholder="例如 omnivoice:8"
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text focus:outline-none focus:border-cyan-500/50"
                    />
                  )}
                </div>

                {config.tts.provider === "local_tts" && (
                  <div className="space-y-1 md:col-span-2">
                    <label className="th-text-3 text-[10px] uppercase font-bold">
                      OmniVoice 本地 API 地址
                    </label>
                    <input
                      type="text"
                      value={config.tts.endpoint || ""}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          tts: { ...prev.tts, endpoint: e.target.value },
                        }))
                      }
                      placeholder="http://127.0.0.1:3900"
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text focus:outline-none focus:border-cyan-500/50 font-mono"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Synthesis Mode Options Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  配音合成发音模式
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {/* Option 1: Standard Voice Model */}
                <div
                  onClick={() => setSynthesisMode("default")}
                  className={`border p-4 rounded-sm cursor-pointer transition-all space-y-2 relative flex flex-col justify-between ${
                    synthesisMode === "default"
                      ? "border-cyan-400 bg-cyan-500/5"
                      : "th-border bg-black/20 hover:border-slate-600"
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="font-bold th-text text-[13px] tracking-wide">
                        预设发音人音色
                      </span>
                      <div
                        className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                          synthesisMode === "default"
                            ? "border-cyan-400 after:content-[''] after:w-1.5 after:h-1.5 after:bg-cyan-400 after:rounded-full"
                            : "th-border"
                        }`}
                      />
                    </div>
                    <p className="text-[11px] th-text-muted leading-relaxed mt-1">
                      使用各服务商提供的高质量标准发音人音色。
                    </p>
                  </div>
                  <ul className="text-[10px] th-text-2 font-semibold space-y-1 pt-2 font-mono uppercase tracking-wider border-t th-border mt-2">
                    {config.tts.provider === "volc_doubao" ? (
                      <li className="text-cyan-400">• SEED-TTS 2.0 (DEFAULT)</li>
                    ) : config.tts.provider === "local_tts" ? (
                      <li className="text-cyan-400">• LOCAL TTS VOICE (DEFAULT)</li>
                    ) : (
                      <>
                        <li className={ttsVoice === "longxiaochun_v3" ? "text-cyan-400" : "th-text-3"}>
                          • COSYVOICE-300M (DEFAULT)
                        </li>
                        <li className="th-text-3">• SAMBERT-HIGH-FIDELITY</li>
                      </>
                    )}
                  </ul>
                </div>

                {/* Option 2: Voice Cloning */}
                <div
                  onClick={() => setSynthesisMode("clone")}
                  className={`border p-4 rounded-sm cursor-pointer transition-all space-y-2 relative overflow-hidden flex flex-col justify-between ${
                    synthesisMode === "clone"
                      ? "border-purple-500 bg-purple-500/5"
                      : "th-border bg-black/20 hover:border-slate-600"
                  }`}
                >
                  <div className="absolute top-0 right-0 bg-purple-600 text-white font-extrabold text-[8px] uppercase tracking-widest px-2 py-0.5 rounded-bl-sm">
                    PREMIUM
                  </div>

                  <div>
                    <div className="flex items-center justify-between pt-1">
                      <span className="font-bold th-text text-[13px] tracking-wide flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-purple-400" /> 声音克隆 (Voice Cloning)
                      </span>
                      <div
                        className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                          synthesisMode === "clone"
                            ? "border-purple-500 after:content-[''] after:w-1.5 after:h-1.5 after:bg-purple-500 after:rounded-full"
                            : "th-border"
                        }`}
                      />
                    </div>
                    <p className="text-[11px] th-text-muted leading-relaxed mt-1">
                      提取并克隆原视频说话人的声线、情感和环境音色进行无缝配音。
                    </p>
                  </div>
                </div>
              </div>

              {synthesisMode === "default" && (
                <div className="space-y-1.5 pt-2 max-w-md">
                  <label className="block th-text-3 text-[10px] uppercase font-bold">
                    选择预设发音人音色
                  </label>
                  <CustomSelect
                    value={ttsVoice}
                    onChange={setTtsVoice}
                    options={
                      config.tts.provider === "volc_doubao"
                        ? DOUBAO_TTS_VOICE_OPTIONS
                        : config.tts.provider === "local_tts"
                        ? LOCAL_TTS_VOICE_OPTIONS
                        : BAILIAN_TTS_VOICE_OPTIONS
                    }
                    className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                  />
                </div>
              )}
            </div>

            {/* Audio Mix Configuration Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Volume2 className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  音频混合与背景音量
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center pt-2">
                <div className="md:col-span-2 space-y-3">
                  <div className="flex justify-between items-center text-xs">
                    <span className="th-text-2">原视频背景音量保留比例</span>
                    <span className="text-cyan-400 font-bold border border-cyan-500/20 px-1.5 py-0.5 rounded bg-cyan-500/5">
                      {replaceOriginalAudio ? "0%" : `${Math.round(originalAudioVolume * 100)}%`}
                    </span>
                  </div>

                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={originalAudioVolume}
                    disabled={replaceOriginalAudio}
                    onChange={(e) => setOriginalAudioVolume(parseFloat(e.target.value))}
                    className="w-full accent-cyan-400 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
                  />

                  <div className="flex justify-between th-text-muted text-[10px] font-bold">
                    <span>完全静音 (MUTE)</span>
                    <span>原音直达 (FULL)</span>
                  </div>
                </div>

                <div className="flex justify-start md:justify-end">
                  <label className="flex items-center gap-3 cursor-pointer p-4 border th-border bg-black/20 hover:border-cyan-500/40 rounded-sm w-full md:w-auto transition-colors">
                    <input
                      type="checkbox"
                      checked={replaceOriginalAudio}
                      onChange={(e) => setReplaceOriginalAudio(e.target.checked)}
                      className="w-4 h-4 border th-border rounded bg-transparent checked:bg-cyan-500 focus:outline-none"
                    />
                    <span className="th-text-2 font-medium">
                      完全静音原视频背景音
                    </span>
                  </label>
                </div>
              </div>
            </div>

            {/* Bottom Actions & Action Button */}
            <div className="flex flex-col gap-4 pt-2">
              <div className="flex justify-start">
                <button
                  onClick={() => setCurrentStep(3)}
                  className="px-6 py-2.5 border th-border th-text-3 hover:th-text hover:bg-cyan-950/10 font-extrabold rounded-sm transition-all text-xs uppercase tracking-widest cursor-pointer"
                >
                  上一步
                </button>
              </div>

              <div className="flex justify-center pt-2 pb-6">
                <button
                  onClick={startFullPipeline}
                  disabled={!isInputReady}
                  className={`w-full py-4 text-sm font-extrabold tracking-widest transition-all uppercase rounded-sm flex items-center justify-center gap-2.5 shadow-lg border border-transparent ${
                    isInputReady
                      ? "bg-cyan-400 text-black hover:bg-cyan-300 shadow-cyan-500/10 cursor-pointer"
                      : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/30"
                  }`}
                >
                  <Zap className={`w-4 h-4 ${isInputReady ? "animate-pulse" : ""}`} />
                  一键启动翻译与合成配音 (START PROCESS)
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
