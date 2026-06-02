export type AsrProviderId =
  | "aliyun_bailian"
  | "google_chirp3"
  | "volc_doubao"
  | "volc_ark"
  | "local_whisper";

export type TargetLanguageCode =
  | "zh-Hans-CN"
  | "en-US"
  | "ja-JP"
  | "ko-KR"
  | "es-ES"
  | "fr-FR"
  | "de-DE";
export type SourceLanguageCode = "auto" | "en-US" | "ja-JP" | "ko-KR" | "cmn-Hans-CN";
export type GoogleRegion = "asia-southeast1" | "asia-northeast1" | "us" | "eu";
export type BailianModel = "qwen3-asr-flash-filetrans" | "fun-asr";
export type BailianDeployment = "china_mainland" | "international";
export type WhisperModel = "small" | "medium";

export interface AsrConfig {
  provider: AsrProviderId;
  source_language: SourceLanguageCode;
  target_language: TargetLanguageCode;
  aliyun_bailian: {
    model: BailianModel;
    deployment: BailianDeployment;
    enable_word_timestamps: boolean;
    enable_speaker_diarization: boolean;
  };
  google_chirp3: {
    model: "chirp_3";
    region: GoogleRegion;
    project_id: string;
  };
  volc_doubao: {
    resource_id: string;
    app_id: string;
  };
  local_whisper: {
    model: WhisperModel;
    model_path: string;
    translation_endpoint?: string;
  };
}

export interface TranscriptSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  speaker_id?: string | null;
  text: string;
  confidence?: number | null;
}

export interface TranscriptDocument {
  source_language: SourceLanguageCode | string;
  target_language: TargetLanguageCode;
  provider: AsrProviderId;
  segments: TranscriptSegment[];
}

export interface CredentialValidationResult {
  ok: boolean;
  provider: AsrProviderId;
  message: string;
}

export interface AsrTranscriptionRequest {
  job_id?: string;
  audio_path: string;
  config: AsrConfig;
}

export interface TranslationSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  speaker_id?: string | null;
  source_text: string;
  translated_text: string;
}

export interface TranslationDocument {
  source_language: string;
  target_language: TargetLanguageCode;
  provider: "aliyun_qwen" | string;
  segments: TranslationSegment[];
}

export interface TtsSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  speaker_id?: string | null;
  text: string;
  audio_url: string;
  audio_path: string;
}

export interface TtsDocument {
  target_language: TargetLanguageCode;
  provider: "aliyun_cosyvoice" | string;
  model: string;
  voice: string;
  segments: TtsSegment[];
}

export interface ExportResult {
  voiceover_path: string;
  video_path: string;
}
