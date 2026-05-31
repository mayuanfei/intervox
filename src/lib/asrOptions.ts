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
    app_id: "",
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
    label: "阿里云百炼 (Alibaba Bailian)",
    summary: "默认云端识别，适合高质量、长视频转写与情绪分析。",
  },
  {
    value: "google_chirp3",
    label: "Google Chirp 3",
    summary: "海外高质量多语种识别，适合小语种和出海本地化。",
  },
  {
    value: "volc_doubao",
    label: "火山引擎豆包 (Volcengine)",
    summary: "极速大模型识别，适合短平快媒体资源的高频处理。",
  },
  {
    value: "local_whisper",
    label: "本地 Whisper (Local)",
    summary: "完全离线兜底，不依赖云端，保护绝对的隐私安全。",
  },
];

export const SOURCE_LANGUAGE_OPTIONS: Array<{
  value: SourceLanguageCode;
  label: string;
}> = [
  { value: "auto", label: "自动检测 (Auto-Detect)" },
  { value: "en-US", label: "英语 (English)" },
  { value: "ja-JP", label: "日语 (Japanese)" },
  { value: "ko-KR", label: "韩语 (Korean)" },
  { value: "cmn-Hans-CN", label: "中文普通话 (Chinese Mandarin)" },
];

export const TARGET_LANGUAGE_OPTIONS: Array<{
  value: TargetLanguageCode;
  label: string;
}> = [
  { value: "zh-Hans-CN", label: "简体中文 (Simplified Chinese)" },
  { value: "en-US", label: "英语 (English)" },
  { value: "ja-JP", label: "日语 (Japanese)" },
  { value: "ko-KR", label: "韩语 (Korean)" },
  { value: "es-ES", label: "西班牙语 (Spanish)" },
  { value: "fr-FR", label: "法语 (French)" },
  { value: "de-DE", label: "德语 (German)" },
];

export const GOOGLE_REGION_OPTIONS: Array<{
  value: GoogleRegion;
  label: string;
}> = [
  { value: "asia-southeast1", label: "亚太东南 (新加坡)" },
  { value: "asia-northeast1", label: "亚太东北 (东京)" },
  { value: "us", label: "美国 (United States)" },
  { value: "eu", label: "欧洲 (Europe)" },
];

export const BAILIAN_MODEL_OPTIONS: Array<{
  value: BailianModel | string;
  label: string;
}> = [
  { value: "qwen3-asr-flash-filetrans", label: "千问3-ASR-Flash (极速)" },
  { value: "sensevoice-v1", label: "SenseVoice-v1 (富文本高感官)" },
  { value: "paraformer-v1", label: "Paraformer-v1 (标准学术)" },
];

export const BAILIAN_DEPLOYMENT_OPTIONS: Array<{
  value: BailianDeployment;
  label: string;
}> = [
  { value: "china_mainland", label: "中国内地 (北京)" },
  { value: "international", label: "国际节点 (新加坡)" },
];

export const WHISPER_MODEL_OPTIONS: Array<{
  value: WhisperModel;
  label: string;
}> = [
  { value: "small", label: "Small (轻量快)" },
  { value: "medium", label: "Medium (准确)" },
];

// Added options for Translation & TTS selection in the UI
export const BAILIAN_TRANSLATION_MODEL_OPTIONS = [
  { value: "qwen-plus", label: "Qwen-Plus (性价比推荐)" },
  { value: "qwen-max", label: "Qwen-Max (高质量复杂语境)" },
  { value: "qwen-turbo", label: "Qwen-Turbo (极速低成本)" },
];

export const BAILIAN_TTS_MODEL_OPTIONS = [
  { value: "cosyvoice-v3-flash", label: "CosyVoice-v3-Flash (拟真度极高)" },
  { value: "cosyvoice-v3-clone", label: "CosyVoice 零样本声音复刻 ( timbres clone )" },
  { value: "sambert-high-fidelity", label: "Sambert-High-Fidelity (传统高品质)" },
];

export const BAILIAN_TTS_VOICE_OPTIONS = [
  { value: "longxiaochun_v3", label: "龙小淳 (活力童声)" },
  { value: "longwanwan_v3", label: "龙婉婉 (温暖女声)" },
  { value: "longying_v3", label: "龙颖 (专业女声)" },
  { value: "longxiaoshu_v3", label: "龙小书 (亲切男声)" },
  { value: "longxiaobiao_v3", label: "龙小表 (客服男声)" },
];

// Volcengine Doubao Translation Model Options
export const DOUBAO_TRANSLATION_MODEL_OPTIONS = [
  { value: "volc-speech-mt", label: "火山机器翻译 (Volc Speech MT - 推荐)" },
];

// Volcengine Doubao TTS Model Options
export const DOUBAO_TTS_MODEL_OPTIONS = [
  { value: "seed-tts-2.0", label: "Seed-TTS 2.0 (超自然语音合成)" },
  { value: "seed-icl-2.0", label: "Seed-ICL 2.0 (声音复刻克隆)" },
];

// Volcengine Doubao TTS Voice Presets
export const DOUBAO_TTS_VOICE_OPTIONS = [
  { value: "zh_female_vv_uranus_bigtts", label: "Vivi 活泼灵动女声 (Uranus - 2.0)" },
  { value: "zh_male_m191_uranus_bigtts", label: "云舟 清爽沉稳男声 (Uranus - 2.0)" },
  { value: "zh_female_xiaohe_uranus_bigtts", label: "小何 亲切自然女声 (Uranus - 2.0)" },
  { value: "en_male_tim_uranus_bigtts", label: "Tim 英文男声 (Uranus - 2.0)" },
];
