use crate::translation::TranslationDocument;
use crate::tts::{TtsDocument, TtsSegment};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;

const MIN_SEGMENT_SLOT_MS: u64 = 350;
const SEGMENT_FIT_PADDING_MS: u64 = 80;
const MAX_TEMPO: f32 = 1.5;
const PLAYBACK_CACHE_VERSION: &str = "v5-hls-preview";
const PLAYBACK_HLS_ENTRYPOINT: &str = "index.m3u8";
const PLAYBACK_HLS_SEGMENT_PATTERN: &str = "segment_%05d.ts";
const PLAYBACK_HLS_FIRST_SEGMENT: &str = "segment_00000.ts";
const PLAYBACK_HLS_READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_VOICEOVER_INPUTS_PER_COMMAND: usize = 100;
static ACTIVE_PLAYBACK_HLS_CANCEL: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Debug, Clone, Copy)]
struct VoiceoverTiming {
    tts_ms: u64,
    tempo: f32,
    scheduled_start_ms: u64,
    scheduled_end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubtitleTiming {
    id: String,
    start_ms: u64,
    end_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ExportRequest {
    pub media_url: String,
    pub tts: TtsDocument,
    pub output_dir: Option<String>,
    pub replace_original_audio: bool,
    pub original_audio_volume: Option<f32>,
    pub voiceover_volume: Option<f32>,
    #[serde(default)]
    pub subtitles: Option<SubtitleOptions>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SubtitleOptions {
    pub show_english: bool,
    pub show_target_language: bool,
    pub translation: TranslationDocument,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ExportResult {
    pub voiceover_path: String,
    pub video_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub stage: String,
    pub processed_ms: u64,
    pub total_ms: u64,
    pub progress: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaybackProgress {
    pub stage: String,
    pub input_path: String,
    pub processed_ms: u64,
    pub total_ms: u64,
    pub progress: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("原视频 URL 不能为空。")]
    MissingMediaUrl,
    #[error("没有可导出的配音音频。")]
    EmptyTts,
    #[error("找不到 ffmpeg。请先安装 FFmpeg，或设置 FFMPEG_PATH 后再导出。")]
    MissingFfmpeg,
    #[error("导出失败：{0}")]
    CommandFailed(String),
    #[error("写入导出文件失败：{0}")]
    Io(#[from] std::io::Error),
}

#[allow(dead_code)]
pub fn export_video(request: ExportRequest) -> Result<ExportResult, ExportError> {
    export_video_with_progress(request, |_| {})
}

pub fn export_video_with_progress<F>(
    request: ExportRequest,
    mut on_progress: F,
) -> Result<ExportResult, ExportError>
where
    F: FnMut(ExportProgress),
{
    if request.media_url.trim().is_empty() {
        return Err(ExportError::MissingMediaUrl);
    }
    if request.tts.segments.is_empty() {
        return Err(ExportError::EmptyTts);
    }
    ensure_ffmpeg()?;

    let output_dir = resolve_output_dir(request.output_dir.as_deref())?;
    fs::create_dir_all(&output_dir)?;
    let voiceover_path = output_dir.join("voiceover.wav");
    let video_path = output_dir.join("dubbed.mp4");
    let timings = schedule_voiceover_segments(&request.tts.segments)?;
    build_voiceover(&request.tts, &timings, &output_dir, &voiceover_path)?;
    let subtitle_timings = subtitle_timings(&request.tts, &timings);
    let subtitle_path =
        write_subtitles(request.subtitles.as_ref(), &subtitle_timings, &output_dir)?;
    let total_ms = probe_media_duration_ms(&request.media_url)
        .or_else(|| wav_duration_ms(&voiceover_path).ok())
        .unwrap_or(0);
    on_progress(export_progress("started", 0, total_ms));
    mux_video(
        &request.media_url,
        &voiceover_path,
        &video_path,
        request.replace_original_audio,
        request.original_audio_volume.unwrap_or(0.25),
        request.voiceover_volume.unwrap_or(1.0),
        subtitle_path.as_deref(),
        total_ms,
        |processed_ms| on_progress(export_progress("muxing", processed_ms, total_ms)),
    )?;
    on_progress(export_progress("completed", total_ms, total_ms));

    Ok(ExportResult {
        voiceover_path: voiceover_path.to_string_lossy().to_string(),
        video_path: video_path.to_string_lossy().to_string(),
    })
}

fn export_progress(stage: &str, processed_ms: u64, total_ms: u64) -> ExportProgress {
    ExportProgress {
        stage: stage.to_string(),
        processed_ms,
        total_ms,
        progress: normalized_progress(processed_ms, total_ms),
    }
}

fn playback_failed_progress(input_path: &str, total_ms: u64, message: String) -> PlaybackProgress {
    PlaybackProgress {
        stage: "failed".to_string(),
        input_path: input_path.to_string(),
        processed_ms: 0,
        total_ms,
        progress: 0.0,
        message: Some(message),
    }
}

fn playback_progress(
    stage: &str,
    input_path: &str,
    processed_ms: u64,
    total_ms: u64,
) -> PlaybackProgress {
    PlaybackProgress {
        stage: stage.to_string(),
        input_path: input_path.to_string(),
        processed_ms,
        total_ms,
        progress: normalized_progress(processed_ms, total_ms),
        message: None,
    }
}

fn normalized_progress(processed_ms: u64, total_ms: u64) -> f32 {
    if total_ms == 0 {
        0.0
    } else {
        processed_ms.min(total_ms) as f32 / total_ms as f32
    }
}

fn write_subtitles(
    options: Option<&SubtitleOptions>,
    timings: &[SubtitleTiming],
    output_dir: &Path,
) -> Result<Option<PathBuf>, ExportError> {
    let Some(options) =
        options.filter(|options| options.show_english || options.show_target_language)
    else {
        return Ok(None);
    };

    let subtitle_path = output_dir.join("subtitles.srt");
    fs::write(&subtitle_path, build_subtitle_srt(options, timings))?;
    Ok(Some(subtitle_path))
}

fn build_subtitle_srt(options: &SubtitleOptions, timings: &[SubtitleTiming]) -> String {
    let mut subtitles = String::new();
    let mut subtitle_index = 1;
    for segment in &options.translation.segments {
        let mut lines = Vec::with_capacity(2);
        if options.show_english {
            lines.push(normalize_subtitle_text(&segment.source_text));
        }
        if options.show_target_language {
            lines.push(normalize_subtitle_text(&segment.translated_text));
        }
        lines.retain(|line| !line.is_empty());
        if lines.is_empty() {
            continue;
        }

        let (start_ms, end_ms) = timings
            .iter()
            .find(|timing| timing.id == segment.id)
            .map(|timing| (timing.start_ms, timing.end_ms))
            .unwrap_or((segment.start_ms, segment.end_ms.max(segment.start_ms + 10)));
        subtitles.push_str(&format!(
            "{subtitle_index}\n{} --> {}\n{}\n\n",
            srt_timestamp(start_ms),
            srt_timestamp(end_ms.max(start_ms + 10)),
            lines.join("\n")
        ));
        subtitle_index += 1;
    }

    subtitles
}

fn normalize_subtitle_text(text: &str) -> String {
    escape_srt_text(&text.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn srt_timestamp(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds % 3_600_000) / 60_000;
    let seconds = (milliseconds % 60_000) / 1_000;
    let milliseconds = milliseconds % 1_000;

    format!("{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}")
}

fn escape_srt_text(text: &str) -> String {
    text.trim()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn ensure_ffmpeg() -> Result<(), ExportError> {
    ffmpeg_command()
        .arg("-version")
        .output()
        .map_err(|_| ExportError::MissingFfmpeg)
        .and_then(|output| {
            if output.status.success() {
                Ok(())
            } else {
                Err(ExportError::MissingFfmpeg)
            }
        })
}

fn ffmpeg_command() -> Command {
    Command::new(ffmpeg_path())
}

pub fn ffmpeg_path() -> PathBuf {
    if let Some(path) = std::env::var_os("FFMPEG_PATH").filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }

    #[cfg(target_os = "windows")]
    if let Some(path) = local_ffmpeg_path() {
        return path;
    }

    #[cfg(target_os = "windows")]
    if let Some(path) = winget_ffmpeg_path() {
        return path;
    }

    [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
    .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

#[cfg(target_os = "windows")]
fn local_ffmpeg_path() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.push(parent.to_path_buf());
        }
    }

    for root in roots {
        for ancestor in root.ancestors() {
            let candidate = ancestor
                .join("tools")
                .join("ffmpeg")
                .join("bin")
                .join("ffmpeg.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn winget_ffmpeg_path() -> Option<PathBuf> {
    let packages_dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Microsoft")
        .join("WinGet")
        .join("Packages");

    for package in fs::read_dir(packages_dir).ok()?.flatten() {
        if !package
            .file_name()
            .to_string_lossy()
            .starts_with("Gyan.FFmpeg_")
        {
            continue;
        }

        for build in fs::read_dir(package.path()).ok()?.flatten() {
            let candidate = build.path().join("bin").join("ffmpeg.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn build_voiceover(
    tts: &TtsDocument,
    timings: &[VoiceoverTiming],
    output_dir: &Path,
    voiceover_path: &Path,
) -> Result<(), ExportError> {
    let filter_path = output_dir.join("voiceover.filter.txt");
    let timeline_path = output_dir.join("voiceover.timeline.tsv");
    fs::write(&timeline_path, build_voiceover_timeline(tts, &timings))?;

    if tts.segments.len() <= MAX_VOICEOVER_INPUTS_PER_COMMAND {
        fs::write(&filter_path, build_voiceover_filter(tts, &timings))?;
        return mix_voiceover_segments(&tts.segments, 0, &filter_path, voiceover_path);
    }

    let mut batch_outputs = Vec::new();
    let mut timing_offset = 0;
    for (batch_index, segments) in tts
        .segments
        .chunks(MAX_VOICEOVER_INPUTS_PER_COMMAND)
        .enumerate()
    {
        let batch_timings = &timings[timing_offset..timing_offset + segments.len()];
        let batch_start_ms = batch_timings
            .first()
            .map(|timing| timing.scheduled_start_ms)
            .unwrap_or(0);
        let batch_filter_path =
            output_dir.join(format!("voiceover.batch.{batch_index:03}.filter.txt"));
        let batch_output_path = output_dir.join(format!("voiceover.batch.{batch_index:03}.wav"));
        fs::write(
            &batch_filter_path,
            build_voiceover_filter_for_segments(segments, batch_timings, batch_start_ms),
        )?;
        mix_voiceover_segments(
            segments,
            batch_start_ms,
            &batch_filter_path,
            &batch_output_path,
        )?;
        batch_outputs.push((batch_start_ms, batch_output_path));
        timing_offset += segments.len();
    }

    fs::write(&filter_path, build_voiceover_batch_filter(&batch_outputs))?;
    let mut command = ffmpeg_command();
    command.arg("-y");
    for (_, batch_output_path) in &batch_outputs {
        command.arg("-i").arg(batch_output_path);
    }
    command
        .arg("-filter_complex_script")
        .arg(&filter_path)
        .arg("-map")
        .arg("[aout]")
        .arg("-ar")
        .arg("24000")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(voiceover_path);
    let result = run_command(&mut command);
    if result.is_ok() {
        for (_, batch_output_path) in batch_outputs {
            let _ = fs::remove_file(batch_output_path);
        }
    }
    result
}

fn build_voiceover_filter(tts: &TtsDocument, timings: &[VoiceoverTiming]) -> String {
    build_voiceover_filter_for_segments(&tts.segments, timings, 0)
}

fn build_voiceover_filter_for_segments(
    segments: &[TtsSegment],
    timings: &[VoiceoverTiming],
    offset_ms: u64,
) -> String {
    let mut filters = Vec::with_capacity(segments.len() + 1);
    for (index, timing) in timings.iter().enumerate() {
        filters.push(segment_filter(
            index,
            timing.scheduled_start_ms.saturating_sub(offset_ms),
            timing.tempo,
        ));
    }

    let inputs = (0..segments.len())
        .map(|index| format!("[a{index}]"))
        .collect::<String>();
    filters.push(format!(
        "{inputs}amix=inputs={}:duration=longest:normalize=0[aout]",
        segments.len()
    ));
    filters.join(";")
}

fn mix_voiceover_segments(
    segments: &[TtsSegment],
    offset_ms: u64,
    filter_path: &Path,
    output_path: &Path,
) -> Result<(), ExportError> {
    let mut command = ffmpeg_command();
    command.arg("-y");
    for segment in segments {
        command.arg("-i").arg(&segment.audio_path);
    }
    command
        .arg("-filter_complex_script")
        .arg(filter_path)
        .arg("-map")
        .arg("[aout]")
        .arg("-ar")
        .arg("24000")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output_path);
    let result = run_command(&mut command);
    if result.is_err() {
        eprintln!("[voiceover] 批次混音失败，时间偏移：{offset_ms}ms");
    }
    result
}

fn build_voiceover_batch_filter(batch_outputs: &[(u64, PathBuf)]) -> String {
    let mut filters = Vec::with_capacity(batch_outputs.len() + 1);
    for (index, (start_ms, _)) in batch_outputs.iter().enumerate() {
        filters.push(format!("[{index}:a]adelay={start_ms}:all=1[a{index}]"));
    }
    let inputs = (0..batch_outputs.len())
        .map(|index| format!("[a{index}]"))
        .collect::<String>();
    filters.push(format!(
        "{inputs}amix=inputs={}:duration=longest:normalize=0[aout]",
        batch_outputs.len()
    ));
    filters.join(";")
}

fn build_voiceover_timeline(tts: &TtsDocument, timings: &[VoiceoverTiming]) -> String {
    let mut lines = vec![
        "index\tid\tstart_ms\tend_ms\ttts_ms\ttempo\tscheduled_start_ms\tscheduled_end_ms\taudio_path"
            .to_string(),
    ];
    for (index, (segment, timing)) in tts.segments.iter().zip(timings).enumerate() {
        lines.push(format!(
            "{index}\t{}\t{}\t{}\t{}\t{:.3}\t{}\t{}\t{}",
            segment.id,
            segment.start_ms,
            segment.end_ms,
            timing.tts_ms,
            timing.tempo,
            timing.scheduled_start_ms,
            timing.scheduled_end_ms,
            segment.audio_path
        ));
    }
    lines.join("\n")
}

fn segment_filter(index: usize, start_ms: u64, tempo: f32) -> String {
    let mut filter = format!("[{index}:a]");
    for tempo_filter in atempo_filters(tempo) {
        filter.push_str(&tempo_filter);
        filter.push(',');
    }
    filter.push_str(&format!("adelay={start_ms}:all=1[a{index}]"));
    filter
}

fn schedule_voiceover_segments(
    segments: &[TtsSegment],
) -> Result<Vec<VoiceoverTiming>, ExportError> {
    let mut timings = Vec::with_capacity(segments.len());
    let mut previous_end_ms = 0;
    for segment in segments {
        let tts_ms = wav_duration_ms(Path::new(&segment.audio_path))?;
        let tempo = fit_tempo(segment.start_ms, segment.end_ms, tts_ms);
        let scheduled_start_ms = scheduled_start_ms(segment.start_ms, previous_end_ms);
        let scheduled_end_ms = scheduled_start_ms + fitted_duration_ms(tts_ms, tempo);
        timings.push(VoiceoverTiming {
            tts_ms,
            tempo,
            scheduled_start_ms,
            scheduled_end_ms,
        });
        previous_end_ms = scheduled_end_ms;
    }
    Ok(timings)
}

fn subtitle_timings(tts: &TtsDocument, timings: &[VoiceoverTiming]) -> Vec<SubtitleTiming> {
    tts.segments
        .iter()
        .zip(timings)
        .map(|(segment, timing)| SubtitleTiming {
            id: segment.id.clone(),
            start_ms: timing.scheduled_start_ms,
            end_ms: timing.scheduled_end_ms,
        })
        .collect()
}

fn scheduled_start_ms(original_start_ms: u64, previous_end_ms: u64) -> u64 {
    original_start_ms.max(previous_end_ms)
}

fn fitted_duration_ms(tts_ms: u64, tempo: f32) -> u64 {
    (tts_ms as f64 / tempo.max(1.0) as f64).ceil() as u64
}

fn fit_tempo(start_ms: u64, end_ms: u64, tts_ms: u64) -> f32 {
    let slot_ms = end_ms
        .saturating_sub(start_ms)
        .saturating_sub(SEGMENT_FIT_PADDING_MS)
        .max(MIN_SEGMENT_SLOT_MS);

    if tts_ms <= slot_ms {
        return 1.0;
    }

    (tts_ms as f32 / slot_ms as f32).clamp(1.0, MAX_TEMPO)
}

fn atempo_filters(tempo: f32) -> Vec<String> {
    if !tempo.is_finite() || tempo <= 1.02 {
        return Vec::new();
    }

    let mut remaining = tempo.min(MAX_TEMPO);
    let mut filters = Vec::new();
    while remaining > 2.0 {
        filters.push("atempo=2.000".to_string());
        remaining /= 2.0;
    }
    if remaining > 1.02 {
        filters.push(format!("atempo={remaining:.3}"));
    }

    filters
}

fn wav_duration_ms(path: &Path) -> Result<u64, ExportError> {
    let mut file = fs::File::open(path)?;
    let mut riff_header = [0u8; 12];
    file.read_exact(&mut riff_header)?;

    let mut byte_rate: u32 = 0;
    let mut data_size: u32 = 0;

    loop {
        let mut chunk_header = [0u8; 8];
        if file.read_exact(&mut chunk_header).is_err() {
            break;
        }
        let chunk_id = &chunk_header[0..4];
        let chunk_size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]);

        if chunk_id == b"fmt " {
            let mut fmt = [0u8; 16];
            file.read_exact(&mut fmt)?;
            byte_rate = u32::from_le_bytes([fmt[8], fmt[9], fmt[10], fmt[11]]);
            if chunk_size > 16 {
                file.seek(SeekFrom::Current((chunk_size - 16) as i64))?;
            }
        } else if chunk_id == b"data" {
            let current_pos = file.stream_position()?;
            let file_size = file.metadata()?.len();
            if chunk_size == 0x7fffffff
                || chunk_size == 0xffffffff
                || (current_pos + chunk_size as u64) > file_size
            {
                data_size = file_size.saturating_sub(current_pos) as u32;
            } else {
                data_size = chunk_size;
            }
            break;
        } else {
            file.seek(SeekFrom::Current(chunk_size as i64))?;
        }
    }

    if byte_rate == 0 {
        return Ok(0);
    }

    Ok((data_size as u64 * 1000) / byte_rate as u64)
}

fn mux_video(
    media_url: &str,
    voiceover_path: &Path,
    video_path: &Path,
    replace_original_audio: bool,
    original_audio_volume: f32,
    voiceover_volume: f32,
    subtitle_path: Option<&Path>,
    total_ms: u64,
    on_progress: impl FnMut(u64),
) -> Result<(), ExportError> {
    let original_audio_volume = clamp_volume(original_audio_volume);
    let voiceover_volume = clamp_volume(voiceover_volume);
    let original_audio_volume = if replace_original_audio {
        0.0
    } else {
        original_audio_volume
    };
    let transcode_video = should_transcode_video_for_mp4(media_url);
    let mut command = ffmpeg_command();
    command
        .arg("-y")
        .arg("-i")
        .arg(media_url)
        .arg("-i")
        .arg(voiceover_path);
    if let Some(subtitle_path) = subtitle_path {
        command.arg("-i").arg(subtitle_path);
    }
    command.arg("-map").arg("0:v:0");

    command
        .arg("-filter_complex")
        .arg(format!(
            "[0:a:0]volume={original_audio_volume:.2}[orig];\
             [1:a:0]volume={voiceover_volume:.2}[dub];\
             [orig][dub]amix=inputs=2:duration=first:normalize=0[aout]"
        ))
        .arg("-map")
        .arg("[aout]");

    if subtitle_path.is_some() {
        command
            .arg("-map")
            .arg("2:s:0")
            .arg("-c:s")
            .arg("mov_text")
            .arg("-disposition:s:0")
            .arg("default");
    }

    if transcode_video {
        append_h264_video_args(&mut command, &playback_h264_encoder());
    } else {
        command.arg("-c:v").arg("copy");
    }
    command
        .arg("-c:a")
        .arg("aac")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(video_path);

    run_command_with_progress(&mut command, total_ms, on_progress)
}

fn should_transcode_video_for_mp4(media_url: &str) -> bool {
    let path = Path::new(media_url);
    if !path.is_file() {
        return false;
    }

    let ext = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase();
    probe_playback_media(path)
        .map(|info| playback_video_mode(&ext, &info) == PlaybackVideoMode::Transcode)
        .unwrap_or(false)
}

fn clamp_volume(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 2.0)
    } else {
        1.0
    }
}

fn run_command(command: &mut Command) -> Result<(), ExportError> {
    let output = command
        .output()
        .map_err(|error| ExportError::CommandFailed(format!("无法启动 ffmpeg：{error}")))?;
    if output.status.success() {
        return Ok(());
    }

    Err(ExportError::CommandFailed(command_error_summary(
        &output.stderr,
    )))
}

fn run_command_with_progress(
    command: &mut Command,
    total_ms: u64,
    mut on_progress: impl FnMut(u64),
) -> Result<(), ExportError> {
    run_command_with_progress_controlled(command, total_ms, &mut on_progress, || false)
}

fn run_command_with_progress_controlled(
    command: &mut Command,
    total_ms: u64,
    mut on_progress: impl FnMut(u64),
    mut should_cancel: impl FnMut() -> bool,
) -> Result<(), ExportError> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ExportError::CommandFailed(format!("无法启动 ffmpeg：{error}")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ExportError::CommandFailed("无法读取 ffmpeg 错误输出。".to_string()))?;
    let stderr_reader = thread::spawn(move || {
        let mut stderr = stderr;
        let mut output = Vec::new();
        let _ = stderr.read_to_end(&mut output);
        output
    });
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ExportError::CommandFailed("无法读取 ffmpeg 进度输出。".to_string()))?;
    let mut cancelled = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if should_cancel() {
            let _ = child.kill();
            cancelled = true;
            break;
        }
        if let Some(processed_ms) = parse_ffmpeg_progress_ms(&line) {
            on_progress(processed_ms.min(total_ms));
        }
    }
    let status = child
        .wait()
        .map_err(|error| ExportError::CommandFailed(format!("等待 ffmpeg 失败：{error}")))?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if cancelled {
        return Err(ExportError::CommandFailed("任务已取消。".to_string()));
    }
    if status.success() {
        on_progress(total_ms);
        return Ok(());
    }

    Err(ExportError::CommandFailed(command_error_summary(&stderr)))
}

fn parse_ffmpeg_progress_ms(line: &str) -> Option<u64> {
    line.strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?
        .parse::<u64>()
        .ok()
        .map(|microseconds| microseconds / 1000)
}

fn probe_media_duration_ms(media_url: &str) -> Option<u64> {
    let output = Command::new(ffprobe_path())
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(media_url)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let seconds = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Some((seconds * 1000.0).ceil() as u64)
}

fn command_error_summary(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let lines = stderr.lines().collect::<Vec<_>>();
    lines[lines.len().saturating_sub(18)..].join("\n")
}

fn resolve_output_dir(output_dir: Option<&str>) -> Result<PathBuf, std::io::Error> {
    crate::storage::configured_output_root(output_dir)
}

#[allow(dead_code)]
pub fn prepare_video_for_playback(
    input_path: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    prepare_video_for_playback_with_progress(input_path, output_dir, |_| {})
}

pub fn prepare_video_for_playback_with_progress<F>(
    input_path: String,
    output_dir: Option<String>,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(PlaybackProgress) + Send + 'static,
{
    let path = Path::new(&input_path);
    if !path.exists() {
        return Err("视频文件不存在。".to_string());
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if matches!(ext.as_str(), "mp3" | "wav" | "m4a") {
        return crate::playback_server::register_playback_file(path);
    }

    let media_info = probe_playback_media(path)?;
    let playback_mode = playback_video_mode(&ext, &media_info);
    cancel_active_hls_preview();
    if playback_mode == PlaybackVideoMode::Direct {
        return crate::playback_server::register_playback_file(path);
    }

    let temp_dir = crate::storage::ensure_output_subdir(output_dir.as_deref(), "temp_playback")
        .map_err(|e| e.to_string())?;

    // Include the conversion profile and file metadata so old incompatible previews are not reused.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    PLAYBACK_CACHE_VERSION.hash(&mut hasher);
    input_path.hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(path) {
        metadata.len().hash(&mut hasher);
        metadata.modified().ok().hash(&mut hasher);
    }
    let cache_key = hasher.finish();
    let total_ms = probe_media_duration_ms(&input_path).unwrap_or(0);
    if playback_mode == PlaybackVideoMode::Transcode {
        return prepare_hls_playback_preview(
            input_path,
            &temp_dir,
            cache_key,
            total_ms,
            on_progress,
        );
    }

    let output_path = temp_dir.join(format!("playback_preview_{cache_key:x}.mp4"));
    let partial_output_path = output_path.with_extension("partial.mp4");

    if output_path.exists() {
        let cached_info = probe_playback_media(&output_path)?;
        if playback_video_mode("mp4", &cached_info) == PlaybackVideoMode::Direct {
            return crate::playback_server::register_playback_file(&output_path);
        }
        let _ = fs::remove_file(&output_path);
    }
    let _ = fs::remove_file(&partial_output_path);

    on_progress(playback_progress("started", &input_path, 0, total_ms));
    let preferred_encoder = playback_h264_encoder();
    let copy_audio = media_info.audio_codec.as_deref() == Some("aac");
    let mut command = playback_conversion_command(
        &input_path,
        &partial_output_path,
        playback_mode,
        &preferred_encoder,
        copy_audio,
    );
    let mut result = run_command_with_progress(&mut command, total_ms, |processed_ms| {
        on_progress(playback_progress(
            "transcoding",
            &input_path,
            processed_ms,
            total_ms,
        ));
    });

    if result.is_err()
        && playback_mode == PlaybackVideoMode::Transcode
        && preferred_encoder != "libx264"
    {
        let _ = fs::remove_file(&partial_output_path);
        on_progress(playback_progress("retrying", &input_path, 0, total_ms));
        let mut command = playback_conversion_command(
            &input_path,
            &partial_output_path,
            playback_mode,
            "libx264",
            copy_audio,
        );
        result = run_command_with_progress(&mut command, total_ms, |processed_ms| {
            on_progress(playback_progress(
                "transcoding",
                &input_path,
                processed_ms,
                total_ms,
            ));
        });
    }

    if let Err(error) = result {
        let _ = fs::remove_file(&partial_output_path);
        return Err(format!("转码失败：{error}"));
    }
    fs::rename(&partial_output_path, &output_path)
        .map_err(|error| format!("保存播放器预览失败：{error}"))?;
    on_progress(playback_progress(
        "completed",
        &input_path,
        total_ms,
        total_ms,
    ));

    crate::playback_server::register_playback_file(&output_path)
}

fn prepare_hls_playback_preview<F>(
    input_path: String,
    temp_dir: &Path,
    cache_key: u64,
    total_ms: u64,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(PlaybackProgress) + Send + 'static,
{
    let stream_dir = temp_dir.join(format!("playback_stream_{cache_key:x}"));
    let playlist_path = stream_dir.join(PLAYBACK_HLS_ENTRYPOINT);
    if hls_playlist_is_complete(&playlist_path) {
        return crate::playback_server::register_playback_directory(
            &stream_dir,
            PLAYBACK_HLS_ENTRYPOINT,
        );
    }

    let _ = fs::remove_dir_all(&stream_dir);
    fs::create_dir_all(&stream_dir)
        .map_err(|error| format!("创建播放器流媒体目录失败：{error}"))?;
    on_progress(playback_progress("started", &input_path, 0, total_ms));

    let cancel = Arc::new(AtomicBool::new(false));
    replace_active_hls_preview(Arc::clone(&cancel));
    let worker_stream_dir = stream_dir.clone();
    let worker_input_path = input_path.clone();
    let worker_error = Arc::new(Mutex::new(None));
    let worker_error_for_thread = Arc::clone(&worker_error);
    let worker_cancel = Arc::clone(&cancel);
    let worker = thread::Builder::new()
        .name("intervox-playback-hls".to_string())
        .spawn(move || {
            let result = run_hls_playback_worker(
                &worker_input_path,
                &worker_stream_dir,
                total_ms,
                &worker_cancel,
                &mut on_progress,
            );
            if let Err(error) = result {
                on_progress(playback_failed_progress(
                    &worker_input_path,
                    total_ms,
                    error.clone(),
                ));
                if let Ok(mut state) = worker_error_for_thread.lock() {
                    *state = Some(error);
                }
            }
            clear_active_hls_preview(&worker_cancel);
        });
    if let Err(error) = worker {
        cancel.store(true, Ordering::Relaxed);
        clear_active_hls_preview(&cancel);
        return Err(format!("启动播放器流媒体转码失败：{error}"));
    }

    wait_for_hls_playlist(&playlist_path, &worker_error, &cancel)?;
    crate::playback_server::register_playback_directory(&stream_dir, PLAYBACK_HLS_ENTRYPOINT)
}

fn run_hls_playback_worker<F>(
    input_path: &str,
    stream_dir: &Path,
    total_ms: u64,
    cancel: &Arc<AtomicBool>,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(PlaybackProgress),
{
    let preferred_encoder = playback_h264_encoder();
    let mut encoders = vec![preferred_encoder.as_str()];
    if preferred_encoder != "libx264" {
        encoders.push("libx264");
    }

    let mut last_error = None;
    for (index, encoder) in encoders.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("播放器预览转换已取消。".to_string());
        }
        if index > 0 {
            let _ = fs::remove_dir_all(stream_dir);
            fs::create_dir_all(stream_dir)
                .map_err(|error| format!("重建播放器流媒体目录失败：{error}"))?;
            on_progress(playback_progress("retrying", input_path, 0, total_ms));
        }
        let mut command = hls_playback_conversion_command(input_path, stream_dir, encoder);
        let result = run_command_with_progress_controlled(
            &mut command,
            total_ms,
            |processed_ms| {
                on_progress(playback_progress(
                    "transcoding",
                    input_path,
                    processed_ms,
                    total_ms,
                ));
            },
            || cancel.load(Ordering::Relaxed),
        );
        match result {
            Ok(()) => {
                on_progress(playback_progress(
                    "completed",
                    input_path,
                    total_ms,
                    total_ms,
                ));
                return Ok(());
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    Err(format!(
        "播放器流媒体转码失败：{}",
        last_error.unwrap_or_else(|| "未知错误".to_string())
    ))
}

fn wait_for_hls_playlist(
    playlist_path: &Path,
    worker_error: &Arc<Mutex<Option<String>>>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let first_segment = playlist_path.with_file_name(PLAYBACK_HLS_FIRST_SEGMENT);
    let deadline = Instant::now() + PLAYBACK_HLS_READY_TIMEOUT;
    loop {
        if playlist_path.is_file() && first_segment.is_file() {
            return Ok(());
        }
        if let Ok(error) = worker_error.lock() {
            if let Some(error) = error.as_ref() {
                return Err(error.clone());
            }
        }
        if Instant::now() >= deadline {
            cancel.store(true, Ordering::Relaxed);
            return Err("播放器首个预览片段生成超时。请稍后重试。".to_string());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn cancel_active_hls_preview() {
    if let Ok(mut active) = ACTIVE_PLAYBACK_HLS_CANCEL
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        if let Some(cancel) = active.take() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

fn replace_active_hls_preview(cancel: Arc<AtomicBool>) {
    if let Ok(mut active) = ACTIVE_PLAYBACK_HLS_CANCEL
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        if let Some(previous) = active.replace(cancel) {
            previous.store(true, Ordering::Relaxed);
        }
    }
}

fn clear_active_hls_preview(cancel: &Arc<AtomicBool>) {
    if let Ok(mut active) = ACTIVE_PLAYBACK_HLS_CANCEL
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, cancel))
        {
            active.take();
        }
    }
}

fn hls_playlist_is_complete(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|playlist| playlist.contains("#EXT-X-ENDLIST"))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PlaybackMediaInfo {
    video_codec: Option<String>,
    audio_codec: Option<String>,
    video_stream_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackVideoMode {
    Direct,
    Remux,
    Transcode,
}

fn probe_playback_media(path: &Path) -> Result<PlaybackMediaInfo, String> {
    let output = Command::new(ffprobe_path())
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("stream=codec_type,codec_name")
        .arg("-of")
        .arg("json")
        .arg(path)
        .output()
        .map_err(|_| "找不到 ffprobe。请先安装 FFmpeg。".to_string())?;
    if !output.status.success() {
        return Err(format!(
            "读取媒体编码失败：{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let response: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let mut info = PlaybackMediaInfo::default();
    for stream in response
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let codec_type = stream.get("codec_type").and_then(serde_json::Value::as_str);
        let codec_name = stream
            .get("codec_name")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string);
        match codec_type {
            Some("video") => {
                info.video_stream_count += 1;
                if info.video_codec.is_none() {
                    info.video_codec = codec_name;
                }
            }
            Some("audio") if info.audio_codec.is_none() => info.audio_codec = codec_name,
            _ => {}
        }
    }
    Ok(info)
}

fn playback_video_mode(ext: &str, info: &PlaybackMediaInfo) -> PlaybackVideoMode {
    if info.video_codec.is_none() {
        return PlaybackVideoMode::Direct;
    }
    if info.video_codec.as_deref() != Some("h264") {
        return PlaybackVideoMode::Transcode;
    }
    if info.video_stream_count > 1 {
        return PlaybackVideoMode::Remux;
    }

    let compatible_container = matches!(ext, "mp4" | "mov" | "m4v");
    let compatible_audio = info
        .audio_codec
        .as_deref()
        .map_or(true, |codec| matches!(codec, "aac" | "mp3"));
    if compatible_container && compatible_audio {
        PlaybackVideoMode::Direct
    } else {
        PlaybackVideoMode::Remux
    }
}

pub fn ffprobe_path() -> PathBuf {
    let ffmpeg = ffmpeg_path();
    let ffprobe = ffmpeg.with_file_name(if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    if ffprobe.is_file() {
        ffprobe
    } else {
        PathBuf::from("ffprobe")
    }
}

fn playback_h264_encoder() -> String {
    static ENCODER: OnceLock<String> = OnceLock::new();
    ENCODER
        .get_or_init(|| {
            let supports_videotoolbox = ffmpeg_command()
                .arg("-hide_banner")
                .arg("-loglevel")
                .arg("error")
                .arg("-f")
                .arg("lavfi")
                .arg("-i")
                .arg("color=size=16x16:rate=1")
                .arg("-frames:v")
                .arg("1")
                .arg("-an")
                .arg("-c:v")
                .arg("h264_videotoolbox")
                .arg("-f")
                .arg("null")
                .arg("-")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);

            if supports_videotoolbox {
                "h264_videotoolbox".to_string()
            } else {
                "libx264".to_string()
            }
        })
        .clone()
}

fn playback_conversion_command(
    input_path: &str,
    output_path: &Path,
    playback_mode: PlaybackVideoMode,
    encoder: &str,
    copy_audio: bool,
) -> Command {
    let mut command = ffmpeg_command();
    command
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-map")
        .arg("0:v:0?")
        .arg("-map")
        .arg("0:a:0?")
        .arg("-c:a")
        .arg(if copy_audio { "copy" } else { "aac" });

    if playback_mode == PlaybackVideoMode::Transcode {
        append_h264_video_args(&mut command, encoder);
    } else {
        command.arg("-c:v").arg("copy");
    }

    command
        .arg("-movflags")
        .arg("+faststart")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(output_path);
    command
}

fn hls_playback_conversion_command(input_path: &str, stream_dir: &Path, encoder: &str) -> Command {
    let mut command = ffmpeg_command();
    command
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-map")
        .arg("0:v:0?")
        .arg("-map")
        .arg("0:a:0?")
        .arg("-c:a")
        .arg("aac");
    append_playback_h264_video_args(&mut command, encoder);
    command
        .arg("-force_key_frames")
        .arg("expr:gte(t,n_forced*2)")
        .arg("-f")
        .arg("hls")
        .arg("-hls_time")
        .arg("2")
        .arg("-hls_list_size")
        .arg("0")
        .arg("-hls_playlist_type")
        .arg("event")
        .arg("-hls_segment_filename")
        .arg(stream_dir.join(PLAYBACK_HLS_SEGMENT_PATTERN))
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(stream_dir.join(PLAYBACK_HLS_ENTRYPOINT));
    command
}

fn append_h264_video_args(command: &mut Command, encoder: &str) {
    command
        .arg("-c:v")
        .arg(encoder)
        .arg("-vf")
        .arg("scale='min(1920,iw)':-2")
        .arg("-pix_fmt")
        .arg("yuv420p");
    if encoder == "h264_videotoolbox" {
        command.arg("-allow_sw").arg("1").arg("-b:v").arg("6M");
    } else {
        command.arg("-preset").arg("veryfast").arg("-crf").arg("23");
    }
}

fn append_playback_h264_video_args(command: &mut Command, encoder: &str) {
    command
        .arg("-c:v")
        .arg(encoder)
        .arg("-vf")
        .arg("scale='min(960,iw)':-2")
        .arg("-pix_fmt")
        .arg("yuv420p");
    if encoder == "h264_videotoolbox" {
        command.arg("-allow_sw").arg("1").arg("-b:v").arg("2M");
    } else {
        command
            .arg("-preset")
            .arg("ultrafast")
            .arg("-crf")
            .arg("25");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr::TargetLanguageCode;
    use crate::translation::TranslationSegment;

    fn subtitle_options(show_english: bool, show_target_language: bool) -> SubtitleOptions {
        SubtitleOptions {
            show_english,
            show_target_language,
            translation: TranslationDocument {
                source_language: "en-US".to_string(),
                target_language: TargetLanguageCode::KoKr,
                provider: "volc_speech_mt".to_string(),
                segments: vec![TranslationSegment {
                    id: "seg_1".to_string(),
                    start_ms: 1_230,
                    end_ms: 4_560,
                    speaker_id: None,
                    source_text: "Hello world".to_string(),
                    translated_text: "안녕하세요".to_string(),
                }],
            },
        }
    }

    #[test]
    fn voiceover_filter_delays_each_segment_to_original_start_time() {
        let filter = [
            segment_filter(0, 100, 1.0),
            segment_filter(1, 900, 1.0),
            "[a0][a1]amix=inputs=2:duration=longest:normalize=0[aout]".to_string(),
        ]
        .join(";");

        assert!(filter.contains("[0:a]adelay=100:all=1[a0]"));
        assert!(filter.contains("[1:a]adelay=900:all=1[a1]"));
        assert!(filter.contains("[a0][a1]amix=inputs=2:duration=longest:normalize=0[aout]"));
    }

    #[test]
    fn batch_voiceover_filter_delays_each_batch_to_original_start_time() {
        let batch_outputs = vec![
            (0, PathBuf::from("batch-0.wav")),
            (12_345, PathBuf::from("batch-1.wav")),
        ];

        let filter = build_voiceover_batch_filter(&batch_outputs);

        assert!(filter.contains("[0:a]adelay=0:all=1[a0]"));
        assert!(filter.contains("[1:a]adelay=12345:all=1[a1]"));
        assert!(filter.contains("[a0][a1]amix=inputs=2:duration=longest:normalize=0[aout]"));
    }

    #[test]
    fn tempo_filters_cap_speed_for_clear_speech() {
        assert_eq!(atempo_filters(1.0), Vec::<String>::new());
        assert_eq!(atempo_filters(1.5), vec!["atempo=1.500"]);
        assert_eq!(atempo_filters(3.0), vec!["atempo=1.500"]);
    }

    #[test]
    fn fit_tempo_uses_segment_duration_and_clamps() {
        assert_eq!(fit_tempo(1000, 3000, 1000), 1.0);
        assert!((fit_tempo(1000, 3000, 2400) - 1.25).abs() < 0.01);
        assert_eq!(fit_tempo(1000, 3000, 3840), MAX_TEMPO);
        assert_eq!(fit_tempo(1000, 1300, 10_000), MAX_TEMPO);
    }

    #[test]
    fn voiceover_schedule_delays_overlapping_segment() {
        assert_eq!(scheduled_start_ms(900, 1200), 1200);
        assert_eq!(scheduled_start_ms(1500, 1200), 1500);
        assert_eq!(fitted_duration_ms(3000, 1.5), 2000);
    }

    #[test]
    fn ffmpeg_progress_is_parsed_as_milliseconds() {
        assert_eq!(
            parse_ffmpeg_progress_ms("out_time_us=15002500"),
            Some(15_002)
        );
        assert_eq!(parse_ffmpeg_progress_ms("out_time_ms=2500000"), Some(2_500));
        assert_eq!(parse_ffmpeg_progress_ms("progress=continue"), None);
    }

    #[test]
    fn export_progress_is_clamped_to_media_duration() {
        assert_eq!(export_progress("muxing", 500, 1000).progress, 0.5);
        assert_eq!(export_progress("muxing", 1500, 1000).progress, 1.0);
        assert_eq!(export_progress("started", 0, 0).progress, 0.0);
    }

    #[test]
    fn volume_values_are_clamped() {
        assert_eq!(clamp_volume(-1.0), 0.0);
        assert_eq!(clamp_volume(3.0), 2.0);
        assert_eq!(clamp_volume(f32::NAN), 1.0);
    }

    #[test]
    fn wav_duration_ms_handles_streaming_header() {
        use std::io::Write;
        let mut header = Vec::new();
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&0x7fffffff_u32.to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16_u32.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&24000_u32.to_le_bytes());
        header.extend_from_slice(&48000_u32.to_le_bytes());
        header.extend_from_slice(&2_u16.to_le_bytes());
        header.extend_from_slice(&16_u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&0x7fffffff_u32.to_le_bytes());
        header.extend(std::iter::repeat_n(0, 96000));

        let test_file = std::env::temp_dir().join("test_streaming.wav");
        let mut file = fs::File::create(&test_file).unwrap();
        file.write_all(&header).unwrap();

        let duration = wav_duration_ms(&test_file).unwrap();
        fs::remove_file(&test_file).ok();

        assert_eq!(duration, 2000);
    }

    #[test]
    fn bilingual_subtitles_render_english_above_target_language() {
        let subtitles = build_subtitle_srt(&subtitle_options(true, true), &[]);

        assert!(subtitles.contains("1\n00:00:01,230 --> 00:00:04,560\nHello world\n안녕하세요\n"));
    }

    #[test]
    fn single_target_subtitle_omits_english_line() {
        let subtitles = build_subtitle_srt(&subtitle_options(false, true), &[]);

        assert!(!subtitles.contains("Hello world"));
        assert!(subtitles.contains("1\n00:00:01,230 --> 00:00:04,560\n안녕하세요\n"));
    }

    #[test]
    fn subtitles_follow_scheduled_voiceover_timing() {
        let timings = vec![SubtitleTiming {
            id: "seg_1".to_string(),
            start_ms: 5_000,
            end_ms: 8_000,
        }];

        let subtitles = build_subtitle_srt(&subtitle_options(false, true), &timings);

        assert!(subtitles.contains("1\n00:00:05,000 --> 00:00:08,000\n안녕하세요\n"));
    }

    #[test]
    fn long_bilingual_subtitles_keep_complete_sentence_in_single_cue() {
        let mut options = subtitle_options(true, true);
        options.translation.segments[0].start_ms = 0;
        options.translation.segments[0].end_ms = 12_000;
        options.translation.segments[0].source_text =
            "Everything looks so good, and also when I hover this button, we have this little detail that subtle animation, and those are things that matter when you are building some UI."
                .to_string();
        options.translation.segments[0].translated_text =
            "所有东西看起来都非常棒，而且当我将鼠标悬停在这个按钮上时，会看到一个细微的动画效果。这些细节在构建用户界面时至关重要。"
                .to_string();

        let subtitles = build_subtitle_srt(&options, &[]);
        let cues = subtitles.trim().split("\n\n").collect::<Vec<_>>();

        assert_eq!(cues.len(), 1);
        assert!(subtitles.contains(&options.translation.segments[0].source_text));
        assert!(subtitles.contains(&options.translation.segments[0].translated_text));
    }

    #[test]
    fn subtitle_text_normalizes_spacing_without_splitting_sentence() {
        assert_eq!(
            normalize_subtitle_text("Everything   looks\nso good"),
            "Everything looks so good"
        );
    }

    #[test]
    fn srt_text_escapes_markup_and_normalizes_line_breaks() {
        assert_eq!(
            escape_srt_text("line <one>\r\nline & two"),
            "line &lt;one&gt;\nline &amp; two"
        );
    }

    #[test]
    fn av1_video_is_transcoded_for_webview_playback() {
        let info = PlaybackMediaInfo {
            video_codec: Some("av1".to_string()),
            audio_codec: Some("opus".to_string()),
            video_stream_count: 1,
        };

        assert_eq!(
            playback_video_mode("mkv", &info),
            PlaybackVideoMode::Transcode
        );
    }

    #[test]
    fn hls_preview_uses_short_low_resolution_segments() {
        let command =
            hls_playback_conversion_command("input.mkv", Path::new("/tmp/preview"), "libx264");
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(args.contains(&"scale='min(960,iw)':-2".to_string()));
        assert!(args.contains(&"expr:gte(t,n_forced*2)".to_string()));
        assert!(args.windows(2).any(|args| args == ["-hls_time", "2"]));
        assert!(args.windows(2).any(|args| args == ["-preset", "ultrafast"]));
    }

    #[test]
    fn hls_cache_is_reused_only_after_playlist_is_complete() {
        let temp_dir = tempfile::tempdir().unwrap();
        let playlist_path = temp_dir.path().join(PLAYBACK_HLS_ENTRYPOINT);
        fs::write(&playlist_path, "#EXTM3U\n#EXTINF:2.0,\nsegment_00000.ts\n").unwrap();
        assert!(!hls_playlist_is_complete(&playlist_path));

        fs::write(
            &playlist_path,
            "#EXTM3U\n#EXTINF:2.0,\nsegment_00000.ts\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        assert!(hls_playlist_is_complete(&playlist_path));
    }

    #[test]
    fn h264_mkv_is_remuxed_for_webview_playback() {
        let info = PlaybackMediaInfo {
            video_codec: Some("h264".to_string()),
            audio_codec: Some("opus".to_string()),
            video_stream_count: 1,
        };

        assert_eq!(playback_video_mode("mkv", &info), PlaybackVideoMode::Remux);
    }

    #[test]
    fn h264_aac_mp4_plays_without_preview_conversion() {
        let info = PlaybackMediaInfo {
            video_codec: Some("h264".to_string()),
            audio_codec: Some("aac".to_string()),
            video_stream_count: 1,
        };

        assert_eq!(playback_video_mode("mp4", &info), PlaybackVideoMode::Direct);
    }

    #[test]
    fn h264_aac_mp4_with_cover_stream_is_remuxed_for_webview_playback() {
        let info = PlaybackMediaInfo {
            video_codec: Some("h264".to_string()),
            audio_codec: Some("aac".to_string()),
            video_stream_count: 2,
        };

        assert_eq!(playback_video_mode("mp4", &info), PlaybackVideoMode::Remux);
    }
}
