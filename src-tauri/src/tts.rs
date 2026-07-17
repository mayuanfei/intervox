use crate::asr::{AsrProviderId, BailianDeployment, TargetLanguageCode};
use crate::credentials::{CredentialError, CredentialStore};
use crate::translation::TranslationDocument;
use base64::Engine as _;
use reqwest::blocking::multipart::{Form, Part};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_VOLC_TTS_VOICE: &str = "zh_female_vv_uranus_bigtts";
const DEFAULT_OMNIVOICE_ENDPOINT: &str = "http://127.0.0.1:3900";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TtsRequest {
    pub translation: TranslationDocument,
    pub provider: String,
    pub model: String,
    pub voice: String,
    pub deployment: BailianDeployment,
    pub output_dir: Option<String>,
    pub rate: f32,
    pub pitch: f32,
    pub sample_rate: u32,
    pub original_video_path: Option<String>,
    pub app_id: Option<String>,
    pub tts_resource_id: Option<String>,
    pub tts_endpoint: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
pub struct TtsProgress {
    pub stage: String,
    pub completed_segments: usize,
    pub total_segments: usize,
    pub progress: f32,
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
    #[error("{0}")]
    Api(String),
    #[error("写入配音文件失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("凭据错误：{0}")]
    Credential(#[from] CredentialError),
}

#[allow(dead_code)]
pub fn synthesize(
    request: TtsRequest,
    credentials: &CredentialStore,
) -> Result<TtsDocument, TtsError> {
    synthesize_with_progress(request, credentials, |_| {})
}

pub fn synthesize_with_progress<F>(
    request: TtsRequest,
    credentials: &CredentialStore,
    mut on_progress: F,
) -> Result<TtsDocument, TtsError>
where
    F: FnMut(TtsProgress),
{
    if request.translation.segments.is_empty() {
        return Err(TtsError::EmptyTranslation);
    }

    let total_segments = request
        .translation
        .segments
        .iter()
        .filter(|segment| !segment.translated_text.trim().is_empty())
        .count();
    report_tts_progress(&mut on_progress, "started", 0, total_segments);

    let provider = request.provider.trim();

    // Route to local TTS if specified
    if provider == "local_tts" {
        return synthesize_local_tts(request, &mut on_progress, total_segments);
    }

    // Route to Volcengine Doubao if the model or provider matches
    if provider == "volc_doubao" || is_volc_model(request.model.trim()) {
        return synthesize_volc(request, credentials, &mut on_progress, total_segments);
    }

    // --- Existing Aliyun path (unchanged) ---

    let api_key = credentials
        .get(AsrProviderId::AliyunBailian)?
        .ok_or(TtsError::MissingCredential)?;
    let tts_url = request
        .deployment
        .cosyvoice_tts_url()
        .ok_or(TtsError::UnsupportedDeployment)?;
    let output_dir = resolve_output_dir(request.output_dir.as_deref(), &tts_cache_key(&request))?;
    fs::create_dir_all(&output_dir)?;

    let client = Client::builder().timeout(Duration::from_secs(90)).build()?;

    let mut voice = if request.voice.trim().is_empty() {
        "longxiaochun_v3".to_string()
    } else {
        request.voice.trim().to_string()
    };

    let model = if request.model.trim() == "cosyvoice-v3-clone" {
        // Zero-shot voice cloning
        let video_path = request
            .original_video_path
            .as_deref()
            .ok_or_else(|| TtsError::Api("进行声音克隆时必须提供原视频路径。".to_string()))?;

        // 1. Extract 15s human voice slice
        let temp_slice = extract_slice_to_temp(video_path, request.output_dir.as_deref())
            .map_err(|e| TtsError::Api(format!("提取克隆音源切片失败：{e}")))?;

        // 2. Upload to DashScope OSS & enroll
        let upload_result = (|| -> Result<String, TtsError> {
            let policy =
                crate::asr::get_dashscope_upload_policy(&client, &api_key, "cosyvoice-v3-flash")
                    .map_err(|e| TtsError::Api(format!("获取上传凭据失败：{e}")))?;

            let oss_url = crate::asr::upload_file_to_dashscope_oss(&client, &policy, &temp_slice)
                .map_err(|e| TtsError::Api(format!("上传克隆音频失败：{e}")))?;

            enroll_voice(&client, &api_key, &oss_url)
        })();

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

        let audio_path =
            output_dir.join(format!("{index:04}_{}.wav", sanitize_file_id(&segment.id)));
        let audio_url = if has_reusable_audio_file(&audio_path) {
            eprintln!("[TTS] 复用已生成音频段 {} ({})", index, segment.id);
            String::new()
        } else {
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
                    Ok(resp) => match resp.error_for_status() {
                        Ok(success_resp) => match success_resp.bytes() {
                            Ok(bytes) => {
                                audio_bytes = Some(bytes);
                                break;
                            }
                            Err(e) => last_err = Some(TtsError::Http(e)),
                        },
                        Err(e) => {
                            last_err = Some(TtsError::Http(e));
                        }
                    },
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
                    let err = last_err
                        .unwrap_or_else(|| TtsError::Api("下载音频失败，重试次数超限".to_string()));
                    return Err(err);
                }
            };

            fs::write(&audio_path, audio_bytes.as_ref())?;
            audio_url
        };

        segments.push(TtsSegment {
            id: segment.id.clone(),
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id.clone(),
            text: text.to_string(),
            audio_url,
            audio_path: audio_path.to_string_lossy().to_string(),
        });
        report_tts_progress(
            &mut on_progress,
            "segment_completed",
            segments.len(),
            total_segments,
        );
    }

    if segments.is_empty() {
        return Err(TtsError::EmptyTranslation);
    }

    report_tts_progress(
        &mut on_progress,
        "completed",
        segments.len(),
        total_segments,
    );

    Ok(TtsDocument {
        target_language: request.translation.target_language,
        provider: "aliyun_cosyvoice".to_string(),
        model,
        voice,
        segments,
    })
}

fn synthesize_volc<F>(
    request: TtsRequest,
    credentials: &CredentialStore,
    on_progress: &mut F,
    total_segments: usize,
) -> Result<TtsDocument, TtsError>
where
    F: FnMut(TtsProgress),
{
    let api_key = credentials
        .get(AsrProviderId::VolcDoubao)?
        .or(credentials.get(AsrProviderId::VolcArk)?)
        .ok_or(TtsError::MissingCredential)?;

    let app_id = request.app_id.clone().unwrap_or_default();
    if app_id.trim().is_empty() {
        return Err(TtsError::Api(
            "请先在设置中填入火山引擎 App ID。".to_string(),
        ));
    }

    let output_dir = resolve_output_dir(request.output_dir.as_deref(), &tts_cache_key(&request))?;
    fs::create_dir_all(&output_dir)?;

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;

    let model_name = request.model.trim().to_string();
    let is_clone = model_name.contains("icl") || model_name.contains("clone");

    let voice_type = if is_clone {
        let clone_resource_id = normalize_volc_tts_resource_id(
            request.tts_resource_id.as_deref(),
            default_volc_tts_resource_id(true, ""),
        );
        // Voice cloning path
        let video_path = request.original_video_path.as_deref().ok_or_else(|| {
            TtsError::Api("进行火山引擎声音克隆时必须提供原视频路径。".to_string())
        })?;

        let temp_slice = extract_slice_to_temp(video_path, request.output_dir.as_deref())
            .map_err(|e| TtsError::Api(format!("提取克隆音源切片失败：{e}")))?;

        enroll_volc_voice(&client, &api_key, &app_id, &clone_resource_id, &temp_slice)?
    } else {
        // Standard synthesis: use the voice preset or default
        let voice_type = normalize_volc_tts_voice(&request.voice);
        if voice_type != request.voice.trim() {
            eprintln!(
                "[TTS-Volc] 音色 {} 不适用于 Seed-TTS 2.0，回退为 {}",
                request.voice.trim(),
                voice_type
            );
        }
        voice_type.to_string()
    };

    let default_resource_id = default_volc_tts_resource_id(is_clone, &voice_type);
    let resource_id =
        normalize_volc_tts_resource_id(request.tts_resource_id.as_deref(), default_resource_id);

    let mut segments = Vec::new();
    for (index, segment) in request.translation.segments.iter().enumerate() {
        let text = segment.translated_text.trim();
        if text.is_empty() {
            eprintln!("[TTS-Volc] 跳过空文本段 {} ({})", index, segment.id);
            continue;
        }

        let audio_path =
            output_dir.join(format!("{index:04}_{}.wav", sanitize_file_id(&segment.id)));

        if has_reusable_audio_file(&audio_path) {
            eprintln!("[TTS-Volc] 复用已生成音频段 {} ({})", index, segment.id);
        } else {
            synthesize_volc_segment(
                &client,
                &api_key,
                &app_id,
                &resource_id,
                &voice_type,
                text,
                &audio_path,
            )?;
        }

        segments.push(TtsSegment {
            id: segment.id.clone(),
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id.clone(),
            text: text.to_string(),
            audio_url: String::new(),
            audio_path: audio_path.to_string_lossy().to_string(),
        });
        report_tts_progress(
            on_progress,
            "segment_completed",
            segments.len(),
            total_segments,
        );
    }

    if segments.is_empty() {
        return Err(TtsError::EmptyTranslation);
    }

    report_tts_progress(on_progress, "completed", segments.len(), total_segments);

    Ok(TtsDocument {
        target_language: request.translation.target_language,
        provider: "volc_doubao".to_string(),
        model: model_name,
        voice: voice_type,
        segments,
    })
}

fn synthesize_local_tts<F>(
    request: TtsRequest,
    on_progress: &mut F,
    total_segments: usize,
) -> Result<TtsDocument, TtsError>
where
    F: FnMut(TtsProgress),
{
    let output_dir = resolve_output_dir(
        request.output_dir.as_deref(),
        &local_tts_cache_key(&request),
    )?;
    fs::create_dir_all(&output_dir)?;

    let endpoint = omnivoice_generate_url(request.tts_endpoint.as_deref());
    let client = Client::builder()
        .timeout(Duration::from_secs(900))
        .build()?;

    let mut ref_text: Option<String> = None;
    let mut clone_reference = None;
    if request.original_video_path.is_some() {
        // 1. Try to load subtitle file for original_video_path
        let mut parsed_ref_srt = Vec::new();
        if let Some(video_path) = request.original_video_path.as_deref() {
            let video_path_obj = std::path::Path::new(video_path);
            let candidates = vec![
                video_path_obj.with_extension("en.srt"),
                video_path_obj.with_extension("srt"),
                std::path::PathBuf::from(format!("{video_path}.en.srt")),
                std::path::PathBuf::from(format!("{video_path}.srt")),
            ];
            for cand in candidates {
                if cand.exists() && cand.is_file() {
                    parsed_ref_srt = parse_srt_file(&cand);
                    if !parsed_ref_srt.is_empty() {
                        break;
                    }
                }
            }
        }

        // 2. Select the best segment times & text
        let mut min_start = 0;
        let mut max_end = 0;
        let mut resolved_text = String::new();

        if !parsed_ref_srt.is_empty() {
            // Find the best scoring segment inside the reference video's own SRT!
            let mut best_score = -999;
            let mut best_ref_seg = None;
            for seg in &parsed_ref_srt {
                let temp_seg = crate::translation::TranslationSegment {
                    id: String::new(),
                    start_ms: seg.start_ms,
                    end_ms: seg.end_ms,
                    speaker_id: None,
                    source_text: seg.text.clone(),
                    translated_text: String::new(),
                };
                let score = score_segment(&temp_seg);
                if score > best_score && score > -500 {
                    best_score = score;
                    best_ref_seg = Some(seg);
                }
            }

            if let Some(seg) = best_ref_seg {
                min_start = seg.start_ms;
                max_end = seg.end_ms;
                let duration_sec = ((max_end.saturating_sub(min_start)) as f32 / 1000.0).max(5.0);
                resolved_text = get_text_for_window(&parsed_ref_srt, min_start, min_start + (duration_sec * 1000.0) as u64);
            }
        }

        // If no reference SRT was found or it was empty, fall back to target translation segments
        if resolved_text.trim().is_empty() {
            let mut best_score = -999;
            let mut best_target_seg = None;
            for segment in &request.translation.segments {
                let score = score_segment(segment);
                if score > best_score && score > -500 {
                    best_score = score;
                    best_target_seg = Some(segment);
                }
            }

            let seg_to_use = if let Some(seg) = best_target_seg {
                Some(seg)
            } else if !request.translation.segments.is_empty() {
                Some(&request.translation.segments[0])
            } else {
                None
            };

            if let Some(seg) = seg_to_use {
                min_start = seg.start_ms;
                max_end = seg.end_ms;
                let duration_sec = ((max_end.saturating_sub(min_start)) as f32 / 1000.0).max(5.0);
                resolved_text = get_text_from_target_segments(&request.translation.segments, min_start, min_start + (duration_sec * 1000.0) as u64);
            }
        }

        // 3. Perform slicing and set ref_text
        if max_end > min_start {
            let start_sec = min_start as f32 / 1000.0;
            let mut duration_sec = (max_end.saturating_sub(min_start)) as f32 / 1000.0;
            if duration_sec < 5.0 {
                duration_sec = 5.0;
            }

            if !resolved_text.trim().is_empty() {
                ref_text = Some(resolved_text.trim().to_string());
            } else {
                ref_text = None;
            }

            clone_reference = Some(
                extract_slice_to_temp_with_bounds(
                    request.original_video_path.as_deref().unwrap_or_default(),
                    request.output_dir.as_deref(),
                    start_sec,
                    duration_sec,
                )
                .map_err(|e| TtsError::Api(format!("提取本地声音克隆音源失败：{e}")))?,
            );
        }
    }
    let engine = local_tts_engine(&request.model);
    let num_step = local_tts_num_step(&request.model);
    let language = omnivoice_language(&request.translation.target_language);
    let voice_instruct = omnivoice_voice_instruct(&request.voice);
    let voice_seed = omnivoice_voice_seed(&request.model, &request.voice, language);

    let mut segments = Vec::new();
    for (index, segment) in request.translation.segments.iter().enumerate() {
        let text = segment.translated_text.trim();
        if text.is_empty() {
            eprintln!("[TTS-Local] 跳过空文本段 {} ({})", index, segment.id);
            continue;
        }

        let audio_path =
            output_dir.join(format!("{index:04}_{}.wav", sanitize_file_id(&segment.id)));

        if has_reusable_audio_file(&audio_path) {
            eprintln!("[TTS-Local] 复用已生成音频段 {} ({})", index, segment.id);
        } else {
            synthesize_omnivoice_segment(
                &client,
                &endpoint,
                &engine,
                num_step,
                language,
                text,
                omnivoice_target_duration(segment.start_ms, segment.end_ms, text),
                clone_reference.as_deref(),
                ref_text.as_deref(),
                voice_instruct,
                voice_seed,
                request.rate,
                &audio_path,
            )?;
        }

        segments.push(TtsSegment {
            id: segment.id.clone(),
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id.clone(),
            text: text.to_string(),
            audio_url: String::new(),
            audio_path: audio_path.to_string_lossy().to_string(),
        });

        report_tts_progress(
            on_progress,
            "segment_completed",
            segments.len(),
            total_segments,
        );
    }

    if segments.is_empty() {
        return Err(TtsError::EmptyTranslation);
    }

    report_tts_progress(on_progress, "completed", segments.len(), total_segments);

    Ok(TtsDocument {
        target_language: request.translation.target_language,
        provider: "local_tts".to_string(),
        model: request.model.clone(),
        voice: request.voice.clone(),
        segments,
    })
}

fn synthesize_omnivoice_segment(
    client: &Client,
    endpoint: &str,
    engine: &str,
    num_step: u32,
    language: &str,
    text: &str,
    duration_seconds: Option<f32>,
    ref_audio_path: Option<&std::path::Path>,
    ref_text: Option<&str>,
    voice_instruct: Option<&str>,
    voice_seed: u32,
    speed: f32,
    output_path: &std::path::Path,
) -> Result<(), TtsError> {
    let mut form = Form::new()
        .text("text", text.to_string())
        .text("language", language.to_string())
        .text("engine", engine.to_string())
        .text("num_step", num_step.to_string())
        .text("effect_preset", "broadcast".to_string())
        .text("seed", voice_seed.to_string())
        .text("speed", normalized_tts_speed(speed).to_string());

    if let Some(duration_seconds) = duration_seconds {
        form = form.text("duration", format!("{duration_seconds:.2}"));
    }

    if let Some(path) = ref_audio_path {
        let bytes = fs::read(path)?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("reference.wav")
            .to_string();
        let part = Part::bytes(bytes)
            .file_name(file_name)
            .mime_str(audio_mime_for_path(path))?;
        form = form.part("ref_audio", part);
    }

    if let Some(ref_text) = ref_text.map(str::trim).filter(|value| !value.is_empty()) {
        form = form.text("ref_text", ref_text.to_string());
    }

    if let Some(instruct) = voice_instruct
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("instruct", instruct.to_string());
    }

    let response = client.post(endpoint).multipart(form).send()?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(TtsError::Api(format!(
            "本地 OmniVoice 语音合成失败 (HTTP {}): {}",
            status,
            summarize_response(&body)
        )));
    }

    let audio_bytes = response.bytes()?;
    if audio_bytes.len() <= 44 {
        return Err(TtsError::Api(
            "本地 OmniVoice 返回了空音频，请检查后端日志。".to_string(),
        ));
    }
    fs::write(output_path, audio_bytes.as_ref())?;
    Ok(())
}

fn omnivoice_target_duration(start_ms: u64, end_ms: u64, text: &str) -> Option<f32> {
    let slot_ms = end_ms.saturating_sub(start_ms);
    let text_chars = text.chars().filter(|ch| !ch.is_whitespace()).count();

    if text_chars < 8 || !(700..=14_000).contains(&slot_ms) {
        return None;
    }

    Some((slot_ms.saturating_sub(120).max(700) as f32) / 1000.0)
}

fn omnivoice_voice_instruct(voice: &str) -> Option<&str> {
    let value = voice.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("default") {
        None
    } else {
        Some(value)
    }
}

fn omnivoice_voice_seed(model: &str, voice: &str, language: &str) -> u32 {
    let mut hasher = DefaultHasher::new();
    "omnivoice-voice-seed-v1".hash(&mut hasher);
    model.trim().hash(&mut hasher);
    voice.trim().hash(&mut hasher);
    language.hash(&mut hasher);
    ((hasher.finish() & 0x7fff_ffff) as u32).max(1)
}

fn omnivoice_generate_url(endpoint: Option<&str>) -> String {
    let base = endpoint
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_OMNIVOICE_ENDPOINT)
        .trim_end_matches('/');
    if base.ends_with("/generate") {
        base.to_string()
    } else {
        format!("{base}/generate")
    }
}

fn local_tts_engine(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return "omnivoice".to_string();
    }
    trimmed
        .split(':')
        .next()
        .unwrap_or("omnivoice")
        .trim()
        .to_lowercase()
}

fn local_tts_num_step(model: &str) -> u32 {
    model
        .trim()
        .split(':')
        .nth(1)
        .and_then(|value| value.trim().parse::<u32>().ok())
        .map(|value| value.clamp(1, 32))
        .unwrap_or(8)
}

fn omnivoice_language(target_language: &TargetLanguageCode) -> &'static str {
    match target_language {
        TargetLanguageCode::ZhHansCn => "Chinese",
        TargetLanguageCode::EnUs => "English",
        TargetLanguageCode::JaJp => "Japanese",
        TargetLanguageCode::KoKr => "Korean",
        TargetLanguageCode::EsEs => "Spanish",
        TargetLanguageCode::FrFr => "French",
        TargetLanguageCode::DeDe => "German",
    }
}

#[allow(dead_code)]
fn reference_text_for_clone(translation: &TranslationDocument) -> Option<String> {
    let window_text = collect_reference_text(
        translation
            .segments
            .iter()
            .filter(|segment| segment.end_ms >= 5_000 && segment.start_ms <= 20_000)
            .map(|segment| segment.source_text.as_str()),
    );
    if window_text.is_some() {
        return window_text;
    }
    let fallback = collect_reference_text(
        translation
            .segments
            .iter()
            .map(|segment| segment.source_text.as_str()),
    );
    if fallback.is_some() {
        return fallback;
    }
    // Safeguard fallback: if no text was found in the translation segments,
    // return a default non-empty placeholder string so that OmniVoice never
    // tries to load/download Whisper on-the-fly and crash.
    Some("voice clone reference audio".to_string())
}

fn collect_reference_text<'a>(texts: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut collected = String::new();
    for text in texts {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !collected.is_empty() {
            collected.push(' ');
        }
        collected.push_str(trimmed);
        if collected.chars().count() >= 280 {
            break;
        }
    }
    let trimmed = collected.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(320).collect())
    }
}

fn normalized_tts_speed(speed: f32) -> f32 {
    if speed.is_finite() {
        speed.clamp(0.5, 2.0)
    } else {
        1.0
    }
}

fn audio_mime_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        _ => "audio/wav",
    }
}

fn report_tts_progress<F>(
    on_progress: &mut F,
    stage: &str,
    completed_segments: usize,
    total_segments: usize,
) where
    F: FnMut(TtsProgress),
{
    let progress = if total_segments == 0 {
        0.0
    } else {
        completed_segments as f32 / total_segments as f32
    };
    on_progress(TtsProgress {
        stage: stage.to_string(),
        completed_segments,
        total_segments,
        progress,
    });
}

fn normalize_volc_tts_voice(voice_type: &str) -> &str {
    match voice_type.trim() {
        "" | "zh_female_common" => DEFAULT_VOLC_TTS_VOICE,
        "zh_female_story" => "zh_female_xiaohe_uranus_bigtts",
        "zh_male_common" => "zh_male_m191_uranus_bigtts",
        voice_type => voice_type,
    }
}

fn default_volc_tts_resource_id(is_clone: bool, voice_type: &str) -> &'static str {
    if is_clone {
        "seed-icl-2.0"
    } else if voice_type.contains("bigtts") {
        "seed-tts-2.0"
    } else {
        "volc.service_type.10029"
    }
}

fn normalize_volc_tts_resource_id(
    custom_resource_id: Option<&str>,
    default_resource_id: &'static str,
) -> String {
    let Some(raw_resource_id) = custom_resource_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return default_resource_id.to_string();
    };

    if let Some(mapped_resource_id) =
        map_volc_console_instance_id(raw_resource_id, default_resource_id)
    {
        eprintln!(
            "[TTS-Volc] 将控制台实例ID {} 映射为 X-Api-Resource-Id {}",
            raw_resource_id, mapped_resource_id
        );
        return mapped_resource_id.to_string();
    }

    raw_resource_id.to_string()
}

fn map_volc_console_instance_id(
    raw_resource_id: &str,
    default_resource_id: &'static str,
) -> Option<&'static str> {
    let normalized: String = raw_resource_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();

    if normalized.starts_with("ttsseedtts2") {
        Some("seed-tts-2.0")
    } else if normalized.starts_with("ttsseedicl2") {
        Some("seed-icl-2.0")
    } else if normalized.starts_with("ttsseedtts1") {
        Some("seed-tts-1.0")
    } else if normalized.starts_with("ttsseedicl1") {
        Some("seed-icl-1.0")
    } else if normalized.starts_with("tts") {
        Some(default_resource_id)
    } else {
        None
    }
}

fn extract_slice_to_temp_with_bounds(
    input_video_path: &str,
    output_dir: Option<&str>,
    start_sec: f32,
    duration_sec: f32,
) -> Result<std::path::PathBuf, String> {
    let input_path = std::path::Path::new(input_video_path);
    if !input_path.exists() {
        return Err("输入视频文件不存在。".to_string());
    }

    let temp_dir = crate::storage::ensure_output_subdir(output_dir, "temp_audio")
        .map_err(|e| e.to_string())?;

    let output_audio_path = temp_dir.join(format!("temp_clone_{}.mp3", uuid::Uuid::new_v4()));

    let mut cmd = crate::process::background_command(crate::export::ffmpeg_path());
    cmd.arg("-y")
        .arg("-ss")
        .arg(start_sec.to_string())
        .arg("-i")
        .arg(input_video_path)
        .arg("-t")
        .arg(duration_sec.to_string())
        .arg("-vn")
        .arg("-filter_complex")
        .arg("silenceremove=start_threshold=-50dB:start_duration=0.1:start_periods=1,adelay=300:all=1")
        .arg("-c:a")
        .arg("libmp3lame")
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg("-b:a")
        .arg("64k")
        .arg(&output_audio_path);

    let output = cmd
        .output()
        .map_err(|_| "找不到 ffmpeg。请先安装 FFmpeg。".to_string())?;
    if !output.status.success() {
        let mut fallback_cmd = crate::process::background_command(crate::export::ffmpeg_path());
        fallback_cmd
            .arg("-y")
            .arg("-i")
            .arg(input_video_path)
            .arg("-t")
            .arg(duration_sec.to_string())
            .arg("-vn")
            .arg("-filter_complex")
            .arg("silenceremove=start_threshold=-50dB:start_duration=0.1:start_periods=1,adelay=300:all=1")
            .arg("-c:a")
            .arg("libmp3lame")
            .arg("-ar")
            .arg("16000")
            .arg("-ac")
            .arg("1")
            .arg("-b:a")
            .arg("64k")
            .arg(&output_audio_path);
        let fallback_output = fallback_cmd
            .output()
            .map_err(|_| "找不到 ffmpeg。".to_string())?;
        if !fallback_output.status.success() {
            let err_msg = String::from_utf8_lossy(&fallback_output.stderr).to_string();
            return Err(format!("克隆音源提取失败：{err_msg}"));
        }
    }

    Ok(output_audio_path)
}

fn extract_slice_to_temp(
    input_video_path: &str,
    output_dir: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    extract_slice_to_temp_with_bounds(input_video_path, output_dir, 5.0, 15.0)
}

fn enroll_voice(client: &Client, api_key: &str, oss_url: &str) -> Result<String, TtsError> {
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
        return Err(TtsError::Api(format!(
            "百炼声纹注册失败 (HTTP {}): {}",
            status, err_text
        )));
    }

    let response_json = response.json::<Value>()?;

    response_json
        .pointer("/output/voice_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            TtsError::Api(format!(
                "声音复刻创建失败，未返回 voice_id：{response_json}"
            ))
        })
}

fn enroll_volc_voice(
    client: &Client,
    api_key: &str,
    app_id: &str,
    resource_id: &str,
    audio_path: &std::path::Path,
) -> Result<String, TtsError> {
    let audio_bytes = fs::read(audio_path)?;
    let audio_b64 = base64::engine::general_purpose::STANDARD.encode(&audio_bytes);
    let ext = audio_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");
    let speaker_id = format!("intervox_clone_{}", Uuid::new_v4());

    let payload = json!({
        "appid": app_id,
        "speaker_id": speaker_id,
        "audios": [{
            "audio_bytes": audio_b64,
            "audio_format": ext
        }],
        "source": 2,
        "model_type": 4
    });

    let response = client
        .post("https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer;{api_key}"))
        .header("Resource-Id", resource_id)
        .json(&payload)
        .send()?;

    if !response.status().is_success() {
        let status = response.status();
        let err_text = response.text().unwrap_or_default();
        let hint = if status.as_u16() == 401 && err_text.contains("requested grant") {
            format!(
                "；当前请求的声音复刻 Resource-Id 为 {resource_id}，请确认火山控制台已开通对应 Seed-ICL/MegaTTS 资源授权，且 App ID 与 API Key 属于同一应用"
            )
        } else {
            String::new()
        };
        return Err(TtsError::Api(format!(
            "火山引擎声音复刻上传失败 (HTTP {}): {}{}",
            status, err_text, hint
        )));
    }

    let _resp_json = response.json::<Value>()?;
    Ok(speaker_id)
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

    let mut last_error = None;
    for attempt in 1..=3 {
        match request_bailian_audio_url(client, tts_url, api_key, &payload) {
            Ok(audio_url) => return Ok(audio_url),
            Err(error) => {
                last_error = Some(error);
                if attempt < 3 {
                    eprintln!("[TTS] 百炼语音合成第 {attempt} 次尝试失败，正在重试...");
                    std::thread::sleep(Duration::from_millis(1000 * attempt));
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| TtsError::Api("百炼语音合成失败。".to_string())))
}

fn request_bailian_audio_url(
    client: &Client,
    tts_url: &str,
    api_key: &str,
    payload: &Value,
) -> Result<String, TtsError> {
    let response = client
        .post(tts_url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(payload)
        .send()?;
    let status = response.status();
    let response_text = response.text().map_err(|error| {
        TtsError::Api(format!("百炼 TTS 响应读取失败 (HTTP {status})：{error}"))
    })?;

    if !status.is_success() {
        return Err(TtsError::Api(format!(
            "百炼语音合成失败 (HTTP {}): {}",
            status,
            summarize_response(&response_text)
        )));
    }

    let response_json = serde_json::from_str::<Value>(&response_text).map_err(|error| {
        TtsError::Api(format!(
            "百炼 TTS 响应解析失败 (HTTP {status})：{error}；响应摘要：{}",
            summarize_response(&response_text)
        ))
    })?;

    extract_audio_url(&response_json)
        .map(ToString::to_string)
        .ok_or_else(|| TtsError::Api(format!("未返回音频 URL：{response_json}")))
}

fn summarize_response(response: &str) -> String {
    let trimmed = response.trim();
    let end = trimmed
        .char_indices()
        .map(|(index, _)| index)
        .nth(300)
        .unwrap_or(trimmed.len());
    trimmed[..end].to_string()
}

fn synthesize_volc_segment(
    client: &Client,
    api_key: &str,
    app_id: &str,
    resource_id: &str,
    voice_type: &str,
    text: &str,
    output_path: &std::path::Path,
) -> Result<(), TtsError> {
    let req_id = Uuid::new_v4().to_string();
    let payload = build_volc_tts_payload(app_id, voice_type, text, &req_id);

    let response = client
        .post("https://openspeech.bytedance.com/api/v3/tts/unidirectional")
        .header("Content-Type", "application/json")
        .header("X-Api-Key", api_key)
        .header("X-Api-Resource-Id", resource_id)
        .header("X-Api-Request-Id", &req_id)
        .json(&payload)
        .send()?;

    if !response.status().is_success() {
        let status = response.status();
        let err_text = response.text().unwrap_or_default();
        return Err(TtsError::Api(format!(
            "火山引擎 TTS 合成失败 (HTTP {}): {}",
            status, err_text
        )));
    }

    // Read response as raw bytes first (official V3 returns chunked binary audio)
    let raw_bytes = response.bytes()?;

    // Check if the raw response is actually audio data (non-empty and doesn't start with '{')
    if !raw_bytes.is_empty() && raw_bytes[0] != b'{' && raw_bytes[0] != b'[' {
        // Raw binary audio response
        fs::write(output_path, raw_bytes.as_ref())?;
        return Ok(());
    }

    // Fallback: try parsing as JSON stream with base64-encoded audio
    let body = String::from_utf8_lossy(&raw_bytes).to_string();
    let stream_objects = parse_volc_stream_objects(&body);
    let mut audio_data: Vec<u8> = Vec::new();

    for obj in &stream_objects {
        if let Some(data_str) = obj.get("data").and_then(Value::as_str) {
            if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(data_str) {
                audio_data.extend_from_slice(&decoded);
            }
        }
        if let Some(data_str) = obj.pointer("/audio/data").and_then(Value::as_str) {
            if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(data_str) {
                audio_data.extend_from_slice(&decoded);
            }
        }
    }

    if audio_data.is_empty() {
        let err_detail = volc_stream_error_detail(&stream_objects, &body);

        return Err(TtsError::Api(format!(
            "火山引擎 TTS 未返回有效音频数据（App ID: {}, 资源ID: {}, 音色: {}）。原因：{}",
            app_id, resource_id, voice_type, err_detail
        )));
    }

    fs::write(output_path, &audio_data)?;
    Ok(())
}

fn build_volc_tts_payload(app_id: &str, voice_type: &str, text: &str, _req_id: &str) -> Value {
    let model = if voice_type.contains("bigtts") {
        "seed-tts-2.0-standard"
    } else {
        "seed-tts-1.0"
    };

    json!({
        "app": {
            "appid": app_id
        },
        "user": {
            "uid": "intervox_user"
        },
        "req_params": {
            "text": text,
            "model": model,
            "speaker": voice_type,
            "audio_params": {
                "format": "wav",
                "sample_rate": 24000
            }
        }
    })
}

fn parse_volc_stream_objects(body: &str) -> Vec<Value> {
    let objects: Vec<Value> = serde_json::Deserializer::from_str(body)
        .into_iter::<Value>()
        .filter_map(Result::ok)
        .collect();

    if !objects.is_empty() {
        return objects;
    }

    body.lines()
        .filter_map(|line| {
            let line = line
                .trim()
                .strip_prefix("data:")
                .unwrap_or(line.trim())
                .trim();
            if line.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(line).ok()
            }
        })
        .collect()
}

fn volc_stream_error_detail(stream_objects: &[Value], body: &str) -> String {
    let mut server_errors = Vec::new();
    for obj in stream_objects {
        if let Some(code) = obj.get("code").or_else(|| obj.get("error_code")) {
            if let Some(msg) = obj
                .get("message")
                .or_else(|| obj.get("err_msg"))
                .or_else(|| obj.get("error"))
            {
                server_errors.push(format!("错误码 {}: {}", code, msg));
            } else {
                server_errors.push(format!("错误码 {}", code));
            }
        } else if let Some(msg) = obj
            .get("message")
            .or_else(|| obj.get("err_msg"))
            .or_else(|| obj.get("error"))
        {
            server_errors.push(msg.to_string());
        }
    }

    if !server_errors.is_empty() {
        server_errors.join("; ")
    } else {
        let trimmed_body = body.trim();
        if !trimmed_body.is_empty() {
            let limit = trimmed_body
                .char_indices()
                .map(|(i, _)| i)
                .nth(200)
                .unwrap_or(trimmed_body.len());
            format!("原始响应：{}", &trimmed_body[..limit])
        } else {
            "响应为空".to_string()
        }
    }
}

fn resolve_output_dir(
    output_dir: Option<&str>,
    cache_key: &str,
) -> Result<PathBuf, std::io::Error> {
    let mut base_dir = crate::storage::configured_output_root(output_dir)?;

    base_dir.push(format!("tts_{cache_key}"));
    Ok(base_dir)
}

fn tts_cache_key(request: &TtsRequest) -> String {
    let mut hasher = DefaultHasher::new();
    serde_json::to_string(request)
        .unwrap_or_default()
        .hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn local_tts_cache_key(request: &TtsRequest) -> String {
    let mut hasher = DefaultHasher::new();
    "local-tts-seeded-voice-v1".hash(&mut hasher);
    serde_json::to_string(request)
        .unwrap_or_default()
        .hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn has_reusable_audio_file(path: &std::path::Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 44)
        .unwrap_or(false)
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

fn is_volc_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("doubao") || m.contains("seed-") || m.contains("bigtts") || m.contains("volc")
}

#[allow(dead_code)]
fn ensure_translation_has_text(
    translation: &crate::translation::TranslationDocument,
) -> Result<(), TtsError> {
    let empty_ids: Vec<&str> = translation
        .segments
        .iter()
        .filter(|s| s.translated_text.trim().is_empty())
        .map(|s| s.id.as_str())
        .collect();
    if empty_ids.is_empty() {
        return Ok(());
    }
    let preview = empty_ids
        .iter()
        .take(5)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    Err(TtsError::Api(format!("以下段落翻译文本为空：{preview}")))
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

    #[test]
    fn maps_volc_seed_tts2_console_instance_to_resource_id() {
        assert_eq!(
            normalize_volc_tts_resource_id(
                Some("TTS-SeedTTS2.02000000775448651362"),
                "volc.service_type.10029",
            ),
            "seed-tts-2.0"
        );
    }

    #[test]
    fn keeps_explicit_volc_resource_id() {
        assert_eq!(
            normalize_volc_tts_resource_id(Some("seed-tts-2.0"), "volc.service_type.10029"),
            "seed-tts-2.0"
        );
    }

    #[test]
    fn defaults_empty_volc_resource_id() {
        assert_eq!(
            normalize_volc_tts_resource_id(Some(" "), "seed-tts-2.0"),
            "seed-tts-2.0"
        );
    }

    #[test]
    fn builds_omnivoice_generate_url_from_base_endpoint() {
        assert_eq!(
            omnivoice_generate_url(Some("http://127.0.0.1:3900")),
            "http://127.0.0.1:3900/generate"
        );
        assert_eq!(
            omnivoice_generate_url(Some("http://127.0.0.1:3900/generate")),
            "http://127.0.0.1:3900/generate"
        );
    }

    #[test]
    fn parses_local_tts_model_engine_and_steps() {
        assert_eq!(local_tts_engine("omnivoice:12"), "omnivoice");
        assert_eq!(local_tts_num_step("omnivoice:12"), 12);
        assert_eq!(local_tts_num_step("omnivoice"), 8);
    }

    #[test]
    fn omnivoice_duration_targets_normal_speech_slots_only() {
        assert_eq!(omnivoice_target_duration(0, 30_000, "嘘"), None);
        assert_eq!(omnivoice_target_duration(0, 5_000, "短"), None);
        assert_eq!(
            omnivoice_target_duration(0, 20_000, "这是一个正常长度的句子"),
            None
        );

        let duration = omnivoice_target_duration(10_000, 16_000, "这是一个正常长度的句子")
            .expect("normal speech slot should get a target duration");
        assert!((duration - 5.88).abs() < 0.01);
    }

    #[test]
    fn maps_omnivoice_default_voice_to_no_instruct() {
        assert_eq!(omnivoice_voice_instruct("default"), None);
        assert_eq!(omnivoice_voice_instruct(" "), None);
        assert_eq!(
            omnivoice_voice_instruct("female, middle-aged, low pitch"),
            Some("female, middle-aged, low pitch")
        );
    }

    #[test]
    fn omnivoice_voice_seed_is_stable_per_voice() {
        let seed = omnivoice_voice_seed(
            "omnivoice:8",
            "male, middle-aged, moderate pitch",
            "Chinese",
        );
        assert_eq!(
            seed,
            omnivoice_voice_seed(
                "omnivoice:8",
                "male, middle-aged, moderate pitch",
                "Chinese"
            )
        );
        assert_ne!(
            seed,
            omnivoice_voice_seed("omnivoice:8", "female, middle-aged, low pitch", "Chinese")
        );
    }

    #[test]
    fn builds_reference_text_from_clone_window() {
        let translation = TranslationDocument {
            source_language: "en-US".to_string(),
            target_language: TargetLanguageCode::ZhHansCn,
            provider: "aliyun_qwen".to_string(),
            segments: vec![
                crate::translation::TranslationSegment {
                    id: "seg_0".to_string(),
                    start_ms: 0,
                    end_ms: 4_000,
                    speaker_id: None,
                    source_text: "Before window".to_string(),
                    translated_text: "窗口之前".to_string(),
                },
                crate::translation::TranslationSegment {
                    id: "seg_1".to_string(),
                    start_ms: 6_000,
                    end_ms: 8_000,
                    speaker_id: None,
                    source_text: "Inside window".to_string(),
                    translated_text: "窗口内".to_string(),
                },
            ],
        };

        assert_eq!(
            reference_text_for_clone(&translation).as_deref(),
            Some("Inside window")
        );
    }

    #[test]
    fn maps_legacy_volc_voice_to_seed_tts2_default() {
        let voice_type = normalize_volc_tts_voice("zh_male_common");

        assert_eq!(voice_type, "zh_male_m191_uranus_bigtts");
        assert_eq!(
            default_volc_tts_resource_id(false, voice_type),
            "seed-tts-2.0"
        );
    }

    #[test]
    fn reports_tts_segment_progress() {
        let mut progress_events = Vec::new();

        report_tts_progress(
            &mut |progress| progress_events.push(progress),
            "segment_completed",
            2,
            4,
        );

        assert_eq!(progress_events.len(), 1);
        assert_eq!(progress_events[0].stage, "segment_completed");
        assert_eq!(progress_events[0].completed_segments, 2);
        assert_eq!(progress_events[0].total_segments, 4);
        assert_eq!(progress_events[0].progress, 0.5);
    }

    #[test]
    fn builds_volc_v3_payload_with_req_params_speaker() {
        let payload = build_volc_tts_payload(
            "test-app-id",
            "zh_male_m191_uranus_bigtts",
            "你好",
            "test-req-id",
        );

        assert_eq!(
            payload.pointer("/app/appid").and_then(Value::as_str),
            Some("test-app-id")
        );
        assert_eq!(
            payload
                .pointer("/req_params/speaker")
                .and_then(Value::as_str),
            Some("zh_male_m191_uranus_bigtts")
        );
        assert_eq!(
            payload.pointer("/req_params/model").and_then(Value::as_str),
            Some("seed-tts-2.0-standard")
        );
        assert_eq!(
            payload.pointer("/req_params/text").and_then(Value::as_str),
            Some("你好")
        );
        assert_eq!(
            payload
                .pointer("/req_params/audio_params/format")
                .and_then(Value::as_str),
            Some("wav")
        );
    }

    #[test]
    fn parses_concatenated_volc_json_stream() {
        let objects =
            parse_volc_stream_objects(r#"{"data":"YQ=="}{"code":20000000,"message":"ok"}"#);

        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].get("data").and_then(Value::as_str), Some("YQ=="));
        assert_eq!(
            objects[1].get("code").and_then(Value::as_i64),
            Some(20000000)
        );
    }
}

// ── Offline Reference Text Extraction from SRT or Segments ─────────────────

struct SrtSegment {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

fn parse_srt_time(time_str: &str) -> Option<u64> {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: u64 = parts[0].trim().parse().ok()?;
    let minutes: u64 = parts[1].trim().parse().ok()?;
    
    let seconds_parts: Vec<&str> = parts[2].split(|c| c == ',' || c == '.').collect();
    if seconds_parts.len() != 2 {
        return None;
    }
    let seconds: u64 = seconds_parts[0].trim().parse().ok()?;
    let ms: u64 = seconds_parts[1].trim().parse().ok()?;
    
    Some(hours * 3600000 + minutes * 60000 + seconds * 1000 + ms)
}

fn parse_srt_file(path: &std::path::Path) -> Vec<SrtSegment> {
    let content = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    
    let mut segments = Vec::new();
    let mut lines = content.lines().map(|l| l.trim());
    
    while let Some(line) = lines.next() {
        if line.is_empty() {
            continue;
        }
        if line.parse::<u32>().is_ok() {
            if let Some(time_line) = lines.next() {
                let time_parts: Vec<&str> = time_line.split("-->").collect();
                if time_parts.len() == 2 {
                    if let (Some(start), Some(end)) = (parse_srt_time(time_parts[0]), parse_srt_time(time_parts[1])) {
                        let mut text = String::new();
                        while let Some(text_line) = lines.next() {
                            if text_line.is_empty() {
                                break;
                            }
                            if !text.is_empty() {
                                text.push(' ');
                            }
                            text.push_str(text_line);
                        }
                        segments.push(SrtSegment {
                            start_ms: start,
                            end_ms: end,
                            text,
                        });
                    }
                }
            }
        }
    }
    segments
}

fn get_text_for_window(srt_segments: &[SrtSegment], start_ms: u64, end_ms: u64) -> String {
    let mut texts = Vec::new();
    for seg in srt_segments {
        let overlap_start = start_ms.max(seg.start_ms);
        let overlap_end = end_ms.min(seg.end_ms);
        if overlap_end > overlap_start {
            let overlap_duration = overlap_end - overlap_start;
            let seg_duration = seg.end_ms.saturating_sub(seg.start_ms);
            if overlap_duration >= 200 || (seg_duration > 0 && overlap_duration * 5 >= seg_duration) {
                texts.push(seg.text.as_str());
            }
        }
    }
    texts.join(" ")
}

fn get_text_from_target_segments(segments: &[crate::translation::TranslationSegment], start_ms: u64, end_ms: u64) -> String {
    let mut texts = Vec::new();
    for seg in segments {
        let overlap_start = start_ms.max(seg.start_ms);
        let overlap_end = end_ms.min(seg.end_ms);
        if overlap_end > overlap_start {
            let overlap_duration = overlap_end - overlap_start;
            let seg_duration = seg.end_ms.saturating_sub(seg.start_ms);
            if overlap_duration >= 200 || (seg_duration > 0 && overlap_duration * 5 >= seg_duration) {
                texts.push(seg.source_text.as_str());
            }
        }
    }
    texts.join(" ")
}

fn score_segment(segment: &crate::translation::TranslationSegment) -> i32 {
    let text = segment.source_text.trim();
    if text.is_empty() {
        return -1000;
    }
    let chars_count = text.chars().count();
    
    // Length constraints (extremely short or long segments are terrible for cloning)
    if chars_count < 15 || chars_count > 85 {
        return -1000;
    }
    
    let mut score = 0;
    if (25..=65).contains(&chars_count) {
        score += 30;
    } else {
        score += 10;
    }
    
    // Duration constraints (ideal is 3.0s to 7.0s)
    let duration_ms = segment.end_ms.saturating_sub(segment.start_ms);
    if duration_ms < 2000 || duration_ms > 9000 {
        return -1000;
    }
    if (3000..=7000).contains(&duration_ms) {
        score += 20;
    } else {
        score += 5;
    }
    
    // Preferred time window (early in the video is better to minimize seeking, but skip intros)
    if segment.start_ms >= 5_000 && segment.end_ms <= 90_000 {
        score += 15;
    } else if segment.start_ms < 5_000 {
        score -= 10;
    }
    
    // Check first word of reference text to prevent prefix leakage
    let first_word = text.split_whitespace().next().unwrap_or("").to_lowercase();
    let cleaned_word = first_word.trim_matches(|c: char| !c.is_alphabetic());
    
    let soft_words = vec![
        "and", "also", "to", "the", "that", "it", "with", "for", "as", "but", 
        "or", "so", "of", "on", "at", "by", "this", "these", "then", "there"
    ];
    let bad_start_words = vec![
        "some", "yourself", "in", "you", "we", "i", "he", "she", "they", 
        "here", "what", "how", "why", "where", "when", "who", "which"
    ];
    
    if soft_words.contains(&cleaned_word) {
        score += 50; // Heavily prefer soft function words that don't trigger copy hallucinations
    } else if bad_start_words.contains(&cleaned_word) {
        score -= 40; // Penalty for words that easily trigger copy hallucinations
    }
    
    score
}
