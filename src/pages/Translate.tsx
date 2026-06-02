import React from "react";
import {
  FileVideo,
  Cpu,
  Volume2,
  Sliders,
  Sparkles,
  Zap,
  Captions,
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
} from "../lib/asrOptions";
import { invoke } from "@tauri-apps/api/core";
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

  const handleSelectFile = async () => {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      try {
        const filePath = await invoke<string | null>("select_local_file");
        if (filePath) {
          setLocalMediaPath(filePath);
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
      } else {
        setLocalMediaPath(file.name);
      }
    }
  };

  const activePath = mediaInputMode === "public_url" ? mediaUrl : localMediaPath;
  const isInputReady = activePath.trim().length > 0;
  const targetLanguageLabel =
    TARGET_LANGUAGE_OPTIONS.find((option) => option.value === config.target_language)?.label ||
    config.target_language;

  return (
    <div className="space-y-6 font-mono text-[13px] animate-fade-in">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b th-border pb-4">
        <div>
          <h2 className="text-xl font-bold th-text tracking-tight">
            {t("Configuration Studio")}
          </h2>
          <p className="text-xs th-text-muted mt-1 uppercase tracking-wider">
            {t("Define processing pipelines & synthesis variables")}
          </p>
        </div>
        <div>
          <button
            onClick={startFullPipeline}
            disabled={!isInputReady}
            className={`px-5 py-2 text-black font-extrabold tracking-widest transition-all uppercase shadow-md ${
              isInputReady
                ? "bg-cyan-400 hover:bg-cyan-300 shadow-cyan-500/20"
                : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50"
            }`}
          >
            {t("START PROCESS")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Configuration Columns */}
        <div className="lg:col-span-2 space-y-6">
          {/* Source Media Card */}
          <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
            <div className="flex items-center gap-2 border-b th-border pb-2">
              <FileVideo className="w-4 h-4 text-cyan-400" />
              <span className="font-bold th-text uppercase tracking-widest text-xs">
                {t("SOURCE_MEDIA")}
              </span>
            </div>

            <div className="inline-flex rounded-md border th-border bg-black/40 p-1 mb-2">
              <button
                onClick={() => setMediaInputMode("local_file")}
                className={`h-8 rounded px-3 text-xs font-semibold uppercase tracking-wider transition-all ${
                  mediaInputMode === "local_file"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {t("Local File")}
              </button>
              <button
                onClick={() => setMediaInputMode("public_url")}
                className={`h-8 rounded px-3 text-xs font-semibold uppercase tracking-wider transition-all ${
                  mediaInputMode === "public_url"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {t("Public URL")}
              </button>
            </div>

            {mediaInputMode === "local_file" ? (
              <div className="space-y-4">
                <div
                  onClick={handleSelectFile}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed bg-black/20 transition-all p-8 flex flex-col items-center justify-center cursor-pointer rounded-sm ${
                    isDragOver ? "border-cyan-400 bg-cyan-500/5" : "th-border hover:bg-cyan-500/5"
                  }`}
                >
                  <div className="w-10 h-10 rounded-full bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 text-cyan-400 mb-2">
                    <FileVideo className="w-5 h-5" />
                  </div>
                  <span className="font-bold th-text text-xs uppercase tracking-widest">
                    {t("Local File Selection")}
                  </span>
                  <span className="text-[10px] th-text-muted mt-1">
                    {t("Drag and drop or click to choose from system files")}
                  </span>
                </div>
                <div className="space-y-1">
                  <span className="th-text-3 text-[10px] uppercase font-bold">
                    {t("Target File Path")}
                  </span>
                  <input
                    type="text"
                    value={localMediaPath}
                    onChange={(e) => setLocalMediaPath(e.target.value)}
                    placeholder="/volumes/data/input_video_01.mp4"
                    className="w-full px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <span className="th-text-3 text-[10px] uppercase font-bold">
                  {t("Network Stream Link")}
                </span>
                <input
                  type="text"
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  placeholder="https://example.com/stream-source.mp4"
                  className="w-full px-3 py-2 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50"
                />
              </div>
            )}
          </div>

          {/* Engine & Audio mix row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Engine Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  {t("ENGINE")}
                </span>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    {t("ASR & LLM Engine Provider")}
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
                    {t("Translation Model")}
                  </label>
                  {config.provider === "volc_doubao" ? (
                    <div className="space-y-2">
                      <CustomSelect
                        value={translationModel}
                        onChange={setTranslationModel}
                        options={DOUBAO_TRANSLATION_MODEL_OPTIONS}
                        className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                      />
                      <p className="text-[10px] th-text-muted leading-relaxed">
                        使用豆包语音 API Key 调用 <code className="text-cyan-400 font-mono">volc.speech.mt</code>。无需配置火山方舟 API Key 或接入点 ID。
                      </p>
                    </div>
                  ) : (
                    <CustomSelect
                      value={translationModel}
                      onChange={setTranslationModel}
                      options={BAILIAN_TRANSLATION_MODEL_OPTIONS}
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                    />
                  )}
                </div>

                {config.provider === "aliyun_bailian" && (
                  <div className="space-y-1">
                    <label className="th-text-3 text-[10px] uppercase font-bold">
                      {t("ASR Recognition Model")}
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
                )}

                {config.provider === "local_whisper" && (
                  <div className="space-y-1">
                    <label className="th-text-3 text-[10px] uppercase font-bold">
                      {t("Whisper Model Size")}
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
                        { value: "small", label: "Small (Speed)" },
                        { value: "medium", label: "Medium (Accuracy)" },
                      ]}
                      className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                    />
                  </div>
                )}

                {config.provider === "google_chirp3" && (
                  <div className="space-y-1">
                    <label className="th-text-3 text-[10px] uppercase font-bold">
                      {t("Google Cloud Project ID")}
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
                      className="w-full px-3 py-1.5 border th-border th-bg-input th-text focus:outline-none focus:border-cyan-500/50"
                    />
                  </div>
                )}

                <div className="space-y-1">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    {t("Target Language")}
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
              </div>
            </div>

            {/* Audio Mix Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm flex flex-col justify-between">
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b th-border pb-2">
                  <Volume2 className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold th-text uppercase tracking-widest text-xs">
                    {t("AUDIO_MIX")}
                  </span>
                </div>

                <div className="space-y-3 pt-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="th-text-2">{t("Original Audio Retention")}</span>
                    <span className="text-cyan-400 font-bold border border-cyan-500/20 px-1.5 py-0.5 rounded bg-cyan-500/5">
                      {replaceOriginalAudio ? "0%" : `${Math.round(originalAudioVolume * 100)}%`}
                    </span>
                  </div>

                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    disabled={replaceOriginalAudio}
                    value={originalAudioVolume}
                    onChange={(e) => setOriginalAudioVolume(parseFloat(e.target.value))}
                    className="w-full accent-cyan-400 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                  />

                  <div className="flex justify-between th-text-muted text-[10px] font-bold">
                    <span>MUTE</span>
                    <span>FULL</span>
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer pt-4 border-t th-border mt-4">
                <input
                  type="checkbox"
                  checked={replaceOriginalAudio}
                  onChange={(e) => setReplaceOriginalAudio(e.target.checked)}
                  className="w-4 h-4 border th-border rounded bg-transparent checked:bg-cyan-500 focus:outline-none"
                />
                <span className="th-text-2 font-medium">
                  {t("Mute Original Audio Entirely")}
                </span>
              </label>
            </div>
          </div>

          {/* Subtitle Card */}
          <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
            <div className="flex items-center gap-2 border-b th-border pb-2">
              <Captions className="w-4 h-4 text-cyan-400" />
              <span className="font-bold th-text uppercase tracking-widest text-xs">
                {t("SUBTITLES")}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex items-start gap-3 border th-border bg-black/20 p-3 cursor-pointer hover:border-cyan-500/40 transition-colors rounded-sm">
                <input
                  type="checkbox"
                  checked={showEnglishSubtitles}
                  onChange={(event) => setShowEnglishSubtitles(event.target.checked)}
                  className="w-4 h-4 mt-0.5 border th-border rounded bg-transparent checked:bg-cyan-500 focus:outline-none"
                />
                <span className="space-y-1">
                  <span className="block th-text font-bold text-xs">
                    {t("Source Subtitles")}
                  </span>
                  <span className="block text-[10px] th-text-muted leading-relaxed">
                    {t("Use original subtitles detected by ASR.")}
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-3 border th-border bg-black/20 p-3 cursor-pointer hover:border-purple-500/40 transition-colors rounded-sm">
                <input
                  type="checkbox"
                  checked={showTargetLanguageSubtitles}
                  onChange={(event) => setShowTargetLanguageSubtitles(event.target.checked)}
                  className="w-4 h-4 mt-0.5 border th-border rounded bg-transparent checked:bg-purple-500 focus:outline-none"
                />
                <span className="space-y-1">
                  <span className="block th-text font-bold text-xs">
                    {t("Target Subtitles: {lang}", { lang: targetLanguageLabel })}
                  </span>
                  <span className="block text-[10px] th-text-muted leading-relaxed">
                    {t("Use translated target language subtitles.")}
                  </span>
                </span>
              </label>
            </div>

            <p className="text-[10px] th-text-muted leading-relaxed">
              {showEnglishSubtitles && showTargetLanguageSubtitles
                ? t("Bilingual subtitles enabled. Source on top, target at the bottom.")
                : showEnglishSubtitles || showTargetLanguageSubtitles
                  ? t("Monolingual subtitles enabled. Subtitles will be burned into the final video.")
                  : t("Subtitles disabled. Final video will only mix audio tracks.")}
            </p>
          </div>
        </div>

        {/* Synthesis Options Sidebar Panel (Right Panel) */}
        <div className="space-y-6">
          <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm h-full flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  {t("SYNTHESIS")}
                </span>
              </div>

              {/* Option 1: Standard Voice Model */}
              <div
                onClick={() => setSynthesisMode("default")}
                className={`border p-4 rounded-sm cursor-pointer transition-all space-y-2 relative ${
                  synthesisMode === "default"
                    ? "border-cyan-400 bg-cyan-500/5"
                    : "th-border bg-black/20 hover:border-slate-600"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold th-text text-[13px] tracking-wide">
                    {config.provider === "volc_doubao" ? t("Default Voice Model") : t("Default Voice Model")}
                  </span>
                  <div
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                      synthesisMode === "default"
                        ? "border-cyan-400 after:content-[''] after:w-1.5 after:h-1.5 after:bg-cyan-400 after:rounded-full"
                        : "th-border"
                    }`}
                  />
                </div>
                <p className="text-[11px] th-text-muted leading-relaxed">
                  {t("Standard preset voice models (Seed-TTS / Sambert).")}
                </p>
                <ul className="text-[10px] th-text-2 font-semibold space-y-1 pt-1 font-mono uppercase tracking-wider">
                  {config.provider === "volc_doubao" ? (
                    <li className="text-cyan-400">• SEED-TTS 2.0 (DEFAULT)</li>
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
                className={`border p-4 rounded-sm cursor-pointer transition-all space-y-2 relative overflow-hidden ${
                  synthesisMode === "clone"
                    ? "border-purple-500 bg-purple-500/5"
                    : "th-border bg-black/20 hover:border-slate-600"
                }`}
              >
                {/* Premium Label */}
                <div className="absolute top-0 right-0 bg-purple-600 text-white font-extrabold text-[8px] uppercase tracking-widest px-2 py-0.5 rounded-bl-sm">
                  PREMIUM
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="font-bold th-text text-[13px] tracking-wide flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-purple-400" /> {t("Voice Cloning")}
                  </span>
                  <div
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                      synthesisMode === "clone"
                        ? "border-purple-500 after:content-[''] after:w-1.5 after:h-1.5 after:bg-purple-500 after:rounded-full"
                        : "th-border"
                    }`}
                  />
                </div>
                <p className="text-[11px] th-text-muted leading-relaxed">
                  {t("Clone original speaker's timbre, emotional tone, and ambient noise levels dynamically.")}
                </p>
              </div>
            </div>

            {/* Custom parameters */}
            {synthesisMode === "default" && (
              <div className="space-y-2 pt-4 border-t th-border mt-4">
                <label className="block th-text-3 text-[10px] uppercase font-bold">
                  {t("Select Preset Voice Timbre")}
                </label>
                <CustomSelect
                  value={ttsVoice}
                  onChange={setTtsVoice}
                  options={config.provider === "volc_doubao" ? DOUBAO_TTS_VOICE_OPTIONS : BAILIAN_TTS_VOICE_OPTIONS}
                  className="w-full rounded-lg border th-border th-bg-input px-3 py-1.5 th-text transition-all focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
