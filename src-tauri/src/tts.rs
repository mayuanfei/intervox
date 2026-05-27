use crate::asr::{AsrProviderId, BailianDeployment, TargetLanguageCode};
use crate::credentials::{CredentialError, CredentialStore};
use crate::translation::TranslationDocument;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TtsRequest {
    pub translation: TranslationDocument,
    pub model: String,
    pub voice: String,
    pub deployment: BailianDeployment,
    pub output_dir: Option<String>,
    pub rate: f32,
    pub pitch: f32,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TtsDocument {
    pub target_language: TargetLanguageCode,
    pub provider: String,
    pub model: String,
    pub voice: String,
    pub segments: Vec<TtsSegment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TtsSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: Option<String>,
    pub text: String,
    pub audio_url: String,
    pub audio_path: String,
}

#[derive(Debug, Error)]
pub enum TtsError {
    #[error("没有可配音的翻译内容。")]
    EmptyTranslation,
    #[error("翻译结果不完整，以下分段没有中文内容：{0}。请先重新翻译，避免导出错位视频。")]
    IncompleteTranslation(String),
    #[error("请先保存阿里云百炼 API Key。")]
    MissingCredential,
    #[error("CosyVoice 非实时语音合成当前仅支持中国内地（北京）部署。")]
    UnsupportedDeployment,
    #[error("百炼 TTS 请求失败：{0}")]
    Http(#[from] reqwest::Error),
    #[error("百炼 TTS 返回异常：{0}")]
    Api(String),
    #[error("写入配音文件失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("凭据错误：{0}")]
    Credential(#[from] CredentialError),
}

pub fn synthesize(
    request: TtsRequest,
    credentials: &CredentialStore,
) -> Result<TtsDocument, TtsError> {
    if request.translation.segments.is_empty() {
        return Err(TtsError::EmptyTranslation);
    }
    ensure_translation_has_text(&request.translation)?;

    let api_key = credentials
        .get(AsrProviderId::AliyunBailian)?
        .ok_or(TtsError::MissingCredential)?;
    let tts_url = request
        .deployment
        .cosyvoice_tts_url()
        .ok_or(TtsError::UnsupportedDeployment)?;
    let output_dir = resolve_output_dir(request.output_dir.as_deref())?;
    fs::create_dir_all(&output_dir)?;

    let client = Client::builder().timeout(Duration::from_secs(90)).build()?;
    let model = if request.model.trim().is_empty() {
        "cosyvoice-v3-flash".to_string()
    } else {
        request.model.trim().to_string()
    };
    let voice = if request.voice.trim().is_empty() {
        "longxiaochun_v3".to_string()
    } else {
        request.voice.trim().to_string()
    };

    let mut segments = Vec::new();
    for (index, segment) in request.translation.segments.iter().enumerate() {
        let text = segment.translated_text.trim();

        let audio_url = synthesize_segment(
            &client,
            tts_url,
            &api_key,
            &model,
            &voice,
            request
                .translation
                .target_language
                .cosyvoice_language_hint(),
            request.rate,
            request.pitch,
            request.sample_rate,
            text,
        )?;
        let audio_path =
            output_dir.join(format!("{index:04}_{}.wav", sanitize_file_id(&segment.id)));
        let audio_bytes = client.get(&audio_url).send()?.error_for_status()?.bytes()?;
        fs::write(&audio_path, audio_bytes.as_ref())?;

        segments.push(TtsSegment {
            id: segment.id.clone(),
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id.clone(),
            text: text.to_string(),
            audio_url,
            audio_path: audio_path.to_string_lossy().to_string(),
        });
    }

    if segments.is_empty() {
        return Err(TtsError::EmptyTranslation);
    }

    Ok(TtsDocument {
        target_language: request.translation.target_language,
        provider: "aliyun_cosyvoice".to_string(),
        model,
        voice,
        segments,
    })
}

fn ensure_translation_has_text(translation: &TranslationDocument) -> Result<(), TtsError> {
    let missing_ids: Vec<&str> = translation
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

    Err(TtsError::IncompleteTranslation(format!(
        "{preview}{suffix}（共 {}/{} 段）",
        missing_ids.len(),
        translation.segments.len()
    )))
}

fn synthesize_segment(
    client: &Client,
    tts_url: &str,
    api_key: &str,
    model: &str,
    voice: &str,
    language_hint: &str,
    rate: f32,
    pitch: f32,
    sample_rate: u32,
    text: &str,
) -> Result<String, TtsError> {
    let payload = json!({
        "model": model,
        "input": {
            "text": text,
            "voice": voice,
            "format": "wav",
            "sample_rate": sample_rate,
            "rate": rate,
            "pitch": pitch,
            "language_hints": [language_hint]
        }
    });

    let response = client
        .post(tts_url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()?
        .error_for_status()?
        .json::<Value>()?;

    extract_audio_url(&response)
        .map(ToString::to_string)
        .ok_or_else(|| TtsError::Api(format!("未返回音频 URL：{response}")))
}

fn resolve_output_dir(output_dir: Option<&str>) -> Result<PathBuf, std::io::Error> {
    if let Some(path) = output_dir.map(str::trim).filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    let mut dir = std::env::current_dir()?;
    if dir.ends_with("src-tauri") {
        dir.pop();
    }

    Ok(dir
        .join("exports")
        .join(format!("tts_{}", Uuid::new_v4())))
}

fn sanitize_file_id(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn extract_audio_url(response: &Value) -> Option<&str> {
    response
        .pointer("/output/audio/url")
        .and_then(Value::as_str)
        .or_else(|| {
            response
                .pointer("/output/audio_url")
                .and_then(Value::as_str)
        })
        .or_else(|| response.pointer("/output/url").and_then(Value::as_str))
        .or_else(|| {
            response
                .pointer("/output/results/0/url")
                .and_then(Value::as_str)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_audio_url_from_qwen_tts_shape() {
        let response = json!({
            "output": {
                "audio": {
                    "url": "https://example.com/audio.wav"
                }
            }
        });

        assert_eq!(
            extract_audio_url(&response),
            Some("https://example.com/audio.wav")
        );
    }

    #[test]
    fn sanitizes_segment_id_for_filename() {
        assert_eq!(sanitize_file_id("seg/1:2"), "seg_1_2");
    }

    #[test]
    fn rejects_incomplete_translation_before_tts() {
        let translation = TranslationDocument {
            source_language: "EnUs".to_string(),
            target_language: TargetLanguageCode::ZhHansCn,
            provider: "aliyun_qwen".to_string(),
            segments: vec![crate::translation::TranslationSegment {
                id: "seg_1".to_string(),
                start_ms: 0,
                end_ms: 1000,
                speaker_id: None,
                source_text: "Hello".to_string(),
                translated_text: " ".to_string(),
            }],
        };

        let error = ensure_translation_has_text(&translation).expect_err("empty text should fail");

        assert!(error.to_string().contains("seg_1"));
    }
}
