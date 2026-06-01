use crate::credentials::{CredentialError, CredentialStore};
use base64::Engine as _;
use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::thread;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

const BAILIAN_LOCAL_CHUNK_SECONDS: u64 = 9_000;
const VOLC_LOCAL_CHUNK_SECONDS: u64 = 1_800;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AsrProviderId {
    AliyunBailian,
    GoogleChirp3,
    VolcDoubao,
    VolcArk,
    LocalWhisper,
}

impl AsrProviderId {
    pub fn as_keyring_account(self) -> &'static str {
        match self {
            AsrProviderId::AliyunBailian => "aliyun_bailian",
            AsrProviderId::GoogleChirp3 => "google_chirp3",
            AsrProviderId::VolcDoubao => "volc_doubao",
            AsrProviderId::VolcArk => "volc_ark",
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

    pub fn as_volc_speech_mt_language(&self) -> Option<&'static str> {
        match self {
            SourceLanguageCode::Auto => None,
            SourceLanguageCode::EnUs => Some("en"),
            SourceLanguageCode::JaJp => Some("ja"),
            SourceLanguageCode::KoKr => Some("ko"),
            SourceLanguageCode::CmnHansCn => Some("zh"),
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

    pub fn as_volc_speech_mt_language(&self) -> &'static str {
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
    pub app_id: String,
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
    #[serde(default)]
    pub output_dir: Option<String>,
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
    #[error("本地音频提取或上传失败：{0}")]
    LocalProcessing(String),
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
            app_id: String::new(),
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
        AsrProviderId::VolcArk => Box::new(VolcDoubaoProvider),
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

        let api_key = CredentialStore::default()
            .get(self.id())?
            .ok_or(AsrError::MissingCredential)?;
        let client = Client::builder().timeout(Duration::from_secs(30)).build()?;

        let is_public_url =
            request.audio_path.starts_with("http://") || request.audio_path.starts_with("https://");

        if is_public_url {
            let file_url = validate_public_media_url(&request.audio_path)?.to_string();
            transcribe_bailian_file_url(&client, &api_key, request, self.id(), &file_url)
        } else {
            let temp_audio_paths = extract_audio_chunks_to_temp(
                &request.audio_path,
                BAILIAN_LOCAL_CHUNK_SECONDS,
                request.output_dir.as_deref(),
            )
            .map_err(AsrError::LocalProcessing)?;
            let transcription_result = (|| -> Result<TranscriptDocument, AsrError> {
                let policy = get_dashscope_upload_policy(
                    &client,
                    &api_key,
                    request.config.aliyun_bailian.model.as_model_name(),
                )?;

                let mut document = TranscriptDocument {
                    source_language: request.config.source_language.clone(),
                    target_language: request.config.target_language.clone(),
                    provider: self.id(),
                    segments: Vec::new(),
                };
                let mut chunk_offset_ms = 0;

                for (chunk_index, temp_audio_path) in temp_audio_paths.iter().enumerate() {
                    let file_url = upload_file_to_dashscope_oss(&client, &policy, temp_audio_path)?;
                    let mut chunk_document = transcribe_bailian_file_url(
                        &client,
                        &api_key,
                        request,
                        self.id(),
                        &file_url,
                    )?;

                    if document.source_language == SourceLanguageCode::Auto
                        && chunk_document.source_language != SourceLanguageCode::Auto
                    {
                        document.source_language = chunk_document.source_language.clone();
                    }
                    for segment in &mut chunk_document.segments {
                        segment.id = format!("chunk_{chunk_index}_{}", segment.id);
                        segment.start_ms += chunk_offset_ms;
                        segment.end_ms += chunk_offset_ms;
                    }
                    document.segments.extend(chunk_document.segments);
                    chunk_offset_ms += audio_duration_ms(temp_audio_path)?;
                }

                Ok(document)
            })();

            transcription_result
        }
    }
}

fn transcribe_bailian_file_url(
    client: &Client,
    api_key: &str,
    request: &AsrTranscriptionRequest,
    provider: AsrProviderId,
    file_url: &str,
) -> Result<TranscriptDocument, AsrError> {
    let task_id = submit_bailian_qwen_task(client, api_key, request, file_url)?;
    let transcription_url = poll_bailian_task(client, api_key, request, &task_id)?;
    let result_json = client
        .get(transcription_url)
        .header("X-DashScope-OssResourceResolve", "enable")
        .send()?
        .error_for_status()?
        .json::<Value>()?;

    Ok(parse_bailian_transcription_result(
        request,
        provider,
        &result_json,
    ))
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
        .header("X-DashScope-OssResourceResolve", "enable")
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
            .header("X-DashScope-OssResourceResolve", "enable")
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
        let api_key = CredentialStore::default()
            .get(self.id())?
            .ok_or(AsrError::MissingCredential)?;
        let client = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()?;
        let resource_id = request.config.volc_doubao.resource_id.trim();
        let resource_id = if resource_id.is_empty() {
            "volc.bigasr.auc_turbo"
        } else {
            resource_id
        };

        let uid = request.config.volc_doubao.app_id.trim();
        let uid = if uid.is_empty() { "intervox_user" } else { uid };
        let is_public_url =
            request.audio_path.starts_with("http://") || request.audio_path.starts_with("https://");
        if is_public_url {
            let audio =
                json!({ "url": validate_public_media_url(&request.audio_path)?.to_string() });
            return transcribe_volc_audio(&client, &api_key, resource_id, uid, request, audio);
        }

        let temp_audio_paths = extract_audio_chunks_to_temp(
            &request.audio_path,
            VOLC_LOCAL_CHUNK_SECONDS,
            request.output_dir.as_deref(),
        )
        .map_err(AsrError::LocalProcessing)?;
        let transcription_result = (|| -> Result<TranscriptDocument, AsrError> {
            let mut document = TranscriptDocument {
                source_language: request.config.source_language.clone(),
                target_language: request.config.target_language.clone(),
                provider: self.id(),
                segments: Vec::new(),
            };
            let mut chunk_offset_ms = 0;

            for (chunk_index, temp_audio_path) in temp_audio_paths.iter().enumerate() {
                let audio_bytes = std::fs::read(temp_audio_path).map_err(|error| {
                    AsrError::LocalProcessing(format!(
                        "Unable to read temporary audio chunk: {error}"
                    ))
                })?;
                let audio_b64 = base64::engine::general_purpose::STANDARD.encode(audio_bytes);
                let mut chunk_document = transcribe_volc_audio(
                    &client,
                    &api_key,
                    resource_id,
                    uid,
                    request,
                    json!({ "data": audio_b64 }),
                )?;

                for segment in &mut chunk_document.segments {
                    segment.id = format!("chunk_{chunk_index}_{}", segment.id);
                    segment.start_ms += chunk_offset_ms;
                    segment.end_ms += chunk_offset_ms;
                }
                document.segments.extend(chunk_document.segments);
                chunk_offset_ms += audio_duration_ms(temp_audio_path)?;
            }

            Ok(document)
        })();

        transcription_result
    }
}

fn transcribe_volc_audio(
    client: &Client,
    api_key: &str,
    resource_id: &str,
    uid: &str,
    request: &AsrTranscriptionRequest,
    audio: Value,
) -> Result<TranscriptDocument, AsrError> {
    let payload = json!({
        "user": {
            "uid": uid
        },
        "audio": audio,
        "request": {
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true
        }
    });

    let response = client
        .post("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")
        .header("Content-Type", "application/json")
        .header("X-Api-Key", api_key)
        .header("X-Api-Resource-Id", resource_id)
        .header("X-Api-Request-Id", Uuid::new_v4().to_string())
        .header("X-Api-Sequence", "-1")
        .json(&payload)
        .send()?;

    let headers = response.headers().clone();
    let status = response.status();
    let response_text = response.text()?;

    if !status.is_success() {
        return Err(AsrError::Api(format!(
            "火山引擎豆包录音识别失败 (HTTP {}): {}",
            status,
            truncate_for_error(&response_text)
        )));
    }

    let api_status = headers
        .get("X-Api-Status-Code")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !api_status.is_empty() && api_status != "20000000" {
        let api_message = headers
            .get("X-Api-Message")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("未知错误");
        let logid = headers
            .get("X-Tt-Logid")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-");
        return Err(AsrError::Api(format!(
            "火山引擎豆包录音识别失败：{} {} (logid: {})",
            api_status, api_message, logid
        )));
    }

    let response_json: Value = serde_json::from_str(&response_text).map_err(|error| {
        AsrError::Api(format!(
            "火山引擎豆包录音识别响应不是 JSON：{error}；原始响应：{}",
            truncate_for_error(&response_text)
        ))
    })?;

    parse_volc_flash_transcription_result(request, AsrProviderId::VolcDoubao, &response_json)
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

fn parse_volc_flash_transcription_result(
    request: &AsrTranscriptionRequest,
    provider: AsrProviderId,
    result: &Value,
) -> Result<TranscriptDocument, AsrError> {
    let mut segments = Vec::new();

    if let Some(utterances) = result
        .pointer("/result/utterances")
        .and_then(Value::as_array)
    {
        for (index, utterance) in utterances.iter().enumerate() {
            let text = utterance
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if text.is_empty() {
                continue;
            }

            segments.push(TranscriptSegment {
                id: format!("seg_0_{index}"),
                start_ms: utterance
                    .get("start_time")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                end_ms: utterance
                    .get("end_time")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                speaker_id: extract_speaker_id(utterance).or_else(|| Some("channel_0".to_string())),
                text: text.to_string(),
                confidence: None,
            });
        }
    }

    if segments.is_empty() {
        if let Some(text) = result
            .pointer("/result/text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            let duration = result
                .pointer("/audio_info/duration")
                .and_then(Value::as_u64)
                .or_else(|| {
                    result
                        .pointer("/result/additions/duration")
                        .and_then(Value::as_str)
                        .and_then(|duration| duration.parse::<u64>().ok())
                })
                .unwrap_or(0);
            segments.push(TranscriptSegment {
                id: "seg_0_0".to_string(),
                start_ms: 0,
                end_ms: duration,
                speaker_id: Some("channel_0".to_string()),
                text: text.to_string(),
                confidence: None,
            });
        }
    }

    if segments.is_empty() {
        return Err(AsrError::Api(format!(
            "火山引擎豆包录音识别未返回有效转写分段：{}",
            truncate_for_error(&result.to_string())
        )));
    }

    Ok(TranscriptDocument {
        source_language: request.config.source_language.clone(),
        target_language: request.config.target_language.clone(),
        provider,
        segments,
    })
}

fn truncate_for_error(text: &str) -> String {
    let trimmed = text.trim();
    let limit = trimmed
        .char_indices()
        .map(|(index, _)| index)
        .nth(300)
        .unwrap_or(trimmed.len());
    trimmed[..limit].to_string()
}

fn extract_audio_chunks_to_temp(
    input_video_path: &str,
    chunk_seconds: u64,
    output_dir: Option<&str>,
) -> Result<Vec<std::path::PathBuf>, String> {
    let input_path = std::path::Path::new(input_video_path);
    if !input_path.exists() {
        return Err("Input video file does not exist.".to_string());
    }

    let temp_dir = crate::storage::ensure_output_subdir(output_dir, "temp_audio")
        .map_err(|e| e.to_string())?;

    let chunk_prefix = format!("temp_asr_chunk_{}", uuid::Uuid::new_v4());
    let output_pattern = temp_dir.join(format!("{chunk_prefix}_%03d.mp3"));
    let mut cmd = std::process::Command::new(crate::export::ffmpeg_path());
    cmd.arg("-y")
        .arg("-i")
        .arg(input_video_path)
        .arg("-vn")
        .arg("-c:a")
        .arg("libmp3lame")
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg("-b:a")
        .arg("64k")
        .arg("-f")
        .arg("segment")
        .arg("-segment_time")
        .arg(chunk_seconds.to_string())
        .arg("-reset_timestamps")
        .arg("1")
        .arg(&output_pattern);

    let output = cmd
        .output()
        .map_err(|_| "FFmpeg was not found. Please install FFmpeg first.".to_string())?;
    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("Audio chunk extraction failed: {err_msg}"));
    }

    let mut chunks = std::fs::read_dir(&temp_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&chunk_prefix) && name.ends_with(".mp3"))
        })
        .collect::<Vec<_>>();
    chunks.sort();
    if chunks.is_empty() {
        return Err("FFmpeg did not produce any audio chunks.".to_string());
    }

    Ok(chunks)
}

fn audio_duration_ms(path: &std::path::Path) -> Result<u64, AsrError> {
    let ffprobe = crate::export::ffprobe_path();
    let output = std::process::Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(path)
        .output()
        .map_err(|_| AsrError::LocalProcessing("ffprobe was not found.".to_string()))?;
    if !output.status.success() {
        return Err(AsrError::LocalProcessing(
            "Unable to read extracted audio chunk duration.".to_string(),
        ));
    }

    let seconds = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|error| AsrError::LocalProcessing(error.to_string()))?;
    Ok((seconds * 1000.0).round() as u64)
}

#[derive(Debug, Deserialize)]
pub struct UploadPolicyData {
    pub upload_host: String,
    pub upload_dir: String,
    pub oss_access_key_id: String,
    pub signature: String,
    pub policy: String,
    pub x_oss_object_acl: String,
    pub x_oss_forbid_overwrite: String,
}

#[derive(Debug, Deserialize)]
pub struct UploadPolicyResponse {
    pub data: UploadPolicyData,
}

pub fn get_dashscope_upload_policy(
    client: &Client,
    api_key: &str,
    model: &str,
) -> Result<UploadPolicyData, AsrError> {
    let url = format!(
        "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model={}",
        model
    );
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()?
        .error_for_status()?
        .json::<UploadPolicyResponse>()?;
    Ok(resp.data)
}

pub fn upload_file_to_dashscope_oss(
    client: &Client,
    policy_data: &UploadPolicyData,
    local_file_path: &std::path::Path,
) -> Result<String, AsrError> {
    let file_name = local_file_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AsrError::LocalProcessing("无法解析临时音频文件名".to_string()))?;

    let key = format!("{}/{}", policy_data.upload_dir, file_name);

    let form = reqwest::blocking::multipart::Form::new()
        .text("OSSAccessKeyId", policy_data.oss_access_key_id.clone())
        .text("policy", policy_data.policy.clone())
        .text("Signature", policy_data.signature.clone())
        .text("key", key.clone())
        .text("x-oss-object-acl", policy_data.x_oss_object_acl.clone())
        .text(
            "x-oss-forbid-overwrite",
            policy_data.x_oss_forbid_overwrite.clone(),
        )
        .text("success_action_status", "200")
        .file("file", local_file_path)
        .map_err(|e| AsrError::LocalProcessing(format!("读取上传文件失败：{e}")))?;

    let _resp = client
        .post(&policy_data.upload_host)
        .multipart(form)
        .send()?
        .error_for_status()?;

    Ok(format!("oss://{}", key))
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
        let response = json!({
            "audio_info": { "duration": 2499 },
            "result": {
                "text": "关闭透传。",
                "utterances": [
                    {
                        "start_time": 450,
                        "end_time": 1530,
                        "text": "关闭透传。"
                    }
                ]
            }
        });
        let document = parse_volc_flash_transcription_result(
            &AsrTranscriptionRequest {
                job_id: None,
                audio_path: "https://example.com/audio.mp3".to_string(),
                output_dir: None,
                config,
            },
            AsrProviderId::VolcDoubao,
            &response,
        )
        .expect("transcript");

        assert_eq!(document.provider, AsrProviderId::VolcDoubao);
        assert_eq!(document.target_language, TargetLanguageCode::ZhHansCn);
        assert_eq!(document.segments[0].text, "关闭透传。");
    }

    #[test]
    fn local_whisper_requires_model_path() {
        let mut config = default_asr_config();
        config.provider = AsrProviderId::LocalWhisper;

        let error = transcribe(AsrTranscriptionRequest {
            job_id: None,
            audio_path: "/tmp/audio.wav".to_string(),
            output_dir: None,
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
                output_dir: None,
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

    #[test]
    fn volc_flash_text_fallback_uses_audio_duration() {
        let request = AsrTranscriptionRequest {
            job_id: None,
            audio_path: "https://example.com/audio.mp3".to_string(),
            output_dir: None,
            config: default_asr_config(),
        };
        let response = json!({
            "audio_info": { "duration": 2499 },
            "result": {
                "text": "完整文本。",
                "utterances": []
            }
        });

        let document =
            parse_volc_flash_transcription_result(&request, AsrProviderId::VolcDoubao, &response)
                .expect("text fallback should parse");

        assert_eq!(document.segments.len(), 1);
        assert_eq!(document.segments[0].start_ms, 0);
        assert_eq!(document.segments[0].end_ms, 2499);
        assert_eq!(document.segments[0].text, "完整文本。");
    }
}
