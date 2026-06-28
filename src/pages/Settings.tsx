import React from "react";
import {
  Save,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  FolderOpen,
  Eye,
  EyeOff,
  Cpu,
  Monitor,
  Settings as SettingsIcon,
  Search,
  HardDrive,
  Info,
  XCircle,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";
import { invoke } from "@tauri-apps/api/core";
import {
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  WHISPER_MODEL_OPTIONS,
} from "../lib/asrOptions";
import { CustomSelect } from "../components/CustomSelect";
import { useI18n } from "../i18n";
import type { AsrConfig } from "../types/asr";

/** Local Inference Services sub-tab – handles Whisper model auto-detection, file browsing, and Ollama endpoint. */
function LocalInferenceTab({
  config,
  setConfig,
  t,
}: {
  config: AsrConfig;
  setConfig: React.Dispatch<React.SetStateAction<AsrConfig>>;
  t: any;
}) {
  const [detectedModels, setDetectedModels] = React.useState<string[]>([]);
  const [isDetecting, setIsDetecting] = React.useState(false);
  const [hasDetected, setHasDetected] = React.useState(false);

  const modelPathConfigured = !!(config.local_whisper.model_path || "").trim();
  const endpointConfigured = !!(config.local_whisper.translation_endpoint || "").trim();

  // Determine overall status
  const statusLabel = modelPathConfigured
    ? "模型已配置"
    : "未配置模型路径";
  const statusOk = modelPathConfigured;

  const handleAutoDetect = async () => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    setIsDetecting(true);
    try {
      const models = await invoke<string[]>("detect_whisper_models");
      setDetectedModels(models);
      setHasDetected(true);
      if (models.length === 1) {
        // Auto-fill if only one model found
        setConfig((prev) => ({
          ...prev,
          local_whisper: { ...prev.local_whisper, model_path: models[0] },
        }));
      }
    } catch (e) {
      console.error("Auto-detect failed:", e);
    } finally {
      setIsDetecting(false);
    }
  };

  const handleBrowseModel = async () => {
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
  };

  return (
    <div className="border th-border bg-black/30 p-4 rounded-sm space-y-5">
      {/* Header with dynamic status */}
      <div className="flex items-center justify-between">
        <span className="font-extrabold th-text tracking-wide text-xs">
          {t("Local Inference Service")}
        </span>
        <span
          className={`text-[11px] flex items-center gap-1 ${
            statusOk ? "text-emerald-400" : "text-amber-400"
          }`}
        >
          {statusOk ? (
            <CheckCircle className="w-3.5 h-3.5" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5" />
          )}
          {statusLabel}
        </span>
      </div>

      {/* ── Whisper ASR Section ── */}
      <div className="border th-border rounded-sm p-3 space-y-3 bg-black/20">
        <div className="flex items-center gap-2 border-b th-border pb-2">
          <HardDrive className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-[11px] font-bold th-text uppercase tracking-widest">
            本地语音识别 (Whisper)
          </span>
        </div>

        {/* Model Size */}
        <div className="space-y-1.5">
          <label className="block th-text-3 font-semibold uppercase text-[11px]">
            {t("Whisper Model")} (Size)
          </label>
          <CustomSelect
            value={config.local_whisper.model}
            onChange={(modelVal) =>
              setConfig((prev) => ({
                ...prev,
                local_whisper: {
                  ...prev.local_whisper,
                  model: modelVal as any,
                },
              }))
            }
            options={WHISPER_MODEL_OPTIONS}
            className="w-full rounded-lg border th-border th-bg-input px-3 py-2 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
          />
        </div>

        {/* Model Path with Browse + Auto-detect */}
        <div className="space-y-1.5">
          <label className="block th-text-muted text-[10px] font-bold uppercase">
            {t("Whisper Model")} Path (ggml-model.bin)
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
              placeholder="e.g. /Users/you/AI/whisper/models/ggml-small.bin"
              className="flex-1 px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 font-mono text-xs"
            />
            <button
              onClick={handleBrowseModel}
              className="px-3 py-2 border th-border text-slate-300 hover:border-cyan-500/40 hover:text-cyan-300 transition-all flex items-center gap-1.5 uppercase text-[10px] font-bold cursor-pointer whitespace-nowrap"
              title="浏览文件系统选择模型"
            >
              <FolderOpen className="w-3.5 h-3.5" /> 浏览
            </button>
            <button
              onClick={handleAutoDetect}
              disabled={isDetecting}
              className="px-3 py-2 border th-border text-slate-300 hover:border-cyan-500/40 hover:text-cyan-300 transition-all flex items-center gap-1.5 uppercase text-[10px] font-bold cursor-pointer whitespace-nowrap disabled:opacity-50"
              title="自动扫描常见路径查找已下载的模型文件"
            >
              <Search className="w-3.5 h-3.5" />
              {isDetecting ? "扫描中..." : "自动检测"}
            </button>
          </div>

          {/* Auto-detect results */}
          {hasDetected && (
            <div className="mt-2">
              {detectedModels.length === 0 ? (
                <div className="border border-amber-500/20 bg-amber-500/5 rounded-sm px-3 py-2 text-[11px] text-amber-300 flex items-center gap-1.5">
                  <XCircle className="w-3.5 h-3.5" />
                  未在常见路径中找到 Whisper 模型文件，请手动浏览选择或填写完整路径。
                </div>
              ) : (
                <div className="border border-emerald-500/20 bg-emerald-500/5 rounded-sm px-3 py-2 space-y-1.5">
                  <div className="text-[11px] text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle className="w-3.5 h-3.5" />
                    找到 {detectedModels.length} 个模型文件：
                  </div>
                  {detectedModels.map((modelPath) => (
                    <button
                      key={modelPath}
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          local_whisper: {
                            ...prev.local_whisper,
                            model_path: modelPath,
                          },
                        }))
                      }
                      className={`block w-full text-left px-2 py-1 rounded text-[11px] font-mono transition-all cursor-pointer ${
                        config.local_whisper.model_path === modelPath
                          ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                          : "text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10"
                      }`}
                    >
                      {modelPath}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] th-text-muted mt-1">
            Whisper.cpp 使用的 GGML 格式模型文件。如果尚未下载，可从{" "}
            <a
              href="https://huggingface.co/ggerganov/whisper.cpp/tree/main"
              target="_blank"
              rel="noreferrer"
              className="text-cyan-500 hover:text-cyan-400 underline"
            >
              HuggingFace
            </a>
            {" "}获取。
          </p>
        </div>
      </div>

      {/* ── Local Translation Endpoint Section ── */}
      <div className="border th-border rounded-sm p-3 space-y-3 bg-black/20">
        <div className="flex items-center gap-2 border-b th-border pb-2">
          <Cpu className="w-3.5 h-3.5 text-violet-400" />
          <span className="text-[11px] font-bold th-text uppercase tracking-widest">
            本地翻译大模型端点
          </span>
        </div>

        <div className="space-y-1.5">
          <label className="block th-text-muted text-[10px] font-bold uppercase">
            {t("Local Translation Endpoint")} (Ollama / Local LLM)
          </label>
          <input
            type="text"
            value={config.local_whisper.translation_endpoint || ""}
            onChange={(e) => {
              const val = e.target.value;
              setConfig((prev) => ({
                ...prev,
                local_whisper: {
                  ...prev.local_whisper,
                  translation_endpoint: val,
                },
              }));
            }}
            placeholder="e.g. http://localhost:11434/v1"
            className="w-full px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 font-mono text-xs"
          />
          {endpointConfigured && (
            <div className="text-[11px] text-emerald-400 flex items-center gap-1 mt-1">
              <CheckCircle className="w-3 h-3" /> 端点已配置
            </div>
          )}
        </div>

        <div className="border th-border rounded-sm bg-black/30 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Info className="w-3.5 h-3.5 text-cyan-500 mt-0.5 shrink-0" />
            <div className="text-[11px] th-text-muted space-y-1.5">
              <p>
                <strong className="text-slate-300">此端点用于本地文字翻译</strong>，即在「翻译阶段」中使用本地运行的大语言模型（如 Ollama 部署的 Qwen、LLaMA 等）来翻译 ASR 生成的字幕文本。
              </p>
              <p>
                如果您已安装{" "}
                <a href="https://ollama.com" target="_blank" rel="noreferrer" className="text-cyan-500 hover:text-cyan-400 underline">Ollama</a>
                ，默认端点为{" "}
                <code className="bg-black/50 px-1 py-0.5 rounded text-cyan-400 text-[10px]">http://localhost:11434/v1</code>
                。启动 Ollama 并下载翻译模型后即可使用。
              </p>
              <p className="text-amber-400/80">
                注意：此选项与 Whisper 语音识别无关。如果不需要本地翻译（使用 DeepSeek / Google Translate 等云端翻译），可以留空。
              </p>
            </div>
          </div>
        </div>
      </div>

      <p className="text-[11px] th-text-muted">
        配置本地语音识别（Whisper）或本地翻译节点（如 Ollama），使您的处理流程完全离线且数据私密安全。
      </p>
    </div>
  );
}

export function Settings() {
  const {
    theme,
    setTheme,
    config,
    setConfig,
    synthesisMode,
    setSynthesisMode,
    credentialDraft,
    setCredentialDraft,
    status,
    saveCredential,
    validateProvider,
    isSavingCredential,
    outputDir,
    setOutputDir,
    showToast,
    volcCredentialDraft,
    setVolcCredentialDraft,
    volcAppIdDraft,
    setVolcAppIdDraft,
    volcStatus,
    saveVolcCredential,
    validateVolcProvider,
    isSavingVolcCredential,
    deepseekCredentialDraft,
    setDeepseekCredentialDraft,
    deepseekStatus,
    saveDeepseekCredential,
    validateDeepseekProvider,
    isSavingDeepseekCredential,
    googleTranslateCredentialDraft,
    setGoogleTranslateCredentialDraft,
    googleTranslateStatus,
    saveGoogleTranslateCredential,
    validateGoogleTranslateProvider,
    isSavingGoogleTranslateCredential,
  } = useIntervox();

  const { t, language, setLanguage } = useI18n();

  const [showKey, setShowKey] = React.useState(false);
  const [showVolcKey, setShowVolcKey] = React.useState(false);
  const [showDeepseekKey, setShowDeepseekKey] = React.useState(false);
  const [showGoogleKey, setShowGoogleKey] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<"bailian" | "volc" | "local" | "deepseek" | "google">("bailian");

  const handleBrowseOutputDir = async () => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      showToast("浏览器预览无法打开系统目录选择器，请手动填写路径或使用桌面应用。", "info");
      return;
    }

    try {
      const folderPath = await invoke<string | null>("select_local_directory");
      if (folderPath) {
        setOutputDir(folderPath);
      }
    } catch (e) {
      console.error("Failed to select output directory:", e);
      showToast("无法打开系统目录选择器，请手动填写输出路径。", "error");
    }
  };

  const handleApplyChanges = () => {
    // Save output location and validate
    showToast(t("Configuration saved successfully!"), "success");
  };

  const handleReset = () => {
    // Reset config
    if (confirm(t("Are you sure you want to reset all settings to defaults?"))) {
      window.location.reload();
    }
  };

  return (
    <div className="space-y-6 font-mono text-[13px] animate-fade-in">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b th-border pb-4">
        <div className="flex items-center gap-3">
          <SettingsIcon className="w-6 h-6 text-cyan-400" />
          <h2 className="text-xl font-bold th-text tracking-tight">
            {t("Settings")}
          </h2>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {/* Output Routing Card */}
        <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm relative">
          <div className="flex items-center gap-2 border-b th-border pb-2">
            <FolderOpen className="w-4 h-4 text-cyan-400" />
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              {t("OUTPUT ROUTING")}
            </span>
          </div>

          <div className="space-y-3">
            <div className="space-y-2">
              <label className="block th-text-3 font-semibold uppercase text-[11px]">
                {t("BASE_DIRECTORY_PATH")}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                  placeholder="/Volumes/Data/InterVox/Exports"
                  className="flex-1 px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50"
                />
                <button
                  onClick={handleBrowseOutputDir}
                  className="px-4 py-2 border th-border hover:bg-cyan-500/10 text-cyan-400 transition-all font-semibold uppercase text-[11px]"
                >
                  {t("BROWSE")}
                </button>
              </div>
            </div>

            <p className="pt-2 th-text-2 text-xs">
              {t("Temporary ASR audio, voice-clone slices, and playback previews are retained under this directory.")}
            </p>
          </div>
        </div>

        {/* Processing Defaults Card */}
        <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
          <div className="flex items-center gap-2 border-b th-border pb-2">
            <CheckCircle className="w-4 h-4 text-cyan-400" />
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              {t("GLOBAL PREFERENCES")}
            </span>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block th-text-3 font-semibold uppercase text-[11px]">
                  {t("AUTO_DETECT_LANG")}
                </label>
                <CustomSelect
                  value={config.source_language}
                  onChange={(sourceLanguage) =>
                    setConfig((prev) => ({
                      ...prev,
                      source_language: sourceLanguage,
                    }))
                  }
                  options={SOURCE_LANGUAGE_OPTIONS}
                  className="w-full rounded-lg border th-border th-bg-input px-3 py-2 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                />
              </div>

              <div className="space-y-2">
                <label className="block th-text-3 font-semibold uppercase text-[11px]">
                  {t("DEFAULT_TARGET_LANG")}
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
                  className="w-full rounded-lg border th-border th-bg-input px-3 py-2 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="th-text-2 font-medium">{t("ENABLE_VOICE_CLONE")}</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={synthesisMode === "clone"}
                  onChange={(e) => setSynthesisMode(e.target.checked ? "clone" : "default")}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-500 peer-checked:after:bg-black"></div>
              </label>
            </div>
          </div>
        </div>

        {/* Interface & Appearance Card */}
        <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
          <div className="flex items-center gap-2 border-b th-border pb-2">
            <Monitor className="w-4 h-4 text-cyan-400" />
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              {t("INTERFACE & APPEARANCE")}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* UI Language configuration */}
            <div className="space-y-2">
              <label className="block th-text-3 font-semibold uppercase text-[11px]">
                {t("UI_LANGUAGE")}
              </label>
              <CustomSelect
                value={language}
                onChange={(lang) => setLanguage(lang as any)}
                options={[
                  { value: "zh", label: "简体中文" },
                  { value: "en", label: "英文" },
                ]}
                className="w-full rounded-lg border th-border th-bg-input px-3 py-2 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
              />
            </div>

            {/* UI Theme configuration */}
            <div className="space-y-2">
              <label className="block th-text-3 font-semibold uppercase text-[11px]">
                {t("UI_THEME")}
              </label>
              <CustomSelect
                value={theme}
                onChange={(themeValue) => setTheme(themeValue as any)}
                options={[
                  { value: "dark", label: t("Dark Theme") },
                  { value: "light", label: t("Light Theme") },
                ]}
                className="w-full rounded-lg border th-border th-bg-input px-3 py-2 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
              />
            </div>
          </div>
        </div>

        {/* LLM & Inference Endpoints */}
        <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
          <div className="flex items-center justify-between border-b th-border pb-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span className="font-bold th-text uppercase tracking-widest text-xs">
                {t("INFERENCE PROVIDERS CREDENTIALS")}
              </span>
            </div>
            <span className="text-[10px] font-bold text-cyan-400 uppercase border border-cyan-500/20 px-2 py-0.5 rounded-full bg-cyan-500/5">
              {t("NODE.SECURE")}
            </span>
          </div>

          {/* Horizontal Tabs Header */}
          <div className="flex border-b th-border mb-4 overflow-x-auto whitespace-nowrap scrollbar-none">
            <button
              onClick={() => setActiveTab("bailian")}
              className={`px-4 py-2 font-bold text-xs uppercase tracking-wider border-b-2 transition-all ${
                activeTab === "bailian"
                  ? "border-cyan-500 text-cyan-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              [ {t("Alibaba Bailian API")} ]
            </button>
            <button
              onClick={() => setActiveTab("volc")}
              className={`px-4 py-2 font-bold text-xs uppercase tracking-wider border-b-2 transition-all ${
                activeTab === "volc"
                  ? "border-cyan-500 text-cyan-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              [ {t("Volcengine Speech API")} ]
            </button>
            <button
              onClick={() => setActiveTab("deepseek")}
              className={`px-4 py-2 font-bold text-xs uppercase tracking-wider border-b-2 transition-all ${
                activeTab === "deepseek"
                  ? "border-cyan-500 text-cyan-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              [ DeepSeek API ]
            </button>
            <button
              onClick={() => setActiveTab("google")}
              className={`px-4 py-2 font-bold text-xs uppercase tracking-wider border-b-2 transition-all ${
                activeTab === "google"
                  ? "border-cyan-500 text-cyan-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              [ Google Translate API ]
            </button>
            <button
              onClick={() => setActiveTab("local")}
              className={`px-4 py-2 font-bold text-xs uppercase tracking-wider border-b-2 transition-all ${
                activeTab === "local"
                  ? "border-cyan-500 text-cyan-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              [ {t("Local Inference Service")} ]
            </button>
          </div>

          <div className="pt-2">
            {/* Alibaba Bailian Endpoint */}
            {activeTab === "bailian" && (
              <div className="border th-border bg-black/30 p-4 rounded-sm space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold th-text tracking-wide text-xs">
                    {t("ALIBABA_BAILIAN_API")}
                  </span>
                  {status?.ok ? (
                    <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" /> {t("Active")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-500 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 animate-bounce" /> {t("Missing Key")}
                    </span>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="block th-text-muted text-[10px] font-bold uppercase">
                      {t("AUTHORIZATION_BEARER")}
                    </label>
                    <div className="flex gap-2 relative">
                      <input
                        type={showKey ? "text" : "password"}
                        value={credentialDraft}
                        onChange={(e) => setCredentialDraft(e.target.value)}
                        placeholder={status?.ok ? `•••••••••••••••••••••••• (${t("Saved")})` : "sk-..."}
                        className="flex-1 px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 pr-10 font-mono"
                      />
                      <button
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-2 top-2.5 th-text-muted hover:th-text"
                      >
                        {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={saveCredential}
                      disabled={isSavingCredential || !credentialDraft.trim()}
                      className="px-3 py-2 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all flex items-center gap-2 uppercase text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Save className="w-3.5 h-3.5" /> {t("Save Bearer")}
                    </button>
                    <button
                      onClick={validateProvider}
                      className="px-3 py-2 border th-border text-slate-300 hover:border-slate-500 transition-all flex items-center gap-2 uppercase text-[11px] font-bold"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> {t("Validate Endpoint")}
                    </button>
                  </div>

                  {status && (
                    <div
                      className={`border p-2.5 text-xs rounded-sm ${
                        status.ok
                          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                          : "border-red-500/20 bg-red-500/5 text-red-300"
                      }`}
                    >
                      {status.message}
                    </div>
                  )}
                </div>
                <p className="text-[11px] th-text-muted mt-2">
                  {t("Required for deep semantic context translation, ASR processing, and zero-shot voice cloning synthetic pipelines.")}
                </p>
              </div>
            )}

            {/* Volcengine Doubao Endpoint */}
            {activeTab === "volc" && (
              <div className="border th-border bg-black/30 p-4 rounded-sm space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold th-text tracking-wide text-xs">
                    {t("VOLCENGINE_SPEECH_API")}
                  </span>
                  {volcStatus?.ok ? (
                    <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" /> {t("Active")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-500 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 animate-bounce" /> {t("Missing Key")}
                    </span>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="block th-text-muted text-[10px] font-bold uppercase">
                      {t("APP_ID")}
                    </label>
                    <input
                      type="text"
                      value={config.volc_doubao.app_id || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setConfig((prev) => ({
                          ...prev,
                          volc_doubao: {
                            ...prev.volc_doubao,
                            app_id: val,
                          }
                        }));
                      }}
                      placeholder="your-volcengine-app-id"
                      className="w-full px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 font-mono"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="block th-text-muted text-[10px] font-bold uppercase">
                      {t("RESOURCE_ID")}
                    </label>
                    <input
                      type="text"
                      value={config.volc_doubao.resource_id || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setConfig((prev) => ({
                          ...prev,
                          volc_doubao: {
                            ...prev.volc_doubao,
                            resource_id: val,
                          }
                        }));
                      }}
                      placeholder="默认: volc.bigasr.auc_turbo (极速版)"
                      className="w-full px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 font-mono"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="block th-text-muted text-[10px] font-bold uppercase">
                      Seed-TTS / Seed-ICL Resource ID
                    </label>
                    <input
                      type="text"
                      value={config.tts?.tts_resource_id || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setConfig((prev) => ({
                          ...prev,
                          tts: {
                            ...prev.tts,
                            tts_resource_id: val,
                          }
                        }));
                      }}
                      placeholder="默认: seed-tts-2.0 / seed-icl-2.0"
                      className="w-full px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 font-mono"
                    />
                    <p className="text-[10px] th-text-muted">
                      声音复刻请确认控制台已开通 Seed-ICL 2.0，勿填写 ASR 的 volc.bigasr.auc_turbo。
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="block th-text-muted text-[10px] font-bold uppercase">
                      {t("AUTHORIZATION_BEARER")} (Speech API Key)
                    </label>
                    <div className="flex gap-2 relative">
                      <input
                        type={showVolcKey ? "text" : "password"}
                        value={volcCredentialDraft}
                        onChange={(e) => setVolcCredentialDraft(e.target.value)}
                        placeholder={volcStatus?.ok ? `•••••••••••••••••••••••• (${t("Saved")})` : "请输入在「豆包语音」控制台申请的 API Key"}
                        className="flex-1 px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 pr-10 font-mono"
                      />
                      <button
                        onClick={() => setShowVolcKey(!showVolcKey)}
                        className="absolute right-2 top-2.5 th-text-muted hover:th-text"
                      >
                        {showVolcKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={saveVolcCredential}
                      disabled={isSavingVolcCredential || !volcCredentialDraft.trim()}
                      className="px-3 py-2 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all flex items-center gap-2 uppercase text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Save className="w-3.5 h-3.5" /> {t("Save Bearer")}
                    </button>
                    <button
                      onClick={validateVolcProvider}
                      className="px-3 py-2 border th-border text-slate-300 hover:border-slate-500 transition-all flex items-center gap-2 uppercase text-[11px] font-bold"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> {t("Validate Endpoint")}
                    </button>
                  </div>

                  {volcStatus && (
                    <div
                      className={`border p-2.5 text-xs rounded-sm ${
                        volcStatus.ok
                          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                          : "border-red-500/20 bg-red-500/5 text-red-300"
                      }`}
                    >
                      {volcStatus.message}
                    </div>
                  )}
                </div>
                <p className="text-[11px] th-text-muted mt-2">
                  {t("Used for Doubao ASR, Volcengine MT, and SEED-TTS synthesis. MT requires activation first.")}
                </p>
              </div>
            )}

            {/* DeepSeek API Endpoint */}
            {activeTab === "deepseek" && (
              <div className="border th-border bg-black/30 p-4 rounded-sm space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold th-text tracking-wide text-xs">
                    DEEPSEEK TRANSLATION API
                  </span>
                  {deepseekStatus?.ok ? (
                    <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" /> {t("Active")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-500 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 animate-bounce" /> {t("Missing Key")}
                    </span>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="block th-text-muted text-[10px] font-bold uppercase">
                      DeepSeek API Key (Authorization Bearer)
                    </label>
                    <div className="flex gap-2 relative">
                      <input
                        type={showDeepseekKey ? "text" : "password"}
                        value={deepseekCredentialDraft}
                        onChange={(e) => setDeepseekCredentialDraft(e.target.value)}
                        placeholder={deepseekStatus?.ok ? `•••••••••••••••••••••••• (${t("Saved")})` : "sk-..."}
                        className="flex-1 px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 pr-10 font-mono"
                      />
                      <button
                        onClick={() => setShowDeepseekKey(!showDeepseekKey)}
                        className="absolute right-2 top-2.5 th-text-muted hover:th-text"
                      >
                        {showDeepseekKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={saveDeepseekCredential}
                      disabled={isSavingDeepseekCredential || !deepseekCredentialDraft.trim()}
                      className="px-3 py-2 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all flex items-center gap-2 uppercase text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Save className="w-3.5 h-3.5" /> {t("Save Bearer")}
                    </button>
                    <button
                      onClick={validateDeepseekProvider}
                      className="px-3 py-2 border th-border text-slate-300 hover:border-slate-500 transition-all flex items-center gap-2 uppercase text-[11px] font-bold"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> {t("Validate Endpoint")}
                    </button>
                  </div>

                  {deepseekStatus && (
                    <div
                      className={`border p-2.5 text-xs rounded-sm ${
                        deepseekStatus.ok
                          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                          : "border-red-500/20 bg-red-500/5 text-red-300"
                      }`}
                    >
                      {deepseekStatus.message}
                    </div>
                  )}
                </div>
                <p className="text-[11px] th-text-muted mt-2">
                  用于进行大模型的高保真智能多语种翻译。请在 DeepSeek 开放平台获取您的 API Key。
                </p>
              </div>
            )}

            {/* Google Translate API Endpoint */}
            {activeTab === "google" && (
              <div className="border th-border bg-black/30 p-4 rounded-sm space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold th-text tracking-wide text-xs">
                    GOOGLE TRANSLATION API
                  </span>
                  {googleTranslateStatus?.ok ? (
                    <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" /> {t("Active")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-500 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 animate-bounce" /> {t("Missing Key")}
                    </span>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="block th-text-muted text-[10px] font-bold uppercase">
                      Google Cloud Translation API Key
                    </label>
                    <div className="flex gap-2 relative">
                      <input
                        type={showGoogleKey ? "text" : "password"}
                        value={googleTranslateCredentialDraft}
                        onChange={(e) => setGoogleTranslateCredentialDraft(e.target.value)}
                        placeholder={googleTranslateStatus?.ok ? `•••••••••••••••••••••••• (${t("Saved")})` : "AIzaSy..."}
                        className="flex-1 px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50 pr-10 font-mono"
                      />
                      <button
                        onClick={() => setShowGoogleKey(!showGoogleKey)}
                        className="absolute right-2 top-2.5 th-text-muted hover:th-text"
                      >
                        {showGoogleKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={saveGoogleTranslateCredential}
                      disabled={isSavingGoogleTranslateCredential || !googleTranslateCredentialDraft.trim()}
                      className="px-3 py-2 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all flex items-center gap-2 uppercase text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Save className="w-3.5 h-3.5" /> {t("Save Bearer")}
                    </button>
                    <button
                      onClick={validateGoogleTranslateProvider}
                      className="px-3 py-2 border th-border text-slate-300 hover:border-slate-500 transition-all flex items-center gap-2 uppercase text-[11px] font-bold"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> {t("Validate Endpoint")}
                    </button>
                  </div>

                  {googleTranslateStatus && (
                    <div
                      className={`border p-2.5 text-xs rounded-sm ${
                        googleTranslateStatus.ok
                          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                          : "border-red-500/20 bg-red-500/5 text-red-300"
                      }`}
                    >
                      {googleTranslateStatus.message}
                    </div>
                  )}
                </div>
                <p className="text-[11px] th-text-muted mt-2">
                  用于通过 Google 官方翻译通道进行传统的多语种高准确字幕翻译。
                </p>
              </div>
            )}

            {/* Local Inference Endpoint */}
            {activeTab === "local" && (
              <LocalInferenceTab config={config} setConfig={setConfig} t={t} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
