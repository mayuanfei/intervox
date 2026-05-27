import type {
  AsrConfig,
  AsrProviderId,
  BailianDeployment,
  BailianModel,
  GoogleRegion,
  SourceLanguageCode,
  TargetLanguageCode,
  WhisperModel,
} from "../types/asr";

export const DEFAULT_ASR_CONFIG: AsrConfig = {
  provider: "aliyun_bailian",
  source_language: "auto",
  target_language: "zh-Hans-CN",
  aliyun_bailian: {
    model: "qwen3-asr-flash-filetrans",
    deployment: "china_mainland",
    enable_word_timestamps: true,
    enable_speaker_diarization: true,
  },
  google_chirp3: {
    model: "chirp_3",
    region: "asia-southeast1",
    project_id: "",
  },
  volc_doubao: {
    resource_id: "volc.bigasr.auc_turbo",
  },
  local_whisper: {
    model: "small",
    model_path: "",
  },
};

export const ASR_PROVIDER_OPTIONS: Array<{
  value: AsrProviderId;
  label: string;
  summary: string;
}> = [
  {
    value: "aliyun_bailian",
    label: "阿里云百炼",
    summary: "默认云端识别，适合国内网络和长音视频转写。",
  },
  {
    value: "google_chirp3",
    label: "Google Chirp 3",
    summary: "海外高质量多语种识别，可选择 Google 服务区域。",
  },
  {
    value: "volc_doubao",
    label: "火山豆包",
    summary: "国内快速识别备选，适合极速录音文件识别。",
  },
  {
    value: "local_whisper",
    label: "本地 Whisper",
    summary: "离线兜底，不依赖云端 API，速度取决于设备。",
  },
];

export const SOURCE_LANGUAGE_OPTIONS: Array<{
  value: SourceLanguageCode;
  label: string;
}> = [
  { value: "auto", label: "自动识别" },
  { value: "en-US", label: "英语" },
  { value: "ja-JP", label: "日语" },
  { value: "ko-KR", label: "韩语" },
  { value: "cmn-Hans-CN", label: "中文普通话" },
];

export const TARGET_LANGUAGE_OPTIONS: Array<{
  value: TargetLanguageCode;
  label: string;
}> = [
  { value: "zh-Hans-CN", label: "中文（简体，普通话）" },
  { value: "en-US", label: "英语" },
  { value: "ja-JP", label: "日语" },
  { value: "ko-KR", label: "韩语" },
  { value: "es-ES", label: "西班牙语" },
  { value: "fr-FR", label: "法语" },
  { value: "de-DE", label: "德语" },
];

export const GOOGLE_REGION_OPTIONS: Array<{
  value: GoogleRegion;
  label: string;
}> = [
  { value: "asia-southeast1", label: "asia-southeast1" },
  { value: "asia-northeast1", label: "asia-northeast1" },
  { value: "us", label: "us" },
  { value: "eu", label: "eu" },
];

export const BAILIAN_MODEL_OPTIONS: Array<{
  value: BailianModel;
  label: string;
}> = [
  { value: "qwen3-asr-flash-filetrans", label: "千问3-ASR-Flash-Filetrans" },
  { value: "fun-asr", label: "Fun-ASR" },
];

export const BAILIAN_DEPLOYMENT_OPTIONS: Array<{
  value: BailianDeployment;
  label: string;
}> = [
  { value: "china_mainland", label: "中国内地（北京）" },
  { value: "international", label: "国际（新加坡）" },
];

export const WHISPER_MODEL_OPTIONS: Array<{
  value: WhisperModel;
  label: string;
}> = [
  { value: "small", label: "small" },
  { value: "medium", label: "medium" },
];
