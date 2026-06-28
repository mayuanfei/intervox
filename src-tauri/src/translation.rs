use crate::asr::{
    AsrProviderId, BailianDeployment, TargetLanguageCode, TranscriptDocument, TranscriptSegment,
};
use crate::credentials::{CredentialError, CredentialStore};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::error::Error as StdError;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

const LLM_TRANSLATION_BATCH_SIZE: usize = 8;
const LLM_TRANSLATION_RETRY_BATCH_SIZE: usize = 4;
const VOLC_SPEECH_MT_BATCH_SIZE: usize = 16;
const TRANSLATION_TIMEOUT_SECS: u64 = 180;
const VOLC_SPEECH_MT_URL: &str =
    "https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate";
const VOLC_SPEECH_MT_RESOURCE_ID: &str = "volc.speech.mt";
const VOLC_SPEECH_MT_SUCCESS_CODE: i64 = 20_000_000;
const TRANSLATION_MERGE_MAX_GAP_MS: u64 = 500;
const TRANSLATION_MERGE_MAX_DURATION_MS: u64 = 8_000;
const TRANSLATION_MERGE_MAX_CHARS: usize = 220;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranslationBackend {
    AliyunQwen,
    VolcArk,
    VolcSpeechMt,
    Deepseek,
    GoogleTranslate,
    LocalLlm,
}

impl TranslationBackend {
    fn from_provider(provider: &str) -> Self {
        match provider.trim() {
            "volc_speech_mt" => Self::VolcSpeechMt,
            "volc_ark" => Self::VolcArk,
            "deepseek" => Self::Deepseek,
            "google_translate" => Self::GoogleTranslate,
            "local_llm" => Self::LocalLlm,
            _ => Self::AliyunQwen,
        }
    }

    fn credential_provider(self) -> AsrProviderId {
        match self {
            Self::AliyunQwen => AsrProviderId::AliyunBailian,
            Self::VolcArk => AsrProviderId::VolcArk,
            Self::VolcSpeechMt => AsrProviderId::VolcDoubao,
            Self::Deepseek => AsrProviderId::Deepseek,
            Self::GoogleTranslate => AsrProviderId::GoogleTranslate,
            Self::LocalLlm => AsrProviderId::LocalWhisper,
        }
    }

    fn batch_size(self) -> usize {
        match self {
            Self::VolcSpeechMt => VOLC_SPEECH_MT_BATCH_SIZE,
            Self::GoogleTranslate => 16,
            Self::AliyunQwen | Self::VolcArk | Self::Deepseek | Self::LocalLlm => {
                LLM_TRANSLATION_BATCH_SIZE
            }
        }
    }

    fn document_provider(self) -> &'static str {
        match self {
            Self::AliyunQwen => "aliyun_qwen",
            Self::VolcArk => "volc_ark",
            Self::VolcSpeechMt => "volc_speech_mt",
            Self::Deepseek => "deepseek",
            Self::GoogleTranslate => "google_translate",
            Self::LocalLlm => "local_llm",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TranslationRequest {
    pub transcript: TranscriptDocument,
    pub provider: String,
    pub model: String,
    pub deployment: BailianDeployment,
    pub local_endpoint: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TranslationDocument {
    pub source_language: String,
    pub target_language: TargetLanguageCode,
    pub provider: String,
    pub segments: Vec<TranslationSegment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TranslationSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: Option<String>,
    pub source_text: String,
    pub translated_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranslationProgress {
    pub stage: String,
    pub completed_batches: usize,
    pub total_batches: usize,
    pub completed_segments: usize,
    pub total_segments: usize,
    pub progress: f32,
}

#[derive(Debug, Error)]
pub enum TranslationError {
    #[error("没有可翻译的转写内容。")]
    EmptyTranscript,
    #[error("请先保存对应的 API Key。")]
    MissingCredential,
    #[error("翻译请求失败：{0}")]
    Http(String),
    #[error("翻译接口返回异常：{0}")]
    Api(String),
    #[error("凭据错误：{0}")]
    Credential(#[from] CredentialError),
}

#[allow(dead_code)]
pub fn translate(
    request: TranslationRequest,
    credentials: &CredentialStore,
) -> Result<TranslationDocument, TranslationError> {
    translate_with_progress(request, credentials, |_| {})
}

pub fn translate_with_progress<F>(
    request: TranslationRequest,
    credentials: &CredentialStore,
    mut on_progress: F,
) -> Result<TranslationDocument, TranslationError>
where
    F: FnMut(TranslationProgress),
{
    if request.transcript.segments.is_empty() {
        return Err(TranslationError::EmptyTranscript);
    }

    let merged_segments = merge_transcript_segments(&request.transcript.segments);
    if merged_segments.is_empty() {
        return Err(TranslationError::EmptyTranscript);
    }
    let request = TranslationRequest {
        transcript: TranscriptDocument {
            source_language: request.transcript.source_language,
            target_language: request.transcript.target_language,
            provider: request.transcript.provider,
            segments: merged_segments,
        },
        provider: request.provider,
        model: request.model,
        deployment: request.deployment,
        local_endpoint: request.local_endpoint.clone(),
    };

    let backend = TranslationBackend::from_provider(&request.provider);
    let batch_size = backend.batch_size();
    let api_key = if backend == TranslationBackend::LocalLlm {
        String::new()
    } else {
        credentials
            .get(backend.credential_provider())?
            .ok_or(TranslationError::MissingCredential)?
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(TRANSLATION_TIMEOUT_SECS))
        .build()
        .map_err(http_error)?;

    let total_segments = request.transcript.segments.len();
    let total_batches = total_segments.div_ceil(batch_size);
    let mut segments = Vec::with_capacity(total_segments);
    on_progress(TranslationProgress {
        stage: "started".to_string(),
        completed_batches: 0,
        total_batches,
        completed_segments: 0,
        total_segments,
        progress: 0.0,
    });

    for (batch_index, batch) in request.transcript.segments.chunks(batch_size).enumerate() {
        let batch_request = TranslationRequest {
            transcript: TranscriptDocument {
                source_language: request.transcript.source_language.clone(),
                target_language: request.transcript.target_language.clone(),
                provider: request.transcript.provider,
                segments: batch.to_vec(),
            },
            provider: request.provider.clone(),
            model: request.model.clone(),
            deployment: request.deployment.clone(),
            local_endpoint: request.local_endpoint.clone(),
        };
        let batch_document =
            request_complete_translation_batch(&client, &api_key, &batch_request, backend)?;
        segments.extend(batch_document.segments);
        let completed_batches = batch_index + 1;
        let completed_segments = segments.len();
        on_progress(TranslationProgress {
            stage: "batch_completed".to_string(),
            completed_batches,
            total_batches,
            completed_segments,
            total_segments,
            progress: completed_segments as f32 / total_segments as f32,
        });
    }

    on_progress(TranslationProgress {
        stage: "completed".to_string(),
        completed_batches: total_batches,
        total_batches,
        completed_segments: total_segments,
        total_segments,
        progress: 1.0,
    });

    Ok(TranslationDocument {
        source_language: serde_json::to_value(&request.transcript.source_language)
            .ok()
            .and_then(|v| v.as_str().map(ToString::to_string))
            .unwrap_or_else(|| "auto".to_string()),
        target_language: request.transcript.target_language,
        provider: backend.document_provider().to_string(),
        segments,
    })
}

fn request_complete_translation_batch(
    client: &Client,
    api_key: &str,
    request: &TranslationRequest,
    backend: TranslationBackend,
) -> Result<TranslationDocument, TranslationError> {
    let mut document = request_translation_document(client, api_key, request, backend)?;
    if ensure_translation_complete(&document).is_ok() {
        return Ok(document);
    }

    let missing_segments = missing_transcript_segments(request, &document);
    for segments in missing_segments.chunks(LLM_TRANSLATION_RETRY_BATCH_SIZE) {
        let retry_request = translation_request_with_segments(request, segments.to_vec());
        if let Ok(retry_document) =
            request_translation_document(client, api_key, &retry_request, backend)
        {
            merge_translation_segments(&mut document, retry_document);
        }
    }

    for segment in missing_transcript_segments(request, &document) {
        let retry_request = translation_request_with_segments(request, vec![segment]);
        let retry_document =
            request_translation_document(client, api_key, &retry_request, backend)?;
        merge_translation_segments(&mut document, retry_document);
    }

    ensure_translation_complete(&document)?;
    Ok(document)
}

fn request_translation_document(
    client: &Client,
    api_key: &str,
    request: &TranslationRequest,
    backend: TranslationBackend,
) -> Result<TranslationDocument, TranslationError> {
    let response = request_translation_batch(client, api_key, request, backend)?;
    Ok(parse_translation_response(
        request,
        &response,
        backend.document_provider(),
    ))
}

fn missing_transcript_segments(
    request: &TranslationRequest,
    document: &TranslationDocument,
) -> Vec<TranscriptSegment> {
    request
        .transcript
        .segments
        .iter()
        .filter(|segment| {
            document
                .segments
                .iter()
                .find(|translation| translation.id == segment.id)
                .is_none_or(|translation| translation.translated_text.trim().is_empty())
        })
        .cloned()
        .collect()
}

fn translation_request_with_segments(
    request: &TranslationRequest,
    segments: Vec<TranscriptSegment>,
) -> TranslationRequest {
    TranslationRequest {
        transcript: TranscriptDocument {
            source_language: request.transcript.source_language.clone(),
            target_language: request.transcript.target_language.clone(),
            provider: request.transcript.provider,
            segments,
        },
        provider: request.provider.clone(),
        model: request.model.clone(),
        deployment: request.deployment.clone(),
        local_endpoint: request.local_endpoint.clone(),
    }
}

fn merge_translation_segments(
    document: &mut TranslationDocument,
    retry_document: TranslationDocument,
) {
    for retry_segment in retry_document.segments {
        if retry_segment.translated_text.trim().is_empty() {
            continue;
        }
        if let Some(segment) = document
            .segments
            .iter_mut()
            .find(|segment| segment.id == retry_segment.id)
        {
            segment.translated_text = retry_segment.translated_text;
        }
    }
}

fn merge_transcript_segments(segments: &[TranscriptSegment]) -> Vec<TranscriptSegment> {
    let mut merged = Vec::new();
    let mut current: Option<TranscriptSegment> = None;

    for segment in segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
    {
        match current.take() {
            Some(mut current_segment)
                if should_merge_transcript_segments(&current_segment, segment) =>
            {
                current_segment.end_ms = current_segment.end_ms.max(segment.end_ms);
                current_segment.text = join_transcript_text(&current_segment.text, &segment.text);
                current_segment.confidence =
                    merge_confidence(current_segment.confidence, segment.confidence);
                current = Some(current_segment);
            }
            Some(current_segment) => {
                merged.push(current_segment);
                current = Some(segment.clone());
            }
            None => current = Some(segment.clone()),
        }
    }

    if let Some(current_segment) = current {
        merged.push(current_segment);
    }

    merged
}

fn should_merge_transcript_segments(current: &TranscriptSegment, next: &TranscriptSegment) -> bool {
    let gap_ms = next.start_ms.saturating_sub(current.end_ms);
    let duration_ms = next.end_ms.saturating_sub(current.start_ms);
    let chars = current.text.chars().count() + next.text.chars().count();

    current.speaker_id == next.speaker_id
        && gap_ms <= TRANSLATION_MERGE_MAX_GAP_MS
        && duration_ms <= TRANSLATION_MERGE_MAX_DURATION_MS
        && chars <= TRANSLATION_MERGE_MAX_CHARS
        && !ends_sentence_before(&current.text, &next.text)
}

fn ends_sentence_before(current: &str, next: &str) -> bool {
    let current = current.trim_end().trim_end_matches(|character: char| {
        matches!(character, '"' | '\'' | ')' | ']' | '”' | '’' | '）' | '】')
    });
    let Some(last) = current.chars().last() else {
        return false;
    };

    if last == '.' && is_numeric_continuation(current, next) {
        return false;
    }

    matches!(last, '.' | '!' | '?' | '。' | '！' | '？')
}

fn is_numeric_continuation(current: &str, next: &str) -> bool {
    current
        .trim_end_matches('.')
        .chars()
        .last()
        .is_some_and(|character| character.is_ascii_digit())
        && next
            .trim_start()
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
}

fn join_transcript_text(current: &str, next: &str) -> String {
    let current = current.trim_end();
    let next = next.trim_start();
    if is_numeric_continuation(current, next) {
        return format!("{current}{next}");
    }

    let separator = match (current.chars().last(), next.chars().next()) {
        (Some(left), Some(right)) if left.is_ascii() || right.is_ascii() => " ",
        _ => "",
    };
    format!("{current}{separator}{next}")
}

fn merge_confidence(current: Option<f32>, next: Option<f32>) -> Option<f32> {
    match (current, next) {
        (Some(current), Some(next)) => Some(current.min(next)),
        (Some(confidence), None) | (None, Some(confidence)) => Some(confidence),
        (None, None) => None,
    }
}

fn ensure_translation_complete(document: &TranslationDocument) -> Result<(), TranslationError> {
    let missing_ids: Vec<&str> = document
        .segments
        .iter()
        .filter(|segment| segment.translated_text.trim().is_empty())
        .map(|segment| segment.id.as_str())
        .collect();

    if missing_ids.is_empty() {
        return Ok(());
    }

    let preview = missing_ids
        .iter()
        .take(8)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if missing_ids.len() > 8 { " ..." } else { "" };

    Err(TranslationError::Api(format!(
        "翻译结果不完整，缺少 {}/{} 段：{preview}{suffix}。请重新翻译，避免生成错位视频。",
        missing_ids.len(),
        document.segments.len()
    )))
}

fn clean_json_content(content: &str) -> &str {
    let mut s = content.trim();
    if s.starts_with("```") {
        if s.starts_with("```json") {
            s = &s[7..];
        } else {
            s = &s[3..];
        }
        if s.ends_with("```") {
            s = &s[..s.len() - 3];
        }
    }
    s.trim()
}

fn request_translation_batch(
    client: &Client,
    api_key: &str,
    request: &TranslationRequest,
    backend: TranslationBackend,
) -> Result<Value, TranslationError> {
    match backend {
        TranslationBackend::VolcSpeechMt => request_volc_speech_mt_batch(client, api_key, request),
        TranslationBackend::AliyunQwen | TranslationBackend::VolcArk => {
            request_llm_translation_batch(client, api_key, request, backend)
        }
        TranslationBackend::Deepseek => {
            request_deepseek_translation_batch(client, api_key, request)
        }
        TranslationBackend::GoogleTranslate => {
            request_google_translate_batch(client, api_key, request)
        }
        TranslationBackend::LocalLlm => request_local_llm_batch(client, request),
    }
}

fn request_deepseek_translation_batch(
    client: &Client,
    api_key: &str,
    request: &TranslationRequest,
) -> Result<Value, TranslationError> {
    let model_name = request.model.trim();
    let model = if model_name.is_empty() {
        "deepseek-v4-flash"
    } else {
        model_name
    };
    let url = "https://api.deepseek.com/chat/completions";

    let payload = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是专业视频本地化翻译。保持原意，翻译要自然口语化，适合配音朗读。请直接返回符合指定结构的 JSON，不要有任何 Markdown 标记或其它解释性文字。"
            },
            {
                "role": "user",
                "content": build_translation_prompt(&request)
            }
        ],
        "temperature": 0.2,
        "response_format": { "type": "json_object" }
    });

    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .map_err(http_error)?;
    let status = response.status();
    let response_text = response.text().map_err(http_error)?;

    if !status.is_success() {
        return Err(TranslationError::Api(format!(
            "DeepSeek API HTTP {status}: {}",
            truncate_for_error(&response_text)
        )));
    }

    let response_json: Value = serde_json::from_str(&response_text).map_err(|error| {
        TranslationError::Api(format!(
            "DeepSeek 响应不是 JSON：{error}；原始响应：{}",
            truncate_for_error(&response_text)
        ))
    })?;

    let content = response_json
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            TranslationError::Api(format!("DeepSeek 未返回 message.content：{response_json}"))
        })?;

    let cleaned = clean_json_content(content);
    let content_json: Value = serde_json::from_str(cleaned).map_err(|error| {
        TranslationError::Api(format!("JSON解析失败: {error}; 原始文本: {content}"))
    })?;

    Ok(content_json)
}

fn request_google_translate_batch(
    client: &Client,
    api_key: &str,
    request: &TranslationRequest,
) -> Result<Value, TranslationError> {
    let google_lang = match request.transcript.target_language {
        TargetLanguageCode::ZhHansCn => "zh-CN",
        TargetLanguageCode::EnUs => "en",
        TargetLanguageCode::JaJp => "ja",
        TargetLanguageCode::KoKr => "ko",
        TargetLanguageCode::EsEs => "es",
        TargetLanguageCode::FrFr => "fr",
        TargetLanguageCode::DeDe => "de",
    };

    let text_list: Vec<String> = request
        .transcript
        .segments
        .iter()
        .map(|segment| segment.text.clone())
        .collect();

    let url = format!("https://translation.googleapis.com/language/translate/v2?key={api_key}");
    let payload = json!({
        "q": text_list,
        "target": google_lang,
        "format": "text"
    });

    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .map_err(http_error)?;
    let status = response.status();
    let response_text = response.text().map_err(http_error)?;

    if !status.is_success() {
        return Err(TranslationError::Api(format!(
            "Google Translate API HTTP {status}: {}",
            truncate_for_error(&response_text)
        )));
    }

    let response_json: Value = serde_json::from_str(&response_text).map_err(|error| {
        TranslationError::Api(format!(
            "Google Translate 响应不是 JSON：{error}；原始响应：{}",
            truncate_for_error(&response_text)
        ))
    })?;

    let translations = response_json
        .pointer("/data/translations")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            TranslationError::Api(format!("Google Translate 响应格式错误：{response_json}"))
        })?;

    if translations.len() != request.transcript.segments.len() {
        return Err(TranslationError::Api(format!(
            "Google 翻译结果数量不匹配：请求 {} 段，返回 {} 段。",
            request.transcript.segments.len(),
            translations.len()
        )));
    }

    let segments: Vec<Value> = request
        .transcript
        .segments
        .iter()
        .zip(translations)
        .map(|(segment, item)| {
            let translated_text = item
                .get("translatedText")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            json!({
                "id": segment.id,
                "translated_text": translated_text
            })
        })
        .collect();

    Ok(json!({ "segments": segments }))
}

fn request_local_llm_batch(
    client: &Client,
    request: &TranslationRequest,
) -> Result<Value, TranslationError> {
    let local_endpoint = request
        .local_endpoint
        .as_deref()
        .unwrap_or("http://localhost:11434/v1")
        .trim_end_matches('/');
    let url = format!("{local_endpoint}/chat/completions");

    let model_name = request.model.trim();
    let model = if model_name.is_empty() {
        "qwen2.5"
    } else {
        model_name
    };

    let payload = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是专业视频本地化翻译。保持原意，翻译要自然口语化，适合配音朗读。请直接返回符合指定结构的 JSON，不要有任何 Markdown 标记或其它解释性文字。"
            },
            {
                "role": "user",
                "content": build_translation_prompt(&request)
            }
        ],
        "temperature": 0.2,
        "response_format": { "type": "json_object" }
    });

    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .map_err(http_error)?;
    let status = response.status();
    let response_text = response.text().map_err(http_error)?;

    if !status.is_success() {
        return Err(TranslationError::Api(format!(
            "本地 LLM (Ollama) HTTP {status}: {}",
            truncate_for_error(&response_text)
        )));
    }

    let response_json: Value = serde_json::from_str(&response_text).map_err(|error| {
        TranslationError::Api(format!(
            "本地 LLM 响应不是 JSON：{error}；原始响应：{}",
            truncate_for_error(&response_text)
        ))
    })?;

    let content = response_json
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            TranslationError::Api(format!("本地 LLM 未返回 message.content：{response_json}"))
        })?;

    let cleaned = clean_json_content(content);
    let content_json: Value = serde_json::from_str(cleaned).map_err(|error| {
        TranslationError::Api(format!("JSON解析失败: {error}; 原始文本: {content}"))
    })?;

    Ok(content_json)
}

fn request_llm_translation_batch(
    client: &Client,
    api_key: &str,
    request: &TranslationRequest,
    backend: TranslationBackend,
) -> Result<Value, TranslationError> {
    let model_name = request.model.trim();
    let is_volc_ark = backend == TranslationBackend::VolcArk;

    let url = if is_volc_ark {
        "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    } else {
        request.deployment.compatible_chat_url()
    };

    let mut payload = json!({
        "model": if model_name.is_empty() { "qwen-plus" } else { model_name },
        "messages": [
            {
                "role": "system",
                "content": "你是专业视频本地化翻译。保持原意，翻译要自然口语化，适合配音朗读。请直接返回符合指定结构的 JSON，不要有任何 Markdown 标记或其它解释性文字。"
            },
            {
                "role": "user",
                "content": build_translation_prompt(&request)
            }
        ],
        "temperature": 0.2
    });

    if !is_volc_ark {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert(
                "response_format".to_string(),
                json!({ "type": "json_object" }),
            );
        }
    }

    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .map_err(http_error)?;
    let status = response.status();
    let response_text = response.text().map_err(http_error)?;

    if !status.is_success() {
        return Err(TranslationError::Api(format!(
            "HTTP {status}: {}",
            truncate_for_error(&response_text)
        )));
    }

    let response: Value = serde_json::from_str(&response_text).map_err(|error| {
        TranslationError::Api(format!(
            "响应不是 JSON：{error}；原始响应：{}",
            truncate_for_error(&response_text)
        ))
    })?;

    let content = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| TranslationError::Api(format!("未返回 message.content：{response}")))?;

    let cleaned = clean_json_content(content);
    let content_json: Value = serde_json::from_str(cleaned).map_err(|error| {
        TranslationError::Api(format!("JSON解析失败: {error}; 原始文本: {content}"))
    })?;

    Ok(content_json)
}

fn build_volc_speech_mt_payload(request: &TranslationRequest) -> Value {
    let mut payload = json!({
        "target_language": request.transcript.target_language.as_volc_speech_mt_language(),
        "text_list": request
            .transcript
            .segments
            .iter()
            .map(|segment| segment.text.clone())
            .collect::<Vec<_>>(),
    });

    if let Some(source_language) = request
        .transcript
        .source_language
        .as_volc_speech_mt_language()
    {
        if let Some(object) = payload.as_object_mut() {
            object.insert("source_language".to_string(), json!(source_language));
        }
    }

    payload
}

fn request_volc_speech_mt_batch(
    client: &Client,
    api_key: &str,
    request: &TranslationRequest,
) -> Result<Value, TranslationError> {
    let response = client
        .post(VOLC_SPEECH_MT_URL)
        .header("X-Api-Key", api_key)
        .header("X-Api-Resource-Id", VOLC_SPEECH_MT_RESOURCE_ID)
        .header("X-Api-Request-Id", Uuid::new_v4().to_string())
        .header("Content-Type", "application/json")
        .json(&build_volc_speech_mt_payload(request))
        .send()
        .map_err(http_error)?;
    let status = response.status();
    let response_text = response.text().map_err(http_error)?;

    if !status.is_success() {
        return Err(TranslationError::Api(format!(
            "火山机器翻译失败 (HTTP {status})：{}",
            truncate_for_error(&response_text)
        )));
    }

    let response: Value = serde_json::from_str(&response_text).map_err(|error| {
        TranslationError::Api(format!(
            "火山机器翻译响应不是 JSON：{error}；原始响应：{}",
            truncate_for_error(&response_text)
        ))
    })?;

    parse_volc_speech_mt_response(request, &response)
}

fn parse_volc_speech_mt_response(
    request: &TranslationRequest,
    response: &Value,
) -> Result<Value, TranslationError> {
    let code = response
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            TranslationError::Api(format!("火山机器翻译响应缺少业务状态码：{response}"))
        })?;

    if code != VOLC_SPEECH_MT_SUCCESS_CODE {
        let message = response
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(TranslationError::Api(format!(
            "火山机器翻译失败：{code} {message}"
        )));
    }

    let translations = response
        .pointer("/data/translation_list")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            TranslationError::Api(format!("火山机器翻译响应缺少 translation_list：{response}"))
        })?;

    if translations.len() != request.transcript.segments.len() {
        return Err(TranslationError::Api(format!(
            "火山机器翻译结果数量不匹配：请求 {} 段，返回 {} 段。请重新翻译，避免生成错位视频。",
            request.transcript.segments.len(),
            translations.len()
        )));
    }

    let segments = request
        .transcript
        .segments
        .iter()
        .zip(translations)
        .map(|(segment, translation)| {
            let translated_text = translation
                .get("translation")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    TranslationError::Api(format!(
                        "火山机器翻译结果缺少译文，段落 ID：{}。",
                        segment.id
                    ))
                })?;

            Ok(json!({
                "id": segment.id,
                "translated_text": translated_text,
            }))
        })
        .collect::<Result<Vec<_>, TranslationError>>()?;

    Ok(json!({ "segments": segments }))
}

fn http_error(error: reqwest::Error) -> TranslationError {
    TranslationError::Http(describe_reqwest_error(&error))
}

fn describe_reqwest_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();

    while let Some(error) = source {
        let source_message = error.to_string();
        if !message.contains(&source_message) {
            message.push_str("；原因：");
            message.push_str(&source_message);
        }
        source = error.source();
    }

    message
}

fn truncate_for_error(text: &str) -> String {
    const MAX_ERROR_CHARS: usize = 1200;
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_ERROR_CHARS {
        return trimmed.to_string();
    }

    format!(
        "{}...",
        trimmed.chars().take(MAX_ERROR_CHARS).collect::<String>()
    )
}

fn build_translation_prompt(request: &TranslationRequest) -> String {
    let segments: Vec<Value> = request
        .transcript
        .segments
        .iter()
        .map(|segment| {
            json!({
                "id": segment.id,
                "start_ms": segment.start_ms,
                "end_ms": segment.end_ms,
                "speaker_id": segment.speaker_id,
                "text": segment.text
            })
        })
        .collect();

    format!(
        "目标语言：{}。\n请翻译 segments。必须返回恰好 {} 个 segments，每个 id 必须原样返回，不得省略。返回格式：{{\"segments\":[{{\"id\":\"...\",\"translated_text\":\"...\"}}]}}。\nsegments: {}",
        request.transcript.target_language.display_name(),
        segments.len(),
        Value::Array(segments)
    )
}

fn parse_translation_response(
    request: &TranslationRequest,
    response: &Value,
    provider: &str,
) -> TranslationDocument {
    let translations = response
        .get("segments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let segments = request
        .transcript
        .segments
        .iter()
        .map(|segment| {
            let translated_text = translations
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(segment.id.as_str()))
                .and_then(|item| item.get("translated_text").and_then(Value::as_str))
                .unwrap_or("")
                .trim()
                .to_string();

            TranslationSegment {
                id: segment.id.clone(),
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                speaker_id: segment.speaker_id.clone(),
                source_text: segment.text.clone(),
                translated_text,
            }
        })
        .collect();

    TranslationDocument {
        source_language: serde_json::to_value(&request.transcript.source_language)
            .ok()
            .and_then(|v| v.as_str().map(ToString::to_string))
            .unwrap_or_else(|| "auto".to_string()),
        target_language: request.transcript.target_language.clone(),
        provider: provider.to_string(),
        segments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr::{AsrProviderId, SourceLanguageCode, TargetLanguageCode, TranscriptSegment};

    fn volc_speech_request(
        source_language: SourceLanguageCode,
        texts: &[&str],
    ) -> TranslationRequest {
        TranslationRequest {
            transcript: TranscriptDocument {
                source_language,
                target_language: TargetLanguageCode::ZhHansCn,
                provider: AsrProviderId::VolcDoubao,
                segments: texts
                    .iter()
                    .enumerate()
                    .map(|(index, text)| TranscriptSegment {
                        id: format!("seg_{index}"),
                        start_ms: index as u64 * 1000,
                        end_ms: (index as u64 + 1) * 1000,
                        speaker_id: None,
                        text: (*text).to_string(),
                        confidence: None,
                    })
                    .collect(),
            },
            provider: "volc_speech_mt".to_string(),
            model: "volc-speech-mt".to_string(),
            deployment: BailianDeployment::ChinaMainland,
            local_endpoint: None,
        }
    }

    #[test]
    fn volc_speech_mt_uses_speech_credential_and_batch_limit() {
        let backend = TranslationBackend::from_provider("volc_speech_mt");

        assert_eq!(backend, TranslationBackend::VolcSpeechMt);
        assert_eq!(backend.credential_provider(), AsrProviderId::VolcDoubao);
        assert_eq!(backend.batch_size(), 16);
    }

    #[test]
    fn llm_translation_uses_smaller_batches_for_longer_merged_segments() {
        assert_eq!(TranslationBackend::AliyunQwen.batch_size(), 8);
        assert_eq!(TranslationBackend::VolcArk.batch_size(), 8);
    }

    #[test]
    fn transcript_fragments_are_merged_into_sentence_before_translation() {
        let request = volc_speech_request(
            SourceLanguageCode::EnUs,
            &[
                "Anthropic released Opus 4.",
                "8, which they say is advanced.",
                "Next sentence.",
            ],
        );

        let merged = merge_transcript_segments(&request.transcript.segments);

        assert_eq!(merged.len(), 2);
        assert_eq!(
            merged[0].text,
            "Anthropic released Opus 4.8, which they say is advanced."
        );
        assert_eq!(merged[0].start_ms, 0);
        assert_eq!(merged[0].end_ms, 2_000);
        assert_eq!(merged[1].text, "Next sentence.");
    }

    #[test]
    fn transcript_fragments_are_not_merged_across_long_pause() {
        let mut request =
            volc_speech_request(SourceLanguageCode::EnUs, &["First half", "continues here."]);
        request.transcript.segments[1].start_ms = 2_000;
        request.transcript.segments[1].end_ms = 3_000;

        let merged = merge_transcript_segments(&request.transcript.segments);

        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn volc_speech_mt_payload_uses_language_codes_and_text_list() {
        let request = volc_speech_request(SourceLanguageCode::EnUs, &["Hello", "World"]);

        assert_eq!(
            build_volc_speech_mt_payload(&request),
            json!({
                "source_language": "en",
                "target_language": "zh",
                "text_list": ["Hello", "World"],
            })
        );
    }

    #[test]
    fn volc_speech_mt_payload_omits_auto_source_language() {
        let request = volc_speech_request(SourceLanguageCode::Auto, &["Hello"]);
        let payload = build_volc_speech_mt_payload(&request);

        assert_eq!(payload.get("source_language"), None);
        assert_eq!(payload["target_language"], "zh");
    }

    #[test]
    fn volc_speech_mt_response_maps_translations_by_order() {
        let request = volc_speech_request(SourceLanguageCode::EnUs, &["Hello", "World"]);
        let response = json!({
            "code": 20000000,
            "message": "ok",
            "data": {
                "translation_list": [
                    { "translation": "你好" },
                    { "translation": "世界" },
                ]
            }
        });

        let response = parse_volc_speech_mt_response(&request, &response).unwrap();
        let document = parse_translation_response(&request, &response, "volc_speech_mt");

        assert_eq!(document.segments[0].id, "seg_0");
        assert_eq!(document.segments[0].translated_text, "你好");
        assert_eq!(document.segments[1].id, "seg_1");
        assert_eq!(document.segments[1].translated_text, "世界");
    }

    #[test]
    fn volc_speech_mt_response_rejects_mismatched_translation_count() {
        let request = volc_speech_request(SourceLanguageCode::EnUs, &["Hello", "World"]);
        let response = json!({
            "code": 20000000,
            "message": "ok",
            "data": {
                "translation_list": [{ "translation": "你好" }]
            }
        });

        let error = parse_volc_speech_mt_response(&request, &response)
            .expect_err("mismatched response count should fail");

        assert!(error.to_string().contains("请求 2 段，返回 1 段"));
    }

    #[test]
    fn volc_speech_mt_response_rejects_business_error() {
        let request = volc_speech_request(SourceLanguageCode::EnUs, &["Hello"]);
        let response = json!({
            "code": 45000001,
            "message": "target_language is required"
        });

        let error = parse_volc_speech_mt_response(&request, &response)
            .expect_err("business error should fail");

        assert!(error
            .to_string()
            .contains("45000001 target_language is required"));
    }

    #[test]
    fn parser_maps_translated_text_by_segment_id() {
        let request = TranslationRequest {
            transcript: TranscriptDocument {
                source_language: SourceLanguageCode::EnUs,
                target_language: TargetLanguageCode::ZhHansCn,
                provider: AsrProviderId::AliyunBailian,
                segments: vec![TranscriptSegment {
                    id: "seg_1".to_string(),
                    start_ms: 0,
                    end_ms: 1000,
                    speaker_id: None,
                    text: "Hello world".to_string(),
                    confidence: None,
                }],
            },
            provider: "aliyun_qwen".to_string(),
            model: "qwen-plus".to_string(),
            deployment: BailianDeployment::ChinaMainland,
            local_endpoint: None,
        };
        let response = json!({
            "segments": [{
                "id": "seg_1",
                "translated_text": "你好，世界"
            }]
        });

        let document = parse_translation_response(&request, &response, "aliyun_qwen");

        assert_eq!(document.segments[0].translated_text, "你好，世界");
        assert_eq!(document.segments[0].source_text, "Hello world");
    }

    #[test]
    fn retry_merge_fills_only_missing_translation_segments() {
        let request = volc_speech_request(SourceLanguageCode::EnUs, &["Hello", "World"]);
        let mut document = parse_translation_response(
            &request,
            &json!({
                "segments": [{
                    "id": "seg_0",
                    "translated_text": "你好"
                }]
            }),
            "aliyun_qwen",
        );

        let missing = missing_transcript_segments(&request, &document);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, "seg_1");

        let retry_request = translation_request_with_segments(&request, missing);
        let retry_document = parse_translation_response(
            &retry_request,
            &json!({
                "segments": [{
                    "id": "seg_1",
                    "translated_text": "世界"
                }]
            }),
            "aliyun_qwen",
        );
        merge_translation_segments(&mut document, retry_document);

        ensure_translation_complete(&document).unwrap();
        assert_eq!(document.segments[0].translated_text, "你好");
        assert_eq!(document.segments[1].translated_text, "世界");
    }

    #[test]
    fn incomplete_translation_is_rejected() {
        let request = TranslationRequest {
            transcript: TranscriptDocument {
                source_language: SourceLanguageCode::EnUs,
                target_language: TargetLanguageCode::ZhHansCn,
                provider: AsrProviderId::AliyunBailian,
                segments: vec![
                    TranscriptSegment {
                        id: "seg_1".to_string(),
                        start_ms: 0,
                        end_ms: 1000,
                        speaker_id: None,
                        text: "Hello".to_string(),
                        confidence: None,
                    },
                    TranscriptSegment {
                        id: "seg_2".to_string(),
                        start_ms: 1000,
                        end_ms: 2000,
                        speaker_id: None,
                        text: "World".to_string(),
                        confidence: None,
                    },
                ],
            },
            provider: "aliyun_qwen".to_string(),
            model: "qwen-plus".to_string(),
            deployment: BailianDeployment::ChinaMainland,
            local_endpoint: None,
        };
        let response = json!({
            "segments": [{
                "id": "seg_1",
                "translated_text": "你好"
            }]
        });

        let document = parse_translation_response(&request, &response, "aliyun_qwen");
        let error =
            ensure_translation_complete(&document).expect_err("missing segment should fail");

        assert!(error.to_string().contains("seg_2"));
    }
}
