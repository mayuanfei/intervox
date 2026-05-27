mod asr;
mod credentials;
mod export;
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
async fn synthesize_tts(request: TtsRequest) -> Result<TtsDocument, String> {
    eprintln!("[synthesize_tts] 开始，共 {} 段翻译", request.translation.segments.len());
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tts::synthesize(request, &CredentialStore::default())
        }))
    })
    .await
    .map_err(|error| format!("TTS 任务异常终止：{error}"))?;

    match result {
        Ok(inner) => {
            eprintln!("[synthesize_tts] 完成");
            inner.map_err(|error| error.to_string())
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
            Err(msg)
        }
    }
}

#[tauri::command]
async fn export_dubbed_video(request: ExportRequest) -> Result<ExportResult, String> {
    eprintln!("[export_dubbed_video] 开始");
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            export::export_video(request)
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
            export_dubbed_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
