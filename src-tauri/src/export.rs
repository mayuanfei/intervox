use crate::translation::TranslationDocument;
use crate::tts::TtsDocument;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;

const MIN_SEGMENT_SLOT_MS: u64 = 350;
const SEGMENT_FIT_PADDING_MS: u64 = 80;
const MAX_TEMPO: f32 = 3.0;
const MAX_ENGLISH_SUBTITLE_WIDTH: usize = 36;
const MAX_TARGET_SUBTITLE_WIDTH: usize = 28;
const PLAYBACK_CACHE_VERSION: &str = "v3-h264-preview-no-upscale";
const MAX_VOICEOVER_INPUTS_PER_COMMAND: usize = 100;

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

pub fn export_video(request: ExportRequest) -> Result<ExportResult, ExportError> {
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
    build_voiceover(&request.tts, &output_dir, &voiceover_path)?;
    let subtitle_path = write_subtitles(request.subtitles.as_ref(), &output_dir)?;
    mux_video(
        &request.media_url,
        &voiceover_path,
        &video_path,
        request.replace_original_audio,
        request.original_audio_volume.unwrap_or(0.25),
        request.voiceover_volume.unwrap_or(1.0),
        subtitle_path.as_deref(),
    )?;

    Ok(ExportResult {
        voiceover_path: voiceover_path.to_string_lossy().to_string(),
        video_path: video_path.to_string_lossy().to_string(),
    })
}

fn write_subtitles(
    options: Option<&SubtitleOptions>,
    output_dir: &Path,
) -> Result<Option<PathBuf>, ExportError> {
    let Some(options) =
        options.filter(|options| options.show_english || options.show_target_language)
    else {
        return Ok(None);
    };

    let subtitle_path = output_dir.join("subtitles.srt");
    fs::write(&subtitle_path, build_subtitle_srt(options))?;
    Ok(Some(subtitle_path))
}

fn build_subtitle_srt(options: &SubtitleOptions) -> String {
    let mut subtitles = String::new();
    let mut subtitle_index = 1;
    for segment in &options.translation.segments {
        let mut english_chunks = if options.show_english {
            split_subtitle_lines(&segment.source_text, MAX_ENGLISH_SUBTITLE_WIDTH)
        } else {
            Vec::new()
        };
        let mut target_chunks = if options.show_target_language {
            split_subtitle_lines(&segment.translated_text, MAX_TARGET_SUBTITLE_WIDTH)
        } else {
            Vec::new()
        };
        let cue_count = english_chunks.len().max(target_chunks.len());

        if cue_count == 0 {
            continue;
        }

        balance_subtitle_chunks(&mut english_chunks, cue_count);
        balance_subtitle_chunks(&mut target_chunks, cue_count);
        let duration_ms = segment.end_ms.max(segment.start_ms + 10) - segment.start_ms;

        for cue_index in 0..cue_count {
            let mut lines = Vec::with_capacity(2);
            if let Some(text) = english_chunks.get(cue_index) {
                lines.push(escape_srt_text(text));
            }
            if let Some(text) = target_chunks.get(cue_index) {
                lines.push(escape_srt_text(text));
            }
            if lines.is_empty() {
                continue;
            }

            let start_ms = segment.start_ms + (duration_ms * cue_index as u64 / cue_count as u64);
            let end_ms =
                segment.start_ms + (duration_ms * (cue_index + 1) as u64 / cue_count as u64);
            subtitles.push_str(&format!(
                "{subtitle_index}\n{} --> {}\n{}\n\n",
                srt_timestamp(start_ms),
                srt_timestamp(end_ms),
                lines.join("\n")
            ));
            subtitle_index += 1;
        }
    }

    subtitles
}

fn split_subtitle_lines(text: &str, max_width: usize) -> Vec<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut lines = Vec::new();
    let mut current_line = String::new();
    for word in normalized
        .split(' ')
        .flat_map(|word| split_long_word(word, max_width))
    {
        let separator_width = usize::from(!current_line.is_empty());
        if !current_line.is_empty()
            && subtitle_visual_width(&current_line) + separator_width + subtitle_visual_width(&word)
                > max_width
        {
            lines.push(current_line);
            current_line = String::new();
        }

        if !current_line.is_empty() {
            current_line.push(' ');
        }
        current_line.push_str(&word);
    }

    if !current_line.is_empty() {
        lines.push(current_line);
    }
    lines
}

fn split_long_word(word: &str, max_width: usize) -> Vec<String> {
    if subtitle_visual_width(word) <= max_width {
        return vec![word.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current_chunk = String::new();
    let mut current_width = 0;
    for character in word.chars() {
        let character_width = subtitle_character_width(character);
        if current_width > 0 && current_width + character_width > max_width {
            chunks.push(current_chunk);
            current_chunk = String::new();
            current_width = 0;
        }
        current_chunk.push(character);
        current_width += character_width;
    }

    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }
    chunks
}

fn balance_subtitle_chunks(chunks: &mut Vec<String>, cue_count: usize) {
    while !chunks.is_empty() && chunks.len() < cue_count {
        let Some((split_index, _)) = chunks
            .iter()
            .enumerate()
            .filter_map(|(index, text)| split_subtitle_line(text).map(|_| (index, text)))
            .max_by_key(|(_, text)| subtitle_visual_width(text))
        else {
            break;
        };

        let Some((left, right)) = split_subtitle_line(&chunks[split_index]) else {
            break;
        };
        chunks.splice(split_index..=split_index, [left, right]);
    }
}

fn split_subtitle_line(text: &str) -> Option<(String, String)> {
    let words = text.split_whitespace().collect::<Vec<_>>();
    if words.len() > 1 {
        let split_index = best_subtitle_word_split(&words);
        return Some((
            words[..split_index].join(" "),
            words[split_index..].join(" "),
        ));
    }

    let characters = text.chars().collect::<Vec<_>>();
    if characters.len() < 2 {
        return None;
    }
    let target_width = subtitle_visual_width(text).div_ceil(2);
    let mut split_index = 1;
    let mut width = 0;
    for (index, character) in characters.iter().enumerate().take(characters.len() - 1) {
        width += subtitle_character_width(*character);
        split_index = index + 1;
        if width >= target_width {
            break;
        }
    }

    Some((
        characters[..split_index].iter().collect(),
        characters[split_index..].iter().collect(),
    ))
}

fn best_subtitle_word_split(words: &[&str]) -> usize {
    let total_width = subtitle_visual_width(&words.join(" "));
    let target_width = total_width.div_ceil(2);
    let mut best_index = 1;
    let mut best_distance = usize::MAX;

    for index in 1..words.len() {
        let width = subtitle_visual_width(&words[..index].join(" "));
        let distance = width.abs_diff(target_width);
        if distance < best_distance {
            best_index = index;
            best_distance = distance;
        }
    }
    best_index
}

fn subtitle_visual_width(text: &str) -> usize {
    text.chars().map(subtitle_character_width).sum()
}

fn subtitle_character_width(character: char) -> usize {
    if character.is_ascii() {
        1
    } else {
        2
    }
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
    output_dir: &Path,
    voiceover_path: &Path,
) -> Result<(), ExportError> {
    let filter_path = output_dir.join("voiceover.filter.txt");
    let timeline_path = output_dir.join("voiceover.timeline.tsv");
    fs::write(&timeline_path, build_voiceover_timeline(tts)?)?;

    if tts.segments.len() <= MAX_VOICEOVER_INPUTS_PER_COMMAND {
        fs::write(&filter_path, build_voiceover_filter(tts)?)?;
        return mix_voiceover_segments(&tts.segments, 0, &filter_path, voiceover_path);
    }

    let mut batch_outputs = Vec::new();
    for (batch_index, segments) in tts
        .segments
        .chunks(MAX_VOICEOVER_INPUTS_PER_COMMAND)
        .enumerate()
    {
        let batch_start_ms = segments
            .iter()
            .map(|segment| segment.start_ms)
            .min()
            .unwrap_or(0);
        let batch_filter_path =
            output_dir.join(format!("voiceover.batch.{batch_index:03}.filter.txt"));
        let batch_output_path = output_dir.join(format!("voiceover.batch.{batch_index:03}.wav"));
        fs::write(
            &batch_filter_path,
            build_voiceover_filter_for_segments(segments, batch_start_ms)?,
        )?;
        mix_voiceover_segments(
            segments,
            batch_start_ms,
            &batch_filter_path,
            &batch_output_path,
        )?;
        batch_outputs.push((batch_start_ms, batch_output_path));
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

fn build_voiceover_filter(tts: &TtsDocument) -> Result<String, ExportError> {
    build_voiceover_filter_for_segments(&tts.segments, 0)
}

fn build_voiceover_filter_for_segments(
    segments: &[crate::tts::TtsSegment],
    offset_ms: u64,
) -> Result<String, ExportError> {
    let mut filters = Vec::with_capacity(segments.len() + 1);
    for (index, segment) in segments.iter().enumerate() {
        let tempo = segment_tempo(
            segment.start_ms,
            segment.end_ms,
            Path::new(&segment.audio_path),
        )?;
        filters.push(segment_filter(
            index,
            segment.start_ms.saturating_sub(offset_ms),
            tempo,
        ));
    }

    let inputs = (0..segments.len())
        .map(|index| format!("[a{index}]"))
        .collect::<String>();
    filters.push(format!(
        "{inputs}amix=inputs={}:duration=longest:normalize=0[aout]",
        segments.len()
    ));
    Ok(filters.join(";"))
}

fn mix_voiceover_segments(
    segments: &[crate::tts::TtsSegment],
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

fn build_voiceover_timeline(tts: &TtsDocument) -> Result<String, ExportError> {
    let mut lines = vec!["index\tid\tstart_ms\tend_ms\ttts_ms\ttempo\taudio_path".to_string()];
    for (index, segment) in tts.segments.iter().enumerate() {
        let audio_path = Path::new(&segment.audio_path);
        let tts_ms = wav_duration_ms(audio_path)?;
        let tempo = fit_tempo(segment.start_ms, segment.end_ms, tts_ms);
        lines.push(format!(
            "{index}\t{}\t{}\t{}\t{}\t{tempo:.3}\t{}",
            segment.id, segment.start_ms, segment.end_ms, tts_ms, segment.audio_path
        ));
    }
    Ok(lines.join("\n"))
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

fn segment_tempo(start_ms: u64, end_ms: u64, audio_path: &Path) -> Result<f32, ExportError> {
    Ok(fit_tempo(start_ms, end_ms, wav_duration_ms(audio_path)?))
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
    command.arg("-c:a").arg("aac").arg(video_path);

    run_command(&mut command)
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

fn command_error_summary(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let lines = stderr.lines().collect::<Vec<_>>();
    lines[lines.len().saturating_sub(18)..].join("\n")
}

fn resolve_output_dir(output_dir: Option<&str>) -> Result<PathBuf, std::io::Error> {
    crate::storage::configured_output_root(output_dir)
}

pub fn prepare_video_for_playback(
    input_path: String,
    output_dir: Option<String>,
) -> Result<String, String> {
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
        return Ok(input_path);
    }

    let media_info = probe_playback_media(path)?;
    let playback_mode = playback_video_mode(&ext, &media_info);
    if playback_mode == PlaybackVideoMode::Direct {
        return Ok(input_path);
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
    let output_path = temp_dir.join(format!("playback_preview_{:x}.mp4", hasher.finish()));
    let partial_output_path = output_path.with_extension("partial.mp4");

    if output_path.exists() {
        let cached_info = probe_playback_media(&output_path)?;
        if playback_video_mode("mp4", &cached_info) == PlaybackVideoMode::Direct {
            return Ok(output_path.to_string_lossy().to_string());
        }
        let _ = fs::remove_file(&output_path);
    }
    let _ = fs::remove_file(&partial_output_path);

    let preferred_encoder = playback_h264_encoder();
    let mut output = playback_conversion_command(
        &input_path,
        &partial_output_path,
        playback_mode,
        &preferred_encoder,
    )
    .output()
    .map_err(|_| "找不到 ffmpeg。请先安装 FFmpeg。".to_string())?;

    if !output.status.success()
        && playback_mode == PlaybackVideoMode::Transcode
        && preferred_encoder != "libx264"
    {
        let _ = fs::remove_file(&partial_output_path);
        output = playback_conversion_command(
            &input_path,
            &partial_output_path,
            playback_mode,
            "libx264",
        )
        .output()
        .map_err(|_| "找不到 ffmpeg。请先安装 FFmpeg。".to_string())?;
    }

    if !output.status.success() {
        let _ = fs::remove_file(&partial_output_path);
        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("转码失败：{err_msg}"));
    }
    fs::rename(&partial_output_path, &output_path)
        .map_err(|error| format!("保存播放器预览失败：{error}"))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PlaybackMediaInfo {
    video_codec: Option<String>,
    audio_codec: Option<String>,
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
            Some("video") if info.video_codec.is_none() => info.video_codec = codec_name,
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
    let supports_videotoolbox = ffmpeg_command()
        .arg("-hide_banner")
        .arg("-encoders")
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains("h264_videotoolbox"))
        .unwrap_or(false);

    if supports_videotoolbox {
        "h264_videotoolbox".to_string()
    } else {
        "libx264".to_string()
    }
}

fn playback_conversion_command(
    input_path: &str,
    output_path: &Path,
    playback_mode: PlaybackVideoMode,
    encoder: &str,
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
        .arg("aac");

    if playback_mode == PlaybackVideoMode::Transcode {
        append_h264_video_args(&mut command, encoder);
    } else {
        command.arg("-c:v").arg("copy");
    }

    command.arg("-movflags").arg("+faststart").arg(output_path);
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
    fn tempo_filters_split_values_above_two() {
        assert_eq!(atempo_filters(1.0), Vec::<String>::new());
        assert_eq!(atempo_filters(1.5), vec!["atempo=1.500"]);
        assert_eq!(atempo_filters(3.0), vec!["atempo=2.000", "atempo=1.500"]);
    }

    #[test]
    fn fit_tempo_uses_segment_duration_and_clamps() {
        assert_eq!(fit_tempo(1000, 3000, 1000), 1.0);
        assert!((fit_tempo(1000, 3000, 3840) - 2.0).abs() < 0.01);
        assert_eq!(fit_tempo(1000, 1300, 10_000), MAX_TEMPO);
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
        let subtitles = build_subtitle_srt(&subtitle_options(true, true));

        assert!(subtitles.contains("1\n00:00:01,230 --> 00:00:04,560\nHello world\n안녕하세요\n"));
    }

    #[test]
    fn single_target_subtitle_omits_english_line() {
        let subtitles = build_subtitle_srt(&subtitle_options(false, true));

        assert!(!subtitles.contains("Hello world"));
        assert!(subtitles.contains("1\n00:00:01,230 --> 00:00:04,560\n안녕하세요\n"));
    }

    #[test]
    fn long_bilingual_subtitles_are_split_into_short_two_line_cues() {
        let mut options = subtitle_options(true, true);
        options.translation.segments[0].start_ms = 0;
        options.translation.segments[0].end_ms = 12_000;
        options.translation.segments[0].source_text =
            "Everything looks so good, and also when I hover this button, we have this little detail that subtle animation, and those are things that matter when you are building some UI."
                .to_string();
        options.translation.segments[0].translated_text =
            "所有东西看起来都非常棒，而且当我将鼠标悬停在这个按钮上时，会看到一个细微的动画效果。这些细节在构建用户界面时至关重要。"
                .to_string();

        let subtitles = build_subtitle_srt(&options);
        let cues = subtitles.trim().split("\n\n").collect::<Vec<_>>();

        assert!(cues.len() > 3);
        for cue in cues {
            let lines = cue.lines().skip(2).collect::<Vec<_>>();
            assert_eq!(lines.len(), 2);
            assert!(subtitle_visual_width(lines[0]) <= MAX_ENGLISH_SUBTITLE_WIDTH);
            assert!(subtitle_visual_width(lines[1]) <= MAX_TARGET_SUBTITLE_WIDTH);
        }
    }

    #[test]
    fn english_subtitle_split_preserves_word_boundaries() {
        assert_eq!(
            split_subtitle_lines("Everything looks so good when hovering", 20),
            vec!["Everything looks so", "good when hovering"]
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
        };

        assert_eq!(
            playback_video_mode("mkv", &info),
            PlaybackVideoMode::Transcode
        );
    }

    #[test]
    fn h264_mkv_is_remuxed_for_webview_playback() {
        let info = PlaybackMediaInfo {
            video_codec: Some("h264".to_string()),
            audio_codec: Some("opus".to_string()),
        };

        assert_eq!(playback_video_mode("mkv", &info), PlaybackVideoMode::Remux);
    }

    #[test]
    fn h264_aac_mp4_plays_without_preview_conversion() {
        let info = PlaybackMediaInfo {
            video_codec: Some("h264".to_string()),
            audio_codec: Some("aac".to_string()),
        };

        assert_eq!(playback_video_mode("mp4", &info), PlaybackVideoMode::Direct);
    }
}
