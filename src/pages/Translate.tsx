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
  const [currentStep, setCurrentStep] = React.useState<number>(1);

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
        <div className="flex items-center gap-3">
          <Languages className="w-6 h-6 text-cyan-400" />
          <h2 className="text-xl font-bold th-text tracking-tight">
            {t("Translate")}
          </h2>
        </div>
      </div>

      <div className="flex flex-col gap-6 w-full">
        {/* Step Navigation Indicator & Actions */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between border th-border th-bg-card p-4 rounded-sm select-none gap-4">
          {/* Left: Step Indicators */}
          <div className="flex items-center gap-2.5 flex-1 w-full md:w-auto overflow-x-auto scrollbar-none">
            {[
              { step: 1, label: t("Media & Engine") },
              { step: 2, label: t("Mix & Subtitles") },
              { step: 3, label: t("Synthesis & Run") },
            ].map((item, idx) => {
              const isActive = currentStep === item.step;
              const isCompleted = currentStep > item.step;
              return (
                <React.Fragment key={item.step}>
                  <button
                    onClick={() => setCurrentStep(item.step)}
                    className={`flex items-center gap-2.5 px-3 py-1.5 rounded transition-all font-bold text-xs uppercase tracking-widest border cursor-pointer flex-shrink-0 ${
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

                  {idx < 2 && (
                    <div className="flex-1 h-[2px] min-w-[20px] mx-2 bg-slate-800/80 relative overflow-hidden hidden md:block">
                      {currentStep > item.step && (
                        <div className="absolute inset-0 bg-gradient-to-r from-cyan-500 to-cyan-400" />
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Right: Step Navigation Actions */}
          <div className="flex items-center gap-3 w-full md:w-auto justify-end border-t md:border-t-0 th-border pt-3 md:pt-0">
            {currentStep > 1 && (
              <button
                onClick={() => setCurrentStep(currentStep - 1)}
                className="px-4 py-2 border th-border th-text-3 hover:th-text hover:bg-cyan-950/10 font-bold rounded-sm transition-all text-xs uppercase tracking-widest cursor-pointer"
              >
                上一步
              </button>
            )}
            {currentStep < 3 && (
              <button
                onClick={() => setCurrentStep(currentStep + 1)}
                className="px-4 py-2 bg-cyan-400 hover:bg-cyan-300 text-black font-extrabold rounded-sm transition-all shadow-md text-xs uppercase tracking-widest cursor-pointer"
              >
                下一步
              </button>
            )}
            {currentStep === 3 && (
              <button
                onClick={startFullPipeline}
                disabled={!isInputReady}
                className={`px-5 py-2 text-xs font-extrabold tracking-widest transition-all uppercase rounded-sm flex items-center justify-center gap-2 shadow-md ${
                  isInputReady
                    ? "bg-cyan-400 text-black hover:bg-cyan-300 shadow-cyan-500/20 cursor-pointer"
                    : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50"
                }`}
              >
                <Zap className={`w-3.5 h-3.5 ${isInputReady ? "animate-pulse" : ""}`} />
                {t("START PROCESS")}
              </button>
            )}
          </div>
        </div>

        {/* Step Content */}
        {currentStep === 1 && (
          <div className="space-y-6 animate-fade-in">
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
                  className={`h-8 rounded px-3 text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer ${
                    mediaInputMode === "local_file"
                      ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {t("Local File")}
                </button>
                <button
                  onClick={() => setMediaInputMode("public_url")}
                  className={`h-8 rounded px-3 text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer ${
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

            {/* Engine Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  {t("ENGINE")}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

                <div className="space-y-1">
                  <label className="th-text-3 text-[10px] uppercase font-bold">
                    {t("Translation Model")}
                  </label>
                  {config.provider === "volc_doubao" ? (
                    <div className="space-y-1.5">
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
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setCurrentStep(2)}
                className="px-6 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-black font-extrabold rounded-sm transition-all shadow-md text-xs uppercase tracking-widest cursor-pointer"
              >
                下一步
              </button>
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-6 animate-fade-in">
            {/* Audio Mix Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Volume2 className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  {t("AUDIO_MIX")}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center pt-2">
                <div className="md:col-span-2 space-y-3">
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

                <div className="flex justify-start md:justify-end">
                  <label className="flex items-center gap-3 cursor-pointer p-4 border th-border bg-black/20 hover:border-cyan-500/40 rounded-sm w-full md:w-auto transition-colors">
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
            {/* Synthesis Options Card */}
            <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
              <div className="flex items-center gap-2 border-b th-border pb-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                <span className="font-bold th-text uppercase tracking-widest text-xs">
                  {t("SYNTHESIS")}
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
                        {t("Default Voice Model")}
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
                      {t("Standard preset voice models (Seed-TTS / Sambert).")}
                    </p>
                  </div>
                  <ul className="text-[10px] th-text-2 font-semibold space-y-1 pt-2 font-mono uppercase tracking-wider border-t th-border mt-2">
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
                    <p className="text-[11px] th-text-muted leading-relaxed mt-1">
                      {t("Clone original speaker's timbre, emotional tone, and ambient noise levels dynamically.")}
                    </p>
                  </div>
                </div>
              </div>

              {synthesisMode === "default" && (
                <div className="space-y-1.5 pt-2 max-w-md">
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

            {/* Bottom Actions & Action Button */}
            <div className="flex flex-col gap-4 pt-2">
              <div className="flex justify-start">
                <button
                  onClick={() => setCurrentStep(2)}
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
                  {t("START PROCESS")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
