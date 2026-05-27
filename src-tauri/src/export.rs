use crate::tts::TtsDocument;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;
use uuid::Uuid;

const MIN_SEGMENT_SLOT_MS: u64 = 350;
const SEGMENT_FIT_PADDING_MS: u64 = 80;
const MAX_TEMPO: f32 = 3.0;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ExportRequest {
    pub media_url: String,
    pub tts: TtsDocument,
    pub output_dir: Option<String>,
    pub replace_original_audio: bool,
    pub original_audio_volume: Option<f32>,
    pub voiceover_volume: Option<f32>,
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
    mux_video(
        &request.media_url,
        &voiceover_path,
        &video_path,
        request.replace_original_audio,
        request.original_audio_volume.unwrap_or(0.25),
        request.voiceover_volume.unwrap_or(1.0),
    )?;

    Ok(ExportResult {
        voiceover_path: voiceover_path.to_string_lossy().to_string(),
        video_path: video_path.to_string_lossy().to_string(),
    })
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

fn ffmpeg_path() -> PathBuf {
    if let Some(path) = std::env::var_os("FFMPEG_PATH").filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
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

fn build_voiceover(
    tts: &TtsDocument,
    output_dir: &Path,
    voiceover_path: &Path,
) -> Result<(), ExportError> {
    let filter_path = output_dir.join("voiceover.filter.txt");
    let timeline_path = output_dir.join("voiceover.timeline.tsv");
    fs::write(&filter_path, build_voiceover_filter(tts)?)?;
    fs::write(&timeline_path, build_voiceover_timeline(tts)?)?;

    let mut command = ffmpeg_command();
    command.arg("-y");
    for segment in &tts.segments {
        command.arg("-i").arg(&segment.audio_path);
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
    run_command(&mut command)
}

fn build_voiceover_filter(tts: &TtsDocument) -> Result<String, ExportError> {
    let mut filters = Vec::with_capacity(tts.segments.len() + 1);
    for (index, segment) in tts.segments.iter().enumerate() {
        let tempo = segment_tempo(segment.start_ms, segment.end_ms, Path::new(&segment.audio_path))?;
        filters.push(segment_filter(index, segment.start_ms, tempo));
    }

    let inputs = (0..tts.segments.len())
        .map(|index| format!("[a{index}]"))
        .collect::<String>();
    filters.push(format!(
        "{inputs}amix=inputs={}:duration=longest:normalize=0[aout]",
        tts.segments.len()
    ));
    Ok(filters.join(";"))
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
        let chunk_size =
            u32::from_le_bytes([chunk_header[4], chunk_header[5], chunk_header[6], chunk_header[7]]);

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
) -> Result<(), ExportError> {
    let original_audio_volume = clamp_volume(original_audio_volume);
    let voiceover_volume = clamp_volume(voiceover_volume);
    let original_audio_volume = if replace_original_audio {
        0.0
    } else {
        original_audio_volume
    };
    let mut command = ffmpeg_command();
    command
        .arg("-y")
        .arg("-i")
        .arg(media_url)
        .arg("-i")
        .arg(voiceover_path)
        .arg("-map")
        .arg("0:v:0");

    command
        .arg("-filter_complex")
        .arg(format!(
            "[0:a:0]volume={original_audio_volume:.2}[orig];\
             [1:a:0]volume={voiceover_volume:.2}[dub];\
             [orig][dub]amix=inputs=2:duration=first:normalize=0[aout]"
        ))
        .arg("-map")
        .arg("[aout]");

    command
        .arg("-c:v")
        .arg("copy")
        .arg("-c:a")
        .arg("aac")
        .arg(video_path);

    run_command(&mut command)
}

fn clamp_volume(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 2.0)
    } else {
        1.0
    }
}

fn run_command(command: &mut Command) -> Result<(), ExportError> {
    let output = command.output().map_err(|_| ExportError::MissingFfmpeg)?;
    if output.status.success() {
        return Ok(());
    }

    Err(ExportError::CommandFailed(
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
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
        .join(format!("video_{}", Uuid::new_v4())))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
