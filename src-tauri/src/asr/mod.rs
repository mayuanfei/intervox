use crate::credentials::{CredentialError, CredentialStore};
use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::thread;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AsrProviderId {
    AliyunBailian,
    GoogleChirp3,
    VolcDoubao,
    LocalWhisper,
}

impl AsrProviderId {
    pub fn as_keyring_account(self) -> &'static str {
        match self {
            AsrProviderId::AliyunBailian => "aliyun_bailian",
            AsrProviderId::GoogleChirp3 => "google_chirp3",
            AsrProviderId::VolcDoubao => "volc_doubao",
            AsrProviderId::LocalWhisper => "local_whisper",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub enum SourceLanguageCode {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "ja-JP")]
    JaJp,
    #[serde(rename = "ko-KR")]
    KoKr,
    #[serde(rename = "cmn-Hans-CN")]
    CmnHansCn,
}

impl SourceLanguageCode {
    pub fn as_bailian_language(&self) -> Option<&'static str> {
        match self {
            SourceLanguageCode::Auto => None,
            SourceLanguageCode::EnUs => Some("en"),
            SourceLanguageCode::JaJp => Some("ja"),
            SourceLanguageCode::KoKr => Some("ko"),
            SourceLanguageCode::CmnHansCn => Some("zh"),
        }
    }

    pub fn from_bailian_language(language: &str) -> Option<Self> {
        match language {
            "en" => Some(SourceLanguageCode::EnUs),
            "ja" => Some(SourceLanguageCode::JaJp),
            "ko" => Some(SourceLanguageCode::KoKr),
            "zh" | "yue" => Some(SourceLanguageCode::CmnHansCn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub enum TargetLanguageCode {
    #[serde(rename = "zh-Hans-CN")]
    ZhHansCn,
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "ja-JP")]
    JaJp,
    #[serde(rename = "ko-KR")]
    KoKr,
    #[serde(rename = "es-ES")]
    EsEs,
    #[serde(rename = "fr-FR")]
    FrFr,
    #[serde(rename = "de-DE")]
    DeDe,
}

impl TargetLanguageCode {
    pub fn display_name(&self) -> &'static str {
        match self {
            TargetLanguageCode::ZhHansCn => "简体中文普通话",
            TargetLanguageCode::EnUs => "英语",
            TargetLanguageCode::JaJp => "日语",
            TargetLanguageCode::KoKr => "韩语",
            TargetLanguageCode::EsEs => "西班牙语",
            TargetLanguageCode::FrFr => "法语",
            TargetLanguageCode::DeDe => "德语",
        }
    }

    pub fn cosyvoice_language_hint(&self) -> &'static str {
        match self {
            TargetLanguageCode::ZhHansCn => "zh",
            TargetLanguageCode::EnUs => "en",
            TargetLanguageCode::JaJp => "ja",
            TargetLanguageCode::KoKr => "ko",
            TargetLanguageCode::EsEs => "es",
            TargetLanguageCode::FrFr => "fr",
            TargetLanguageCode::DeDe => "de",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GoogleRegion {
    AsiaSoutheast1,
    AsiaNortheast1,
    Us,
    Eu,
}

impl GoogleRegion {
    pub fn endpoint(&self) -> &'static str {
        match self {
            GoogleRegion::AsiaSoutheast1 => "asia-southeast1-speech.googleapis.com",
            GoogleRegion::AsiaNortheast1 => "asia-northeast1-speech.googleapis.com",
            GoogleRegion::Us => "us-speech.googleapis.com",
            GoogleRegion::Eu => "eu-speech.googleapis.com",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BailianModel {
    Qwen3AsrFlashFiletrans,
    FunAsr,
}

impl BailianModel {
    pub fn as_model_name(&self) -> &'static str {
        match self {
            BailianModel::Qwen3AsrFlashFiletrans => "qwen3-asr-flash-filetrans",
            BailianModel::FunAsr => "fun-asr",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BailianDeployment {
    ChinaMainland,
    International,
}

impl BailianDeployment {
    pub fn api_base_url(&self) -> &'static str {
        match self {
            BailianDeployment::ChinaMainland => "https://dashscope.aliyuncs.com/api/v1",
            BailianDeployment::International => "https://dashscope-intl.aliyuncs.com/api/v1",
        }
    }

    pub fn compatible_chat_url(&self) -> &'static str {
        match self {
            BailianDeployment::ChinaMainland => {
                "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
            }
            BailianDeployment::International => {
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
            }
        }
    }

    pub fn cosyvoice_tts_url(&self) -> Option<&'static str> {
        match self {
            BailianDeployment::ChinaMainland => {
                Some("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer")
            }
            BailianDeployment::International => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WhisperModel {
    Small,
    Medium,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AsrConfig {
    pub provider: AsrProviderId,
    pub source_language: SourceLanguageCode,
    pub target_language: TargetLanguageCode,
    pub aliyun_bailian: AliyunBailianConfig,
    pub google_chirp3: GoogleChirp3Config,
    pub volc_doubao: VolcDoubaoConfig,
    pub local_whisper: LocalWhisperConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AliyunBailianConfig {
    pub model: BailianModel,
    pub deployment: BailianDeployment,
    pub enable_word_timestamps: bool,
    pub enable_speaker_diarization: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct GoogleChirp3Config {
    pub model: String,
    pub region: GoogleRegion,
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct VolcDoubaoConfig {
    pub resource_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct LocalWhisperConfig {
    pub model: WhisperModel,
    pub model_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TranscriptDocument {
    pub source_language: SourceLanguageCode,
    pub target_language: TargetLanguageCode,
    pub provider: AsrProviderId,
    pub segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: Option<String>,
    pub text: String,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CredentialValidationResult {
    pub ok: bool,
    pub provider: AsrProviderId,
    pub message: String,
}

impl CredentialValidationResult {
    pub fn ok(provider: AsrProviderId, message: impl Into<String>) -> Self {
        Self {
            ok: true,
            provider,
            message: message.into(),
        }
    }

    pub fn failed(provider: AsrProviderId, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            provider,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AsrTranscriptionRequest {
    pub job_id: Option<String>,
    pub audio_path: String,
    pub config: AsrConfig,
}

#[derive(Debug, Error)]
pub enum AsrError {
    #[error("音视频 URL 不能为空。")]
    EmptyAudioPath,
    #[error("阿里云百炼需要公网可访问的 http/https 音视频 URL。")]
    InvalidPublicMediaUrl,
    #[error("YouTube 页面 URL 不是音视频文件直链。请使用公网可访问的 mp3/wav/mp4 文件 URL，或后续使用本地导入/授权下载流程。")]
    UnsupportedYoutubeUrl,
    #[error("请先保存当前 ASR 服务商凭据。")]
    MissingCredential,
    #[error("Google Project ID 不能为空。")]
    MissingGoogleProjectId,
    #[error("本地 Whisper 模型文件路径不能为空。")]
    MissingWhisperModelPath,
    #[error("当前仅已接入千问3-ASR-Flash-Filetrans 的真实调用，请先切回该模型。")]
    UnsupportedBailianModel,
    #[error("阿里云百炼请求失败：{0}")]
    Http(#[from] reqwest::Error),
    #[error("阿里云百炼返回异常：{0}")]
    Api(String),
    #[error("阿里云百炼任务失败：{0}")]
    TaskFailed(String),
    #[error("阿里云百炼任务超时，请稍后重试或查看控制台任务状态。")]
    TaskTimeout,
    #[error("凭据错误：{0}")]
    Credential(#[from] CredentialError),
}

pub trait AsrProvider {
    fn id(&self) -> AsrProviderId;
    fn transcribe(&self, request: &AsrTranscriptionRequest)
        -> Result<TranscriptDocument, AsrError>;
}

pub fn default_asr_config() -> AsrConfig {
    AsrConfig {
        provider: AsrProviderId::AliyunBailian,
        source_language: SourceLanguageCode::Auto,
        target_language: TargetLanguageCode::ZhHansCn,
        aliyun_bailian: AliyunBailianConfig {
            model: BailianModel::Qwen3AsrFlashFiletrans,
            deployment: BailianDeployment::ChinaMainland,
            enable_word_timestamps: true,
            enable_speaker_diarization: true,
        },
        google_chirp3: GoogleChirp3Config {
            model: "chirp_3".to_string(),
            region: GoogleRegion::AsiaSoutheast1,
            project_id: String::new(),
        },
        volc_doubao: VolcDoubaoConfig {
            resource_id: "volc.bigasr.auc_turbo".to_string(),
        },
        local_whisper: LocalWhisperConfig {
            model: WhisperModel::Small,
            model_path: String::new(),
        },
    }
}

pub fn validate_credentials(
    provider: AsrProviderId,
    config: &AsrConfig,
    credential_store: &CredentialStore,
) -> Result<CredentialValidationResult, AsrError> {
    match provider {
        AsrProviderId::GoogleChirp3 if config.google_chirp3.project_id.trim().is_empty() => Ok(
            CredentialValidationResult::failed(provider, "Google Project ID 不能为空。"),
        ),
        AsrProviderId::LocalWhisper if config.local_whisper.model_path.trim().is_empty() => Ok(
            CredentialValidationResult::failed(provider, "请选择本地 Whisper 模型文件。"),
        ),
        AsrProviderId::LocalWhisper => Ok(CredentialValidationResult::ok(
            provider,
            "本地 Whisper 配置有效。",
        )),
        AsrProviderId::GoogleChirp3 => {
            if credential_store.exists(provider)? {
                Ok(CredentialValidationResult::ok(
                    provider,
                    format!(
                        "凭据已存在，Google endpoint：{}。",
                        config.google_chirp3.region.endpoint()
                    ),
                ))
            } else {
                Ok(CredentialValidationResult::failed(
                    provider,
                    "请先保存 Google 服务账号 JSON。",
                ))
            }
        }
        cloud_provider => {
            if credential_store.exists(cloud_provider)? {
                Ok(CredentialValidationResult::ok(
                    cloud_provider,
                    "凭据已存在，可以开始识别。",
                ))
            } else {
                Ok(CredentialValidationResult::failed(
                    cloud_provider,
                    "请先保存当前服务商凭据。",
                ))
            }
        }
    }
}

pub fn transcribe(request: AsrTranscriptionRequest) -> Result<TranscriptDocument, AsrError> {
    if request.audio_path.trim().is_empty() {
        return Err(AsrError::EmptyAudioPath);
    }

    let provider = provider_for(request.config.provider);
    provider.transcribe(&request)
}

fn provider_for(provider: AsrProviderId) -> Box<dyn AsrProvider + Send + Sync> {
    match provider {
        AsrProviderId::AliyunBailian => Box::new(AliyunBailianProvider),
        AsrProviderId::GoogleChirp3 => Box::new(GoogleChirp3Provider),
        AsrProviderId::VolcDoubao => Box::new(VolcDoubaoProvider),
        AsrProviderId::LocalWhisper => Box::new(LocalWhisperProvider),
    }
}

struct AliyunBailianProvider;
struct GoogleChirp3Provider;
struct VolcDoubaoProvider;
struct LocalWhisperProvider;

impl AsrProvider for AliyunBailianProvider {
    fn id(&self) -> AsrProviderId {
        AsrProviderId::AliyunBailian
    }

    fn transcribe(
        &self,
        request: &AsrTranscriptionRequest,
    ) -> Result<TranscriptDocument, AsrError> {
        if request.config.aliyun_bailian.model != BailianModel::Qwen3AsrFlashFiletrans {
            return Err(AsrError::UnsupportedBailianModel);
        }

        let file_url = validate_public_media_url(&request.audio_path)?;
        let api_key = CredentialStore::default()
            .get(self.id())?
            .ok_or(AsrError::MissingCredential)?;
        let client = Client::builder().timeout(Duration::from_secs(30)).build()?;
        let task_id = submit_bailian_qwen_task(&client, &api_key, request, file_url.as_str())?;
        let transcription_url = poll_bailian_task(&client, &api_key, request, &task_id)?;
        let result_json = client
            .get(transcription_url)
            .send()?
            .error_for_status()?
            .json::<Value>()?;

        Ok(parse_bailian_transcription_result(
            request,
            self.id(),
            &result_json,
        ))
    }
}

fn validate_public_media_url(raw_url: &str) -> Result<Url, AsrError> {
    let url = Url::parse(raw_url.trim()).map_err(|_| AsrError::InvalidPublicMediaUrl)?;
    if matches!(
        url.host_str(),
        Some("youtube.com")
            | Some("www.youtube.com")
            | Some("m.youtube.com")
            | Some("youtu.be")
            | Some("www.youtu.be")
    ) {
        return Err(AsrError::UnsupportedYoutubeUrl);
    }

    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err(AsrError::InvalidPublicMediaUrl),
    }
}

fn submit_bailian_qwen_task(
    client: &Client,
    api_key: &str,
    request: &AsrTranscriptionRequest,
    file_url: &str,
) -> Result<String, AsrError> {
    let endpoint = format!(
        "{}/services/audio/asr/transcription",
        request.config.aliyun_bailian.deployment.api_base_url()
    );
    let mut parameters = json!({
        "channel_id": [0],
        "enable_itn": false,
        "enable_words": request.config.aliyun_bailian.enable_word_timestamps
    });

    if let Some(language) = request.config.source_language.as_bailian_language() {
        parameters["language"] = Value::String(language.to_string());
    }

    let payload = json!({
        "model": request.config.aliyun_bailian.model.as_model_name(),
        "input": {
            "file_url": file_url
        },
        "parameters": parameters
    });

    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .header("X-DashScope-Async", "enable")
        .json(&payload)
        .send()?
        .error_for_status()?
        .json::<Value>()?;

    extract_string(&response, &["output", "task_id"])
        .map(ToString::to_string)
        .ok_or_else(|| AsrError::Api(format!("提交任务未返回 task_id：{response}")))
}

fn poll_bailian_task(
    client: &Client,
    api_key: &str,
    request: &AsrTranscriptionRequest,
    task_id: &str,
) -> Result<String, AsrError> {
    let endpoint = format!(
        "{}/tasks/{}",
        request.config.aliyun_bailian.deployment.api_base_url(),
        task_id
    );

    for _ in 0..90 {
        let response = client
            .get(&endpoint)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .header("X-DashScope-Async", "enable")
            .send()?
            .error_for_status()?
            .json::<Value>()?;

        match extract_string(&response, &["output", "task_status"]) {
            Some("SUCCEEDED") => {
                return extract_bailian_transcription_url(&response).ok_or_else(|| {
                    AsrError::Api(format!("任务成功但未返回 transcription_url：{response}"))
                });
            }
            Some("FAILED") => {
                let code = extract_string(&response, &["output", "code"]).unwrap_or("UNKNOWN");
                let message = extract_string(&response, &["output", "message"])
                    .unwrap_or("任务失败但未返回错误信息");
                return Err(AsrError::TaskFailed(format!("{code}: {message}")));
            }
            Some("PENDING") | Some("RUNNING") => thread::sleep(Duration::from_secs(2)),
            Some(other) => {
                return Err(AsrError::Api(format!(
                    "未知任务状态 {other}，原始响应：{response}"
                )));
            }
            None => {
                return Err(AsrError::Api(format!(
                    "查询任务未返回 task_status：{response}"
                )));
            }
        }
    }

    Err(AsrError::TaskTimeout)
}

fn extract_bailian_transcription_url(response: &Value) -> Option<String> {
    extract_string(response, &["output", "result", "transcription_url"])
        .map(ToString::to_string)
        .or_else(|| {
            response
                .pointer("/output/results/0/transcription_url")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn parse_bailian_transcription_result(
    request: &AsrTranscriptionRequest,
    provider: AsrProviderId,
    result: &Value,
) -> TranscriptDocument {
    let mut segments = Vec::new();
    let mut detected_language = None;

    if let Some(transcripts) = result.get("transcripts").and_then(Value::as_array) {
        for transcript in transcripts {
            let channel_id = transcript
                .get("channel_id")
                .and_then(Value::as_i64)
                .unwrap_or(0);

            if let Some(sentences) = transcript.get("sentences").and_then(Value::as_array) {
                for sentence in sentences {
                    if detected_language.is_none() {
                        detected_language = sentence
                            .get("language")
                            .and_then(Value::as_str)
                            .and_then(SourceLanguageCode::from_bailian_language);
                    }

                    let text = sentence
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim();
                    if text.is_empty() {
                        continue;
                    }

                    let sentence_id = sentence
                        .get("sentence_id")
                        .and_then(Value::as_i64)
                        .unwrap_or(segments.len() as i64);
                    let speaker_id = extract_speaker_id(sentence)
                        .or_else(|| Some(format!("channel_{channel_id}")));

                    segments.push(TranscriptSegment {
                        id: format!("seg_{channel_id}_{sentence_id}"),
                        start_ms: sentence
                            .get("begin_time")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        end_ms: sentence
                            .get("end_time")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        speaker_id,
                        text: text.to_string(),
                        confidence: sentence
                            .get("confidence")
                            .and_then(Value::as_f64)
                            .map(|confidence| confidence as f32),
                    });
                }
            }
        }
    }

    TranscriptDocument {
        source_language: detected_language
            .unwrap_or_else(|| request.config.source_language.clone()),
        target_language: request.config.target_language.clone(),
        provider,
        segments,
    }
}

fn extract_speaker_id(sentence: &Value) -> Option<String> {
    sentence
        .get("speaker_id")
        .or_else(|| sentence.get("speaker"))
        .or_else(|| sentence.get("speakerId"))
        .and_then(|value| match value {
            Value::String(speaker) if !speaker.trim().is_empty() => Some(speaker.to_string()),
            Value::Number(number) => Some(format!("speaker_{number}")),
            _ => None,
        })
}

fn extract_string<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

impl AsrProvider for GoogleChirp3Provider {
    fn id(&self) -> AsrProviderId {
        AsrProviderId::GoogleChirp3
    }

    fn transcribe(
        &self,
        request: &AsrTranscriptionRequest,
    ) -> Result<TranscriptDocument, AsrError> {
        if request.config.google_chirp3.project_id.trim().is_empty() {
            return Err(AsrError::MissingGoogleProjectId);
        }

        Ok(demo_transcript(
            self.id(),
            request,
            "Google Chirp 3 transcript placeholder",
        ))
    }
}

impl AsrProvider for VolcDoubaoProvider {
    fn id(&self) -> AsrProviderId {
        AsrProviderId::VolcDoubao
    }

    fn transcribe(
        &self,
        request: &AsrTranscriptionRequest,
    ) -> Result<TranscriptDocument, AsrError> {
        Ok(demo_transcript(
            self.id(),
            request,
            "Volc Doubao transcript placeholder",
        ))
    }
}

impl AsrProvider for LocalWhisperProvider {
    fn id(&self) -> AsrProviderId {
        AsrProviderId::LocalWhisper
    }

    fn transcribe(
        &self,
        request: &AsrTranscriptionRequest,
    ) -> Result<TranscriptDocument, AsrError> {
        if request.config.local_whisper.model_path.trim().is_empty() {
            return Err(AsrError::MissingWhisperModelPath);
        }

        Ok(demo_transcript(
            self.id(),
            request,
            "Local Whisper transcript placeholder",
        ))
    }
}

fn demo_transcript(
    provider: AsrProviderId,
    request: &AsrTranscriptionRequest,
    text: &str,
) -> TranscriptDocument {
    TranscriptDocument {
        source_language: request.config.source_language.clone(),
        target_language: request.config.target_language.clone(),
        provider,
        segments: vec![TranscriptSegment {
            id: format!("seg_{}", Uuid::new_v4()),
            start_ms: 0,
            end_ms: 3200,
            speaker_id: Some("speaker_1".to_string()),
            text: text.to_string(),
            confidence: Some(0.93),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_provider_is_aliyun_bailian_and_target_language_is_chinese() {
        let config = default_asr_config();

        assert_eq!(config.provider, AsrProviderId::AliyunBailian);
        assert_eq!(config.target_language, TargetLanguageCode::ZhHansCn);
        assert_eq!(
            config.aliyun_bailian.model,
            BailianModel::Qwen3AsrFlashFiletrans
        );
    }

    #[test]
    fn google_region_builds_expected_endpoint() {
        let mut config = default_asr_config();
        config.provider = AsrProviderId::GoogleChirp3;
        config.google_chirp3.region = GoogleRegion::AsiaNortheast1;

        assert_eq!(
            config.google_chirp3.region.endpoint(),
            "asia-northeast1-speech.googleapis.com"
        );
    }

    #[test]
    fn transcript_keeps_target_language_separate_from_provider() {
        let mut config = default_asr_config();
        config.provider = AsrProviderId::VolcDoubao;
        let document = transcribe(AsrTranscriptionRequest {
            job_id: Some("test".to_string()),
            audio_path: "/tmp/audio.wav".to_string(),
            config,
        })
        .expect("transcript");

        assert_eq!(document.provider, AsrProviderId::VolcDoubao);
        assert_eq!(document.target_language, TargetLanguageCode::ZhHansCn);
    }

    #[test]
    fn local_whisper_requires_model_path() {
        let mut config = default_asr_config();
        config.provider = AsrProviderId::LocalWhisper;

        let error = transcribe(AsrTranscriptionRequest {
            job_id: None,
            audio_path: "/tmp/audio.wav".to_string(),
            config,
        })
        .expect_err("missing model path should fail");

        assert!(matches!(error, AsrError::MissingWhisperModelPath));
    }

    #[test]
    fn bailian_result_parses_sentences_into_unified_segments() {
        let config = default_asr_config();
        let result = json!({
            "transcripts": [{
                "channel_id": 0,
                "sentences": [{
                    "sentence_id": 7,
                    "begin_time": 100,
                    "end_time": 1440,
                    "language": "en",
                    "text": "Welcome to Aliyun.",
                    "confidence": 0.88
                }]
            }]
        });

        let document = parse_bailian_transcription_result(
            &AsrTranscriptionRequest {
                job_id: None,
                audio_path: "https://example.com/audio.mp3".to_string(),
                config,
            },
            AsrProviderId::AliyunBailian,
            &result,
        );

        assert_eq!(document.source_language, SourceLanguageCode::EnUs);
        assert_eq!(document.segments.len(), 1);
        assert_eq!(document.segments[0].id, "seg_0_7");
        assert_eq!(document.segments[0].start_ms, 100);
        assert_eq!(document.segments[0].end_ms, 1440);
        assert_eq!(
            document.segments[0].speaker_id.as_deref(),
            Some("channel_0")
        );
    }

    #[test]
    fn bailian_task_url_parser_supports_qwen_output_shape() {
        let response = json!({
            "output": {
                "task_status": "SUCCEEDED",
                "result": {
                    "transcription_url": "https://example.com/result.json"
                }
            }
        });

        assert_eq!(
            extract_bailian_transcription_url(&response).as_deref(),
            Some("https://example.com/result.json")
        );
    }

    #[test]
    fn rejects_youtube_watch_urls_before_submit() {
        let error = validate_public_media_url("https://www.youtube.com/watch?v=QIwLqXJkX08&t=50s")
            .expect_err("youtube watch URLs are not media file URLs");

        assert!(matches!(error, AsrError::UnsupportedYoutubeUrl));
    }
}
