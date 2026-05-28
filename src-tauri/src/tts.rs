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
    pub original_video_path: Option<String>,
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

    let mut voice = if request.voice.trim().is_empty() {
        "longxiaochun_v3".to_string()
    } else {
        request.voice.trim().to_string()
    };

    let model = if request.model.trim() == "cosyvoice-v3-clone" {
        // Zero-shot voice cloning
        let video_path = request.original_video_path.as_deref().ok_or_else(|| {
            TtsError::Api("进行声音克隆时必须提供原视频路径。".to_string())
        })?;

        // 1. Extract 15s human voice slice
        let temp_slice = extract_slice_to_temp(video_path)
            .map_err(|e| TtsError::Api(format!("提取克隆音源切片失败：{e}")))?;

        // 2. Upload to DashScope OSS & enroll
        let upload_result = (|| -> Result<String, TtsError> {
            let policy = crate::asr::get_dashscope_upload_policy(
                &client,
                &api_key,
                "cosyvoice-v3-flash",
            ).map_err(|e| TtsError::Api(format!("获取上传凭据失败：{e}")))?;

            let oss_url = crate::asr::upload_file_to_dashscope_oss(
                &client,
                &policy,
                &temp_slice,
            ).map_err(|e| TtsError::Api(format!("上传克隆音频失败：{e}")))?;

            enroll_voice(&client, &api_key, &oss_url)
        })();

        // Clean up temp slice
        let _ = std::fs::remove_file(&temp_slice);

        voice = upload_result?;

        "cosyvoice-v3-flash".to_string()
    } else if request.model.trim().is_empty() {
        "cosyvoice-v3-flash".to_string()
    } else {
        request.model.trim().to_string()
    };

    let mut segments = Vec::new();
    for (index, segment) in request.translation.segments.iter().enumerate() {
        let text = segment.translated_text.trim();

        // Skip segments with no translated text (e.g. music-only / silent sections).
        // Sending empty text to the API causes a 400 InvalidParameter error.
        if text.is_empty() {
            eprintln!("[TTS] 跳过空文本段 {} ({})", index, segment.id);
            continue;
        }

        let audio_url = synthesize_segment(
            &client,
            tts_url,
            &api_key,
            &model,
            &voice,
            request.rate,
            request.pitch,
            request.sample_rate,
            text,
        )?;
        let audio_path =
            output_dir.join(format!("{index:04}_{}.wav", sanitize_file_id(&segment.id)));

        // Robust download with HTTP -> HTTPS replacement and retries
        let download_url = if audio_url.starts_with("http://") {
            audio_url.replacen("http://", "https://", 1)
        } else {
            audio_url.clone()
        };

        let mut audio_bytes = None;
        let mut last_err = None;
        for attempt in 1..=5 {
            match client.get(&download_url).send() {
                Ok(resp) => {
                    match resp.error_for_status() {
                        Ok(success_resp) => {
                            match success_resp.bytes() {
                                Ok(bytes) => {
                                    audio_bytes = Some(bytes);
                                    break;
                                }
                                Err(e) => last_err = Some(TtsError::Http(e)),
                            }
                        }
                        Err(e) => {
                            last_err = Some(TtsError::Http(e));
                        }
                    }
                }
                Err(e) => {
                    last_err = Some(TtsError::Http(e));
                }
            }
            eprintln!("[TTS] 下载音频文件第 {} 次尝试失败，正在重试...", attempt);
            std::thread::sleep(Duration::from_millis(1000 * attempt));
        }

        let audio_bytes = match audio_bytes {
            Some(bytes) => bytes,
            None => {
                let err = last_err.unwrap_or_else(|| TtsError::Api("下载音频失败，重试次数超限".to_string()));
                return Err(err);
            }
        };

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


fn extract_slice_to_temp(input_video_path: &str) -> Result<std::path::PathBuf, String> {
    let input_path = std::path::Path::new(input_video_path);
    if !input_path.exists() {
        return Err("输入视频文件不存在。".to_string());
    }

    let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
    if dir.ends_with("src-tauri") {
        dir.pop();
    }
    let temp_dir = dir.join("exports").join("temp_audio");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let output_audio_path = temp_dir.join(format!(
        "temp_clone_{}.mp3",
        uuid::Uuid::new_v4()
    ));

    let mut cmd = std::process::Command::new(crate::export::ffmpeg_path());
    cmd.arg("-y")
       .arg("-ss")
       .arg("5")
       .arg("-i")
       .arg(input_video_path)
       .arg("-t")
       .arg("15")
       .arg("-vn")
       .arg("-c:a")
       .arg("libmp3lame")
       .arg("-ar")
       .arg("16000")
       .arg("-ac")
       .arg("1")
       .arg("-b:a")
       .arg("64k")
       .arg(&output_audio_path);

    let output = cmd.output().map_err(|_| "找不到 ffmpeg。请先安装 FFmpeg。".to_string())?;
    if !output.status.success() {
        let mut fallback_cmd = std::process::Command::new(crate::export::ffmpeg_path());
        fallback_cmd.arg("-y")
                    .arg("-i")
                    .arg(input_video_path)
                    .arg("-t")
                    .arg("15")
                    .arg("-vn")
                    .arg("-c:a")
                    .arg("libmp3lame")
                    .arg("-ar")
                    .arg("16000")
                    .arg("-ac")
                    .arg("1")
                    .arg("-b:a")
                    .arg("64k")
                    .arg(&output_audio_path);
        let fallback_output = fallback_cmd.output().map_err(|_| "找不到 ffmpeg。".to_string())?;
        if !fallback_output.status.success() {
            let err_msg = String::from_utf8_lossy(&fallback_output.stderr).to_string();
            return Err(format!("克隆音源提取失败：{err_msg}"));
        }
    }

    Ok(output_audio_path)
}

fn enroll_voice(
    client: &Client,
    api_key: &str,
    oss_url: &str,
) -> Result<String, TtsError> {
    let url = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
    let payload = json!({
        "model": "voice-enrollment",
        "input": {
            "action": "create_voice",
            "target_model": "cosyvoice-v3-flash",
            "prefix": "cloned",
            "url": oss_url
        }
    });

    let response = client
        .post(url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .header("X-DashScope-OssResourceResolve", "enable")
        .json(&payload)
        .send()?;

    if !response.status().is_success() {
        let status = response.status();
        let err_text = response.text().unwrap_or_default();
        return Err(TtsError::Api(format!("百炼声纹注册失败 (HTTP {}): {}", status, err_text)));
    }

    let response_json = response.json::<Value>()?;

    response_json
        .pointer("/output/voice_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| TtsError::Api(format!("声音复刻创建失败，未返回 voice_id：{response_json}")))
}

fn synthesize_segment(
    client: &Client,
    tts_url: &str,
    api_key: &str,
    model: &str,
    voice: &str,
    rate: f32,
    pitch: f32,
    sample_rate: u32,
    text: &str,
) -> Result<String, TtsError> {
    let payload = json!({
        "model": model,
        "input": {
            "text": text
        },
        "parameters": {
            "voice": voice,
            "format": "wav",
            "sample_rate": sample_rate,
            "rate": rate,
            "pitch": pitch
        }
    });

    let response = client
        .post(tts_url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()?;

    if !response.status().is_success() {
        let status = response.status();
        let err_text = response.text().unwrap_or_default();
        return Err(TtsError::Api(format!("百炼语音合成失败 (HTTP {}): {}", status, err_text)));
    }

    let response_json = response.json::<Value>()?;

    extract_audio_url(&response_json)
        .map(ToString::to_string)
        .ok_or_else(|| TtsError::Api(format!("未返回音频 URL：{response_json}")))
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
