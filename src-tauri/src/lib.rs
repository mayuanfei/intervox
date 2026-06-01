mod asr;
mod credentials;
mod export;
mod playback_server;
mod storage;
mod translation;
mod tts;

use asr::{
    default_asr_config, validate_credentials, AsrConfig, AsrProviderId, AsrTranscriptionRequest,
    CredentialValidationResult, TranscriptDocument,
};
use credentials::CredentialStore;
use export::{ExportRequest, ExportResult};
use tauri::Emitter;
use translation::{TranslationDocument, TranslationRequest};
use tts::{TtsDocument, TtsRequest};

#[tauri::command]
fn get_asr_defaults() -> AsrConfig {
    default_asr_config()
}

#[tauri::command]
fn asr_save_credential(
    provider: AsrProviderId,
    secret: String,
) -> Result<CredentialValidationResult, String> {
    if provider == AsrProviderId::LocalWhisper {
        return Ok(CredentialValidationResult::ok(
            provider,
            "本地 Whisper 不需要云端凭据。",
        ));
    }

    CredentialStore::default()
        .save(provider, secret)
        .map_err(|error| error.to_string())?;

    Ok(CredentialValidationResult::ok(
        provider,
        "凭据已保存到本机安全存储。",
    ))
}

#[tauri::command]
fn asr_validate_credentials(
    provider: AsrProviderId,
    config: AsrConfig,
) -> Result<CredentialValidationResult, String> {
    validate_credentials(provider, &config, &CredentialStore::default())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn asr_transcribe(
    app: tauri::AppHandle,
    request: AsrTranscriptionRequest,
) -> Result<TranscriptDocument, String> {
    let job_id = request
        .job_id
        .clone()
        .unwrap_or_else(|| "ad-hoc".to_string());
    app.emit(
        "asr-progress",
        serde_json::json!({
            "job_id": job_id,
            "stage": "started",
            "progress": 0.0
        }),
    )
    .map_err(|error| error.to_string())?;

    let result = tauri::async_runtime::spawn_blocking(move || asr::transcribe(request))
        .await
        .map_err(|error| error.to_string())?;

    match result {
        Ok(document) => {
            for segment in &document.segments {
                app.emit(
                    "asr-segment-ready",
                    serde_json::json!({
                        "job_id": job_id,
                        "segment": segment
                    }),
                )
                .map_err(|error| error.to_string())?;
            }

            app.emit(
                "asr-progress",
                serde_json::json!({
                    "job_id": job_id,
                    "stage": "completed",
                    "progress": 1.0
                }),
            )
            .map_err(|error| error.to_string())?;

            Ok(document)
        }
        Err(error) => {
            let message = error.to_string();
            app.emit(
                "asr-failed",
                serde_json::json!({
                    "job_id": job_id,
                    "message": message
                }),
            )
            .map_err(|emit_error| emit_error.to_string())?;
            Err(message)
        }
    }
}

#[tauri::command]
fn asr_cancel(job_id: String) -> Result<(), String> {
    if job_id.trim().is_empty() {
        return Err("job_id 不能为空。".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn translate_transcript(
    app: tauri::AppHandle,
    request: TranslationRequest,
) -> Result<TranslationDocument, String> {
    app.emit(
        "translation-progress",
        serde_json::json!({
            "stage": "queued",
            "completed_batches": 0,
            "total_batches": 0,
            "completed_segments": 0,
            "total_segments": request.transcript.segments.len(),
            "progress": 0.0
        }),
    )
    .map_err(|error| error.to_string())?;

    let app_for_task = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let app_for_progress = app_for_task.clone();
        translation::translate_with_progress(
            request,
            &CredentialStore::default(),
            move |progress| {
                let _ = app_for_progress.emit("translation-progress", progress);
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?;

    match result {
        Ok(document) => {
            app.emit(
                "translation-progress",
                serde_json::json!({
                    "stage": "completed",
                    "completed_batches": 1,
                    "total_batches": 1,
                    "completed_segments": document.segments.len(),
                    "total_segments": document.segments.len(),
                    "progress": 1.0
                }),
            )
            .map_err(|error| error.to_string())?;

            Ok(document)
        }
        Err(error) => {
            let message = error.to_string();
            app.emit(
                "translation-failed",
                serde_json::json!({
                    "message": message
                }),
            )
            .map_err(|emit_error| emit_error.to_string())?;
            Err(message)
        }
    }
}

#[tauri::command]
async fn synthesize_tts(app: tauri::AppHandle, request: TtsRequest) -> Result<TtsDocument, String> {
    eprintln!(
        "[synthesize_tts] 开始，共 {} 段翻译",
        request.translation.segments.len()
    );
    let app_for_task = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let app_for_progress = app_for_task.clone();
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tts::synthesize_with_progress(request, &CredentialStore::default(), move |progress| {
                let _ = app_for_progress.emit("tts-progress", progress);
            })
        }))
    })
    .await
    .map_err(|error| format!("TTS 任务异常终止：{error}"))?;

    match result {
        Ok(inner) => {
            eprintln!("[synthesize_tts] 完成");
            inner.map_err(|error| {
                let message = error.to_string();
                let _ = app.emit(
                    "tts-failed",
                    serde_json::json!({
                        "message": &message
                    }),
                );
                message
            })
        }
        Err(panic_value) => {
            let msg = if let Some(s) = panic_value.downcast_ref::<&str>() {
                format!("TTS 内部 panic：{s}")
            } else if let Some(s) = panic_value.downcast_ref::<String>() {
                format!("TTS 内部 panic：{s}")
            } else {
                "TTS 内部发生未知 panic".to_string()
            };
            eprintln!("[synthesize_tts] {msg}");
            let _ = app.emit(
                "tts-failed",
                serde_json::json!({
                    "message": &msg
                }),
            );
            Err(msg)
        }
    }
}

#[tauri::command]
fn validate_tts_cache(tts: TtsDocument) -> bool {
    !tts.segments.is_empty()
        && tts.segments.iter().all(|segment| {
            !segment.audio_path.trim().is_empty()
                && std::path::Path::new(&segment.audio_path).is_file()
        })
}

#[tauri::command]
async fn export_dubbed_video(
    app: tauri::AppHandle,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    eprintln!("[export_dubbed_video] 开始");
    let app_for_progress = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            export::export_video_with_progress(request, move |progress| {
                let _ = app_for_progress.emit("export-progress", progress);
            })
        }))
    })
    .await
    .map_err(|error| format!("导出任务异常终止：{error}"))?;

    match result {
        Ok(inner) => {
            eprintln!("[export_dubbed_video] 完成");
            inner.map_err(|error| error.to_string())
        }
        Err(panic_value) => {
            let msg = if let Some(s) = panic_value.downcast_ref::<&str>() {
                format!("导出内部 panic：{s}")
            } else if let Some(s) = panic_value.downcast_ref::<String>() {
                format!("导出内部 panic：{s}")
            } else {
                "导出内部发生未知 panic".to_string()
            };
            eprintln!("[export_dubbed_video] {msg}");
            Err(msg)
        }
    }
}

#[tauri::command]
async fn prepare_video_for_playback(
    input_path: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export::prepare_video_for_playback(input_path, output_dir)
    })
    .await
    .map_err(|error| format!("转码任务异常终止：{error}"))?
}

#[tauri::command]
fn select_local_file() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .add_filter(
            "Video/Audio",
            &[
                "mp4", "m4v", "mkv", "avi", "mov", "webm", "rm", "rmvb", "wmv", "flv", "mpg",
                "mpeg", "ts", "mts", "m2ts", "mp3", "wav", "m4a", "flac",
            ],
        )
        .pick_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn select_local_directory() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new().pick_folder();
    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

/// Reveal a file in Finder (macOS) / Explorer (Windows) / file manager (Linux).
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径不能为空。".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法在 Finder 中显示文件：{e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法在 Explorer 中显示文件：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try nautilus first, fall back to xdg-open on the parent dir
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("无法打开文件管理器：{e}"))?;
    }
    Ok(())
}

/// Open a file with the system default application.
#[tauri::command]
fn open_in_default_app(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径不能为空。".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开文件：{e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("无法打开文件：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开文件：{e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_asr_defaults,
            asr_save_credential,
            asr_validate_credentials,
            asr_transcribe,
            asr_cancel,
            translate_transcript,
            synthesize_tts,
            validate_tts_cache,
            export_dubbed_video,
            prepare_video_for_playback,
            select_local_file,
            select_local_directory,
            reveal_in_finder,
            open_in_default_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
