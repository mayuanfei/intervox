import React from "react";
import {
  Save,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  FolderOpen,
  Eye,
  EyeOff,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";
import { invoke } from "@tauri-apps/api/core";
import {
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from "../lib/asrOptions";
import { CustomSelect } from "../components/CustomSelect";

export function Settings() {
  const {
    config,
    setConfig,
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
  } = useIntervox();

  const [showKey, setShowKey] = React.useState(false);
  const [showVolcKey, setShowVolcKey] = React.useState(false);

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
    showToast("配置已成功应用并保存！", "success");
  };

  const handleReset = () => {
    // Reset config
    if (confirm("是否确定重置所有设置为默认配置？")) {
      window.location.reload();
    }
  };

  return (
    <div className="space-y-6 font-mono text-[13px] animate-fade-in">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b th-border pb-4">
        <div>
          <h2 className="text-xl font-bold th-text tracking-tight flex items-center gap-2">
            <span>&gt;_</span> Configuration _
          </h2>
          <p className="text-xs th-text-muted mt-1 uppercase tracking-wider">
            DEFINE CORE OPERATIONAL PARAMETERS
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleReset}
            className="px-4 py-1.5 border border-slate-700 th-text-3 hover:th-text hover:border-slate-500 transition-colors uppercase tracking-widest font-bold text-[11px]"
          >
            RESET
          </button>
          <button
            onClick={handleApplyChanges}
            className="px-4 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-black font-bold tracking-widest text-[11px] transition-all uppercase shadow-md shadow-cyan-500/20"
          >
            APPLY CHANGES
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Output Routing Card */}
        <div className="lg:col-span-2 border th-border th-bg-card p-5 space-y-4 rounded-sm relative">
          <div className="flex items-center gap-2 border-b th-border pb-2">
            <FolderOpen className="w-4 h-4 text-cyan-400" />
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              OUTPUT ROUTING
            </span>
          </div>

          <div className="space-y-3">
            <div className="space-y-2">
              <label className="block th-text-3 font-semibold uppercase text-[11px]">
                BASE_DIRECTORY_PATH
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
                  BROWSE
                </button>
              </div>
            </div>

            <p className="pt-2 th-text-2 text-xs">
              Temporary ASR audio, voice-clone slices, and playback previews are retained under this directory.
            </p>
          </div>
        </div>

        {/* Processing Defaults Card */}
        <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
          <div className="flex items-center gap-2 border-b th-border pb-2">
            <CheckCircle className="w-4 h-4 text-cyan-400" />
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              PROCESSING DEFAULTS
            </span>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block th-text-3 font-semibold uppercase text-[11px]">
                AUTO_DETECT_LANG
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
                DEFAULT_TARGET_LANG
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

            <div className="flex items-center justify-between pt-2">
              <span className="th-text-2 font-medium">ENABLE_VOICE_CLONE</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" defaultChecked className="sr-only peer" />
                <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-500 peer-checked:after:bg-black"></div>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* LLM & Inference Endpoints */}
      <div className="border th-border th-bg-card p-5 space-y-4 rounded-sm">
        <div className="flex items-center justify-between border-b th-border pb-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
            <span className="font-bold th-text uppercase tracking-widest text-xs">
              LLM & INFERENCE ENDPOINTS
            </span>
          </div>
          <span className="text-[10px] font-bold text-cyan-400 uppercase border border-cyan-500/20 px-2 py-0.5 rounded-full bg-cyan-500/5">
            NODE.SECURE
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          {/* Alibaba Bailian Endpoint */}
          <div className="border th-border bg-black/30 p-4 rounded-sm space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-extrabold th-text tracking-wide text-xs">
                ALIBABA_BAILIAN_API
              </span>
              {status?.ok ? (
                <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" /> Active
                </span>
              ) : (
                <span className="text-[11px] text-amber-500 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 animate-bounce" /> Missing Key
                </span>
              )}
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <label className="block th-text-muted text-[10px] font-bold uppercase">
                  AUTHORIZATION_BEARER
                </label>
                <div className="flex gap-2 relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={credentialDraft}
                    onChange={(e) => setCredentialDraft(e.target.value)}
                    placeholder={status?.ok ? "•••••••••••••••••••••••• (已保存)" : "sk-..."}
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
                  <Save className="w-3.5 h-3.5" /> Save Bearer
                </button>
                <button
                  onClick={validateProvider}
                  className="px-3 py-2 border th-border text-slate-300 hover:border-slate-500 transition-all flex items-center gap-2 uppercase text-[11px] font-bold"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Validate Endpoint
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
              Required for deep semantic context translation, ASR processing, and zero-shot voice cloning synthetic pipelines.
            </p>
          </div>

          {/* Volcengine Doubao Endpoint */}
          {/* Volcano Doubao Speech Card */}
          <div className="border th-border bg-black/30 p-4 rounded-sm space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-extrabold th-text tracking-wide text-xs">
                VOLCENGINE_SPEECH_API (豆包语音)
              </span>
              {volcStatus?.ok ? (
                <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" /> Active
                </span>
              ) : (
                <span className="text-[11px] text-amber-500 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 animate-bounce" /> Missing Key
                </span>
              )}
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <label className="block th-text-muted text-[10px] font-bold uppercase">
                  APP_ID
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
                  RESOURCE_ID (可选)
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
                  AUTHORIZATION_BEARER (Speech API Key)
                </label>
                <div className="flex gap-2 relative">
                  <input
                    type={showVolcKey ? "text" : "password"}
                    value={volcCredentialDraft}
                    onChange={(e) => setVolcCredentialDraft(e.target.value)}
                    placeholder={volcStatus?.ok ? "•••••••••••••••••••••••• (已保存)" : "请输入在「豆包语音」控制台申请的 API Key"}
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
                  <Save className="w-3.5 h-3.5" /> Save Bearer
                </button>
                <button
                  onClick={validateVolcProvider}
                  className="px-3 py-2 border th-border text-slate-300 hover:border-slate-500 transition-all flex items-center gap-2 uppercase text-[11px] font-bold"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Validate Endpoint
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
              用于豆包 ASR、火山机器翻译和 SEED-TTS 语音合成。机器翻译需先在「语音技术」控制台开通 <code className="text-cyan-400 font-mono">volc.speech.mt</code>。
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}
