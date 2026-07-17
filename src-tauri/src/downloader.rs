use reqwest::blocking::Client;
use reqwest::header::{CONTENT_TYPE, REFERER, USER_AGENT};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const MAX_PAGE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RESOURCES: usize = 240;
const YT_DLP_PROGRESS_PREFIX: &str = "intervox-progress:";
const USER_AGENT_VALUE: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Intervox/0.1";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DownloadResource {
    pub id: String,
    pub kind: String,
    pub url: String,
    pub label: String,
    pub extension: String,
    pub protocol: String,
    pub language: Option<String>,
    pub size_bytes: Option<u64>,
    pub format_id: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DownloadAnalysis {
    pub source_url: String,
    pub title: String,
    pub extractor: String,
    pub duration_seconds: Option<u64>,
    pub thumbnail_url: Option<String>,
    pub video_options: Vec<VideoDownloadOption>,
    pub subtitle_languages: Vec<SubtitleLanguageOption>,
    pub resources: Vec<DownloadResource>,
    pub subtitles: Vec<DownloadResource>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct VideoDownloadOption {
    pub id: String,
    pub label: String,
    pub height: u64,
    pub extension: String,
    pub size_bytes: Option<u64>,
    pub recommended: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SubtitleLanguageOption {
    pub id: String,
    pub language: String,
    pub label: String,
    pub automatic: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadRequest {
    pub source_url: String,
    pub output_dir: Option<String>,
    pub resource: DownloadResource,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct YtDlpDownloadRequest {
    pub source_url: String,
    pub output_dir: Option<String>,
    pub title: Option<String>,
    pub quality_height: Option<u64>,
    pub subtitle_language: Option<String>,
    #[serde(default)]
    pub subtitle_automatic: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DownloadResult {
    pub resource_id: String,
    pub path: String,
    pub size_bytes: u64,
    pub subtitle_paths: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DownloadProgress {
    pub resource_id: String,
    pub file_name: String,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub progress: f32,
    pub eta_seconds: Option<u64>,
    pub speed_bytes_per_second: Option<u64>,
}

pub fn analyze(input: &str) -> Result<DownloadAnalysis, String> {
    let url = parse_remote_url(input)?;

    if let Some(analysis) = analyze_with_yt_dlp(&url) {
        if !analysis.video_options.is_empty()
            || !analysis.resources.is_empty()
            || !analysis.subtitle_languages.is_empty()
            || !analysis.subtitles.is_empty()
        {
            return Ok(analysis);
        }
    }

    analyze_with_builtin_parser(&url)
}

pub fn download_with_progress<F>(
    request: DownloadRequest,
    mut on_progress: F,
) -> Result<DownloadResult, String>
where
    F: FnMut(DownloadProgress),
{
    let resource_url = parse_remote_url(&request.resource.url)?;
    let output_dir =
        crate::storage::ensure_output_subdir(request.output_dir.as_deref(), "downloads")
            .map_err(|error| error.to_string())?;
    let extension = download_extension(&request.resource);
    let title = request
        .title
        .as_deref()
        .map(sanitize_file_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| file_stem_from_url(&resource_url));
    let output_path = unique_output_path(&output_dir, &title, &extension);
    let file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .to_string();

    if is_manifest_resource(&request.resource) {
        download_manifest(&request, &output_path, &file_name, &mut on_progress)?;
    } else {
        download_direct(
            &request,
            &resource_url,
            &output_path,
            &file_name,
            &mut on_progress,
        )?;
    }

    let size_bytes = fs::metadata(&output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    on_progress(progress(
        &request.resource.id,
        &file_name,
        "completed",
        size_bytes,
        Some(size_bytes),
    ));

    Ok(DownloadResult {
        resource_id: request.resource.id,
        path: output_path.to_string_lossy().to_string(),
        size_bytes,
        subtitle_paths: Vec::new(),
        warnings: Vec::new(),
    })
}

pub fn download_page_with_yt_dlp<F>(
    request: YtDlpDownloadRequest,
    on_progress: F,
) -> Result<DownloadResult, String>
where
    F: FnMut(DownloadProgress),
{
    let yt_dlp = yt_dlp_path().ok_or_else(|| "未找到 yt-dlp。".to_string())?;
    download_page_with_yt_dlp_command(request, &yt_dlp, on_progress)
}

fn download_page_with_yt_dlp_command<F>(
    request: YtDlpDownloadRequest,
    yt_dlp: &Path,
    mut on_progress: F,
) -> Result<DownloadResult, String>
where
    F: FnMut(DownloadProgress),
{
    let source_url = parse_remote_url(&request.source_url)?;
    let output_dir =
        crate::storage::ensure_output_subdir(request.output_dir.as_deref(), "downloads")
            .map_err(|error| error.to_string())?;
    let title = request
        .title
        .as_deref()
        .map(sanitize_file_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| file_stem_from_url(&source_url));
    let output_path = unique_output_path(&output_dir, &title, "mp4");
    let output_stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .to_string();
    let file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download.mp4")
        .to_string();
    let format_selector = yt_dlp_format_selector(request.quality_height);

    on_progress(progress("yt-dlp-video", &file_name, "preparing", 0, None));

    let mut command = crate::process::background_command(yt_dlp);
    command
        .args([
            "--ignore-config",
            "--no-playlist",
            "--no-warnings",
            "--newline",
            "--continue",
            "--part",
            "--progress-template",
            "download:intervox-progress:%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.eta)s|%(progress.speed)s",
            "--merge-output-format",
            "mp4",
            "--ffmpeg-location",
        ])
        .arg(crate::export::ffmpeg_path())
        .arg("-f")
        .arg(format_selector)
        .arg("-o")
        .arg(&output_path);

    command.arg(source_url.as_str());
    run_yt_dlp_video_download(&mut command, &file_name, &mut on_progress)?;

    let final_path = if output_path.is_file() {
        output_path.clone()
    } else {
        find_downloaded_media_path(&output_dir, &output_stem)
            .ok_or_else(|| "yt-dlp 已结束，但未找到下载后的视频文件。".to_string())?
    };
    let mut warnings = Vec::new();
    if let Some(language) = request
        .subtitle_language
        .as_deref()
        .map(str::trim)
        .filter(|language| !language.is_empty())
    {
        on_progress(progress("yt-dlp-video", &file_name, "subtitles", 0, None));
        let mut subtitle_command = crate::process::background_command(yt_dlp);
        subtitle_command.args([
            "--ignore-config",
            "--no-playlist",
            "--no-warnings",
            "--skip-download",
        ]);
        subtitle_command.arg(if request.subtitle_automatic {
            "--write-auto-subs"
        } else {
            "--write-subs"
        });
        let subtitle_output = subtitle_command
            .args(["--sub-langs", language, "--sub-format", "srt/vtt/best"])
            .arg("-o")
            .arg(&output_path)
            .arg(source_url.as_str())
            .output();
        match subtitle_output {
            Ok(output) if !output.status.success() => warnings.push(format!(
                "视频已下载，但字幕下载失败：{}",
                yt_dlp_error_summary(&output.stderr)
            )),
            Err(error) => warnings.push(format!("视频已下载，但无法启动字幕下载：{error}")),
            _ => {}
        }
    }
    let size_bytes = fs::metadata(&final_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    on_progress(progress(
        "yt-dlp-video",
        &file_name,
        "completed",
        size_bytes,
        Some(size_bytes),
    ));

    Ok(DownloadResult {
        resource_id: "yt-dlp-video".to_string(),
        path: final_path.to_string_lossy().to_string(),
        size_bytes,
        subtitle_paths: find_downloaded_subtitle_paths(&output_dir, &output_stem),
        warnings,
    })
}

fn analyze_with_builtin_parser(url: &Url) -> Result<DownloadAnalysis, String> {
    let mut resources = Vec::new();
    let mut subtitles = Vec::new();
    let mut seen = HashSet::new();

    add_discovered_url(
        url,
        url.as_str(),
        "builtin",
        None,
        None,
        &mut resources,
        &mut subtitles,
        &mut seen,
    );

    if !resources.is_empty() || !subtitles.is_empty() {
        return Ok(DownloadAnalysis {
            source_url: url.to_string(),
            title: file_stem_from_url(url),
            extractor: "builtin-direct".to_string(),
            duration_seconds: None,
            thumbnail_url: None,
            video_options: Vec::new(),
            subtitle_languages: Vec::new(),
            resources,
            subtitles,
            message: "已识别为可直接下载的媒体或字幕链接。".to_string(),
        });
    }

    let client = http_client()?;
    let response = client
        .get(url.clone())
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .map_err(|error| format!("无法读取网页：{error}"))?
        .error_for_status()
        .map_err(|error| format!("网页请求失败：{error}"))?;
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if is_media_content_type(&content_type) || is_subtitle_content_type(&content_type) {
        let resource = resource_from_content_type(url, &content_type);
        if resource.kind == "subtitle" {
            add_resource(resource, &mut subtitles, &mut seen);
        } else {
            add_resource(resource, &mut resources, &mut seen);
        }
        return Ok(DownloadAnalysis {
            source_url: url.to_string(),
            title: file_stem_from_url(url),
            extractor: "builtin-direct".to_string(),
            duration_seconds: None,
            thumbnail_url: None,
            video_options: Vec::new(),
            subtitle_languages: Vec::new(),
            resources,
            subtitles,
            message: "服务器返回了可直接下载的媒体资源。".to_string(),
        });
    }

    let mut body = String::new();
    response
        .take(MAX_PAGE_BYTES)
        .read_to_string(&mut body)
        .map_err(|error| format!("读取网页内容失败：{error}"))?;
    let title = extract_html_title(&body).unwrap_or_else(|| file_stem_from_url(url));

    for candidate in extract_url_candidates(&body) {
        add_discovered_url(
            url,
            &candidate,
            "builtin-html",
            None,
            None,
            &mut resources,
            &mut subtitles,
            &mut seen,
        );
        if resources.len() + subtitles.len() >= MAX_RESOURCES {
            break;
        }
    }

    let message = if resources.is_empty() && subtitles.is_empty() {
        "网页中未发现可直接下载的媒体或字幕链接。如果当前仍显示 builtin-html，说明 yt-dlp 未找到或站点解析失败。"
    } else {
        "已从网页源码中提取可下载资源。动态加载或需要登录的视频站可安装 yt-dlp 以增强解析。"
    };

    Ok(DownloadAnalysis {
        source_url: url.to_string(),
        title,
        extractor: "builtin-html".to_string(),
        duration_seconds: None,
        thumbnail_url: None,
        video_options: Vec::new(),
        subtitle_languages: Vec::new(),
        resources,
        subtitles,
        message: message.to_string(),
    })
}

fn analyze_with_yt_dlp(url: &Url) -> Option<DownloadAnalysis> {
    let yt_dlp = yt_dlp_path()?;
    let output = crate::process::background_command(yt_dlp)
        .args([
            "--ignore-config",
            "--dump-single-json",
            "--no-playlist",
            "--skip-download",
            "--no-warnings",
        ])
        .arg(url.as_str())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let document: Value = serde_json::from_slice(&output.stdout).ok()?;
    let title = document
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| url.domain().unwrap_or("download"))
        .to_string();
    let video_options = yt_dlp_video_options(&document);
    let subtitle_languages = yt_dlp_subtitle_languages(&document);

    Some(DownloadAnalysis {
        source_url: url.to_string(),
        title,
        extractor: "yt-dlp".to_string(),
        duration_seconds: document.get("duration").and_then(Value::as_u64),
        thumbnail_url: document
            .get("thumbnail")
            .and_then(Value::as_str)
            .map(str::to_string),
        video_options,
        subtitle_languages,
        resources: Vec::new(),
        subtitles: Vec::new(),
        message: "已使用本机 yt-dlp 增强解析。请仅下载您有权保存的内容。".to_string(),
    })
}

fn add_discovered_url(
    base_url: &Url,
    candidate: &str,
    source: &str,
    language: Option<&str>,
    label: Option<&str>,
    resources: &mut Vec<DownloadResource>,
    subtitles: &mut Vec<DownloadResource>,
    seen: &mut HashSet<String>,
) {
    let normalized = decode_html_url(candidate);
    let Ok(url) = base_url.join(normalized.trim()) else {
        return;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }

    let Some(extension) = extension_for_url(url.as_str()) else {
        return;
    };
    let kind = if is_subtitle_extension(extension) {
        "subtitle"
    } else if is_media_extension(extension) {
        "media"
    } else {
        return;
    };
    let resource = DownloadResource {
        id: resource_id(kind, url.as_str(), None),
        kind: kind.to_string(),
        url: url.to_string(),
        label: label
            .map(str::to_string)
            .unwrap_or_else(|| default_resource_label(extension, url.as_str())),
        extension: extension.to_string(),
        protocol: protocol_for_url(url.as_str()).to_string(),
        language: language.map(str::to_string),
        size_bytes: None,
        format_id: None,
        source: source.to_string(),
    };

    if kind == "subtitle" {
        add_resource(resource, subtitles, seen);
    } else {
        add_resource(resource, resources, seen);
    }
}

fn add_resource(
    resource: DownloadResource,
    destination: &mut Vec<DownloadResource>,
    seen: &mut HashSet<String>,
) {
    if destination.len() >= MAX_RESOURCES || !seen.insert(resource.url.clone()) {
        return;
    }
    destination.push(resource);
}

fn download_direct<F>(
    request: &DownloadRequest,
    url: &Url,
    output_path: &Path,
    file_name: &str,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(DownloadProgress),
{
    let client = download_client()?;
    let mut response = client
        .get(url.clone())
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, request.source_url.as_str())
        .send()
        .map_err(|error| format!("下载请求失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载请求失败：{error}"))?;
    let total_bytes = response.content_length();
    let temp_path = output_path.with_file_name(format!("{file_name}.part"));
    let mut file =
        File::create(&temp_path).map_err(|error| format!("无法创建下载文件：{error}"))?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut downloaded_bytes = 0_u64;

    on_progress(progress(
        &request.resource.id,
        file_name,
        "started",
        0,
        total_bytes,
    ));

    let result = (|| -> Result<(), String> {
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(|error| format!("读取下载内容失败：{error}"))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .map_err(|error| format!("写入下载文件失败：{error}"))?;
            downloaded_bytes += read as u64;
            on_progress(progress(
                &request.resource.id,
                file_name,
                "downloading",
                downloaded_bytes,
                total_bytes,
            ));
        }
        file.flush()
            .map_err(|error| format!("保存下载文件失败：{error}"))?;
        fs::rename(&temp_path, output_path)
            .map_err(|error| format!("保存下载文件失败：{error}"))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn download_manifest<F>(
    request: &DownloadRequest,
    output_path: &Path,
    file_name: &str,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(DownloadProgress),
{
    on_progress(progress(&request.resource.id, file_name, "muxing", 0, None));

    let mut command = crate::process::background_command(crate::export::ffmpeg_path());
    command
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .arg("-user_agent")
        .arg(USER_AGENT_VALUE)
        .arg("-referer")
        .arg(&request.source_url)
        .arg("-i")
        .arg(&request.resource.url)
        .args(["-c", "copy"])
        .arg(output_path);
    let output = command
        .output()
        .map_err(|error| format!("无法启动 FFmpeg 下载流媒体：{error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let _ = fs::remove_file(output_path);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "FFmpeg 下载流媒体失败：{}",
        stderr.lines().rev().take(8).collect::<Vec<_>>().join("\n")
    ))
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("无法初始化网络客户端：{error}"))
}

fn download_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("无法初始化下载客户端：{error}"))
}

fn parse_remote_url(input: &str) -> Result<Url, String> {
    let url =
        Url::parse(input.trim()).map_err(|_| "请输入有效的 http 或 https URL。".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("仅支持 http 或 https URL。".to_string());
    }
    Ok(url)
}

fn extract_url_candidates(html: &str) -> Vec<String> {
    let decoded = decode_html_url(html);
    decoded
        .split(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'
                )
        })
        .map(|candidate| {
            candidate
                .trim_matches(|character: char| {
                    matches!(character, ':' | '=' | '\\' | '`') || character.is_whitespace()
                })
                .to_string()
        })
        .filter(|candidate| extension_for_url(candidate).is_some())
        .collect()
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let title_start = lower.find("<title")?;
    let text_start = lower[title_start..].find('>')? + title_start + 1;
    let text_end = lower[text_start..].find("</title>")? + text_start;
    let title = decode_html_text(&html[text_start..text_end]);
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn decode_html_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn decode_html_url(value: &str) -> String {
    decode_html_text(value)
        .replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("\\u003d", "=")
}

fn extension_for_url(value: &str) -> Option<&str> {
    let path = value
        .split(['?', '#'])
        .next()
        .unwrap_or(value)
        .trim_end_matches('/');
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "flv" | "ts" | "mp3" | "m4a" | "aac"
        | "wav" | "flac" | "m3u8" | "mpd" | "vtt" | "srt" | "ass" | "ssa" | "ttml" | "dfxp" => {
            Some(match extension.as_str() {
                "mp4" => "mp4",
                "m4v" => "m4v",
                "mov" => "mov",
                "mkv" => "mkv",
                "webm" => "webm",
                "avi" => "avi",
                "flv" => "flv",
                "ts" => "ts",
                "mp3" => "mp3",
                "m4a" => "m4a",
                "aac" => "aac",
                "wav" => "wav",
                "flac" => "flac",
                "m3u8" => "m3u8",
                "mpd" => "mpd",
                "vtt" => "vtt",
                "srt" => "srt",
                "ass" => "ass",
                "ssa" => "ssa",
                "ttml" => "ttml",
                "dfxp" => "dfxp",
                _ => unreachable!(),
            })
        }
        _ => None,
    }
}

fn is_media_extension(extension: &str) -> bool {
    matches!(
        extension,
        "mp4"
            | "m4v"
            | "mov"
            | "mkv"
            | "webm"
            | "avi"
            | "flv"
            | "ts"
            | "mp3"
            | "m4a"
            | "aac"
            | "wav"
            | "flac"
            | "m3u8"
            | "mpd"
    )
}

fn is_subtitle_extension(extension: &str) -> bool {
    matches!(extension, "vtt" | "srt" | "ass" | "ssa" | "ttml" | "dfxp")
}

fn is_manifest_extension(extension: &str) -> bool {
    matches!(extension, "m3u8" | "mpd")
}

fn is_manifest_resource(resource: &DownloadResource) -> bool {
    is_manifest_extension(&resource.extension)
        || resource.protocol.to_ascii_lowercase().contains("m3u8")
        || resource.protocol.to_ascii_lowercase().contains("hls")
        || resource.protocol.to_ascii_lowercase().contains("dash")
}

fn is_media_content_type(content_type: &str) -> bool {
    content_type.starts_with("video/")
        || content_type.starts_with("audio/")
        || content_type.contains("mpegurl")
        || content_type.contains("dash+xml")
}

fn is_subtitle_content_type(content_type: &str) -> bool {
    content_type.contains("text/vtt")
        || content_type.contains("subrip")
        || content_type.contains("ttml")
}

fn protocol_for_url(url: &str) -> &str {
    match extension_for_url(url) {
        Some("m3u8") => "hls",
        Some("mpd") => "dash",
        _ if url.starts_with("https://") => "https",
        _ => "http",
    }
}

fn default_resource_label(extension: &str, url: &str) -> String {
    let protocol = protocol_for_url(url).to_ascii_uppercase();
    if is_subtitle_extension(extension) {
        format!("字幕文件 · {}", extension.to_ascii_uppercase())
    } else {
        format!("{protocol} 媒体 · {}", extension.to_ascii_uppercase())
    }
}

fn resource_from_content_type(url: &Url, content_type: &str) -> DownloadResource {
    let extension =
        extension_for_url(url.as_str()).unwrap_or_else(|| extension_for_content_type(content_type));
    let kind = if is_subtitle_content_type(content_type) || is_subtitle_extension(extension) {
        "subtitle"
    } else {
        "media"
    };
    DownloadResource {
        id: resource_id(kind, url.as_str(), None),
        kind: kind.to_string(),
        url: url.to_string(),
        label: default_resource_label(extension, url.as_str()),
        extension: extension.to_string(),
        protocol: protocol_for_url(url.as_str()).to_string(),
        language: None,
        size_bytes: None,
        format_id: None,
        source: "builtin-content-type".to_string(),
    }
}

fn extension_for_content_type(content_type: &str) -> &'static str {
    if content_type.contains("mpegurl") {
        "m3u8"
    } else if content_type.contains("dash+xml") {
        "mpd"
    } else if content_type.contains("text/vtt") {
        "vtt"
    } else if content_type.contains("subrip") {
        "srt"
    } else if content_type.contains("audio/mpeg") {
        "mp3"
    } else if content_type.contains("audio/") {
        "m4a"
    } else {
        "mp4"
    }
}

fn yt_dlp_video_options(document: &Value) -> Vec<VideoDownloadOption> {
    let Some(formats) = document.get("formats").and_then(Value::as_array) else {
        return Vec::new();
    };
    let best_audio_size = formats
        .iter()
        .filter(|format| format_codec(format, "vcodec") == "none")
        .filter(|format| format_codec(format, "acodec") != "none")
        .filter_map(format_size)
        .max();
    let mut sizes_by_height = BTreeMap::<u64, Option<u64>>::new();

    for format in formats {
        let Some(height) = format.get("height").and_then(Value::as_u64) else {
            continue;
        };
        if format_codec(format, "vcodec") == "none" {
            continue;
        }
        let combined_size = format_size(format)
            .map(|video_size| video_size.saturating_add(best_audio_size.unwrap_or_default()));
        let entry = sizes_by_height.entry(height).or_insert(combined_size);
        if combined_size.unwrap_or_default() > entry.unwrap_or_default() {
            *entry = combined_size;
        }
    }

    let mut options = sizes_by_height
        .into_iter()
        .rev()
        .map(|(height, size_bytes)| VideoDownloadOption {
            id: format!("video-{height}p"),
            label: format!("{height}p · MP4"),
            height,
            extension: "mp4".to_string(),
            size_bytes,
            recommended: false,
        })
        .collect::<Vec<_>>();
    if let Some(option) = options.first_mut() {
        option.recommended = true;
        option.label.push_str(" · 最高画质");
    }
    options
}

fn yt_dlp_subtitle_languages(document: &Value) -> Vec<SubtitleLanguageOption> {
    let mut languages = BTreeMap::<String, SubtitleLanguageOption>::new();
    add_subtitle_languages(document.get("subtitles"), false, &mut languages);
    add_subtitle_languages(document.get("automatic_captions"), true, &mut languages);
    let mut options = languages.into_values().collect::<Vec<_>>();
    options.sort_by(|left, right| {
        subtitle_language_priority(&left.language)
            .cmp(&subtitle_language_priority(&right.language))
            .then_with(|| left.label.cmp(&right.label))
    });
    options
}

fn add_subtitle_languages(
    value: Option<&Value>,
    automatic: bool,
    languages: &mut BTreeMap<String, SubtitleLanguageOption>,
) {
    let Some(entries_by_language) = value.and_then(Value::as_object) else {
        return;
    };

    for (language, entries) in entries_by_language {
        if languages.contains_key(language) {
            continue;
        }
        let display_name = entries
            .as_array()
            .and_then(|entries| entries.first())
            .and_then(|entry| entry.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| subtitle_language_name(language).to_string());
        let suffix = if automatic { "自动字幕" } else { "字幕" };
        languages.insert(
            language.to_string(),
            SubtitleLanguageOption {
                id: format!("subtitle-{language}"),
                language: language.to_string(),
                label: format!("{display_name} ({language}) · {suffix}"),
                automatic,
            },
        );
    }
}

fn subtitle_language_name(language: &str) -> &str {
    match language {
        "en" => "English",
        "zh" | "zh-CN" | "zh-Hans" => "中文（简体）",
        "zh-TW" | "zh-Hant" => "中文（繁体）",
        "ja" => "日本語",
        "ko" => "한국어",
        "de" => "Deutsch",
        "fr" => "Français",
        "es" => "Español",
        _ => language,
    }
}

fn subtitle_language_priority(language: &str) -> (u8, &str) {
    let priority = match language {
        "en" => 0,
        "zh" | "zh-CN" | "zh-Hans" => 1,
        "zh-TW" | "zh-Hant" => 2,
        "ja" => 3,
        "ko" => 4,
        _ => 10,
    };
    (priority, language)
}

fn format_codec<'a>(format: &'a Value, field: &str) -> &'a str {
    format.get(field).and_then(Value::as_str).unwrap_or("none")
}

fn format_size(format: &Value) -> Option<u64> {
    format
        .get("filesize")
        .or_else(|| format.get("filesize_approx"))
        .and_then(Value::as_u64)
}

fn yt_dlp_format_selector(height: Option<u64>) -> String {
    let height_filter = height
        .map(|height| format!("[height<={height}]"))
        .unwrap_or_default();
    format!(
        "bestvideo{height_filter}[ext=mp4]+bestaudio[ext=m4a]/best{height_filter}[ext=mp4]/bestvideo{height_filter}+bestaudio/best{height_filter}"
    )
}

fn yt_dlp_error_summary(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let lines = stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n")
}

fn run_yt_dlp_video_download<F>(
    command: &mut Command,
    file_name: &str,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(DownloadProgress),
{
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 yt-dlp 下载：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 yt-dlp 下载进度。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 yt-dlp 错误输出。".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(progress) = parse_yt_dlp_progress_line(&line, file_name) {
            on_progress(progress);
        } else if line.starts_with("[Merger]") {
            on_progress(progress("yt-dlp-video", file_name, "muxing", 0, None));
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("等待 yt-dlp 下载完成失败：{error}"))?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "yt-dlp 下载失败：{}",
            yt_dlp_error_summary(&stderr)
        ))
    }
}

fn parse_yt_dlp_progress_line(line: &str, file_name: &str) -> Option<DownloadProgress> {
    let payload = line.trim().strip_prefix(YT_DLP_PROGRESS_PREFIX)?;
    let mut fields = payload.split('|');
    let status = fields.next()?;
    let downloaded_bytes = parse_yt_dlp_u64(fields.next()).unwrap_or_default();
    let total_bytes = parse_yt_dlp_u64(fields.next());
    let estimated_total_bytes = parse_yt_dlp_u64(fields.next());
    let total_bytes = total_bytes.or(estimated_total_bytes);
    let eta_seconds = parse_yt_dlp_u64(fields.next());
    let speed_bytes_per_second = parse_yt_dlp_u64(fields.next());
    let stage = if status == "finished" || status == "downloading" {
        "downloading"
    } else {
        "preparing"
    };
    let mut progress = progress(
        "yt-dlp-video",
        file_name,
        stage,
        downloaded_bytes,
        total_bytes,
    );
    progress.eta_seconds = eta_seconds;
    progress.speed_bytes_per_second = speed_bytes_per_second;
    Some(progress)
}

fn parse_yt_dlp_u64(value: Option<&str>) -> Option<u64> {
    value?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.round() as u64)
}

fn find_downloaded_media_path(output_dir: &Path, stem: &str) -> Option<PathBuf> {
    find_downloaded_paths(output_dir, stem, is_media_extension)
        .into_iter()
        .next()
}

fn find_downloaded_subtitle_paths(output_dir: &Path, stem: &str) -> Vec<String> {
    find_downloaded_paths(output_dir, stem, is_subtitle_extension)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn find_downloaded_paths(
    output_dir: &Path,
    stem: &str,
    matches_extension: fn(&str) -> bool,
) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(output_dir) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .map(|value| value == stem || value.starts_with(&format!("{stem}.")))
                .unwrap_or(false)
        })
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|extension| matches_extension(&extension.to_ascii_lowercase()))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn resource_id(kind: &str, url: &str, qualifier: Option<&str>) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    kind.hash(&mut hasher);
    url.hash(&mut hasher);
    qualifier.hash(&mut hasher);
    format!("DL-{:x}", hasher.finish())
}

fn download_extension(resource: &DownloadResource) -> String {
    if is_manifest_resource(resource) {
        "mp4".to_string()
    } else {
        sanitize_extension(&resource.extension)
    }
}

fn sanitize_extension(extension: &str) -> String {
    let cleaned = extension
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned
    }
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, ' ' | '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    cleaned
        .trim_matches([' ', '.', '_'])
        .chars()
        .take(100)
        .collect()
}

fn file_stem_from_url(url: &Url) -> String {
    url.path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .and_then(|file_name| {
            file_name
                .rsplit_once('.')
                .map(|(stem, _)| stem)
                .or(Some(file_name))
        })
        .map(sanitize_file_name)
        .filter(|value| !value.is_empty())
        .or_else(|| url.domain().map(sanitize_file_name))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "download".to_string())
}

fn unique_output_path(output_dir: &Path, title: &str, extension: &str) -> PathBuf {
    let base = sanitize_file_name(title);
    let base = if base.is_empty() { "download" } else { &base };
    let first = output_dir.join(format!("{base}.{extension}"));
    if !first.exists() {
        return first;
    }
    for index in 2..10_000 {
        let candidate = output_dir.join(format!("{base}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    output_dir.join(format!("{base}-new.{extension}"))
}

fn progress(
    resource_id: &str,
    file_name: &str,
    stage: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) -> DownloadProgress {
    let progress = total_bytes
        .filter(|total| *total > 0)
        .map(|total| downloaded_bytes.min(total) as f32 / total as f32)
        .unwrap_or(0.0);
    DownloadProgress {
        resource_id: resource_id.to_string(),
        file_name: file_name.to_string(),
        stage: stage.to_string(),
        downloaded_bytes,
        total_bytes,
        progress,
        eta_seconds: None,
        speed_bytes_per_second: None,
    }
}

fn yt_dlp_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("YT_DLP_PATH").filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    bundled_yt_dlp_paths()
        .into_iter()
        .chain(
            [
                "/opt/homebrew/bin/yt-dlp",
                "/usr/local/bin/yt-dlp",
                "/usr/bin/yt-dlp",
            ]
            .iter()
            .map(PathBuf::from),
        )
        .find(|path| path.is_file())
        .or_else(|| {
            crate::process::background_command("yt-dlp")
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|_| PathBuf::from("yt-dlp"))
        })
}

fn bundled_yt_dlp_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(directory) = current_exe.parent() {
            paths.push(directory.join(if cfg!(target_os = "windows") {
                "yt-dlp.exe"
            } else {
                "yt-dlp"
            }));
        }
    }
    if let Some(file_name) = bundled_yt_dlp_file_name() {
        paths.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(file_name),
        );
    }
    paths
}

fn bundled_yt_dlp_file_name() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("yt-dlp-aarch64-apple-darwin");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("yt-dlp-x86_64-apple-darwin");
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("yt-dlp-x86_64-pc-windows-msvc.exe");
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_media_and_subtitle_urls_from_html() {
        let html = r#"
            <video src="/media/course.mp4"></video>
            <source src="https://cdn.example.com/playlist/master.m3u8?token=abc">
            <track src="/captions/zh-CN.vtt">
        "#;
        let urls = extract_url_candidates(html);
        assert!(urls.contains(&"/media/course.mp4".to_string()));
        assert!(
            urls.contains(&"https://cdn.example.com/playlist/master.m3u8?token=abc".to_string())
        );
        assert!(urls.contains(&"/captions/zh-CN.vtt".to_string()));
    }

    #[test]
    fn classifies_direct_media_and_subtitle_urls() {
        assert!(is_media_extension(
            extension_for_url("https://example.com/video.mp4?token=1").unwrap()
        ));
        assert!(is_media_extension(
            extension_for_url("https://example.com/live/master.m3u8").unwrap()
        ));
        assert!(is_subtitle_extension(
            extension_for_url("https://example.com/subtitle.srt").unwrap()
        ));
    }

    #[test]
    fn sanitizes_file_names_before_writing() {
        assert_eq!(
            sanitize_file_name("Course: 01 / Intro"),
            "Course_ 01 _ Intro"
        );
        assert_eq!(sanitize_extension("../../MP4"), "mp4");
    }

    #[test]
    fn output_names_do_not_overwrite_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("lesson.mp4"), b"one").unwrap();
        let path = unique_output_path(dir.path(), "lesson", "mp4");
        assert_eq!(path, dir.path().join("lesson-2.mp4"));
    }

    #[test]
    fn analyzes_direct_media_without_network_request() {
        let analysis = analyze("https://cdn.example.com/course/lesson.mp4?token=abc").unwrap();
        assert_eq!(analysis.extractor, "builtin-direct");
        assert_eq!(analysis.resources.len(), 1);
        assert_eq!(analysis.resources[0].extension, "mp4");
    }

    #[test]
    fn creates_downloadable_resource_from_media_content_type_without_extension() {
        let url = Url::parse("https://cdn.example.com/watch?id=42").unwrap();
        let resource = resource_from_content_type(&url, "video/mp4");
        assert_eq!(resource.kind, "media");
        assert_eq!(resource.extension, "mp4");
    }

    #[test]
    fn detects_yt_dlp_hls_protocol_as_manifest() {
        let resource = DownloadResource {
            id: "DL-test".to_string(),
            kind: "media".to_string(),
            url: "https://cdn.example.com/manifest?id=42".to_string(),
            label: "stream".to_string(),
            extension: "mp4".to_string(),
            protocol: "m3u8_native".to_string(),
            language: None,
            size_bytes: None,
            format_id: None,
            source: "yt-dlp".to_string(),
        };
        assert!(is_manifest_resource(&resource));
    }

    #[test]
    fn creates_one_yt_dlp_video_option_per_resolution() {
        let document = serde_json::json!({
            "formats": [
                {
                    "format_id": "sb0",
                    "height": 90,
                    "vcodec": "none",
                    "acodec": "none",
                    "ext": "mhtml"
                },
                {
                    "format_id": "140",
                    "vcodec": "none",
                    "acodec": "mp4a.40.2",
                    "filesize": 10
                },
                {
                    "format_id": "18",
                    "height": 360,
                    "vcodec": "avc1",
                    "acodec": "mp4a.40.2",
                    "filesize": 100
                },
                {
                    "format_id": "134",
                    "height": 360,
                    "vcodec": "avc1",
                    "acodec": "none",
                    "filesize": 120
                },
                {
                    "format_id": "137",
                    "height": 1080,
                    "vcodec": "avc1",
                    "acodec": "none",
                    "filesize": 500
                }
            ]
        });

        let options = yt_dlp_video_options(&document);
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].height, 1080);
        assert_eq!(options[0].size_bytes, Some(510));
        assert!(options[0].recommended);
        assert_eq!(options[1].height, 360);
        assert_eq!(options[1].size_bytes, Some(130));
    }

    #[test]
    fn deduplicates_yt_dlp_subtitle_languages_and_prefers_manual_tracks() {
        let document = serde_json::json!({
            "subtitles": {
                "en": [{ "name": "English" }]
            },
            "automatic_captions": {
                "zh-CN": [{ "name": "Chinese (Simplified)" }],
                "en": [{ "name": "English autogenerated" }]
            }
        });

        let languages = yt_dlp_subtitle_languages(&document);
        assert_eq!(languages.len(), 2);
        assert_eq!(languages[0].language, "en");
        assert!(!languages[0].automatic);
        assert_eq!(languages[1].language, "zh-CN");
        assert!(languages[1].automatic);
    }

    #[test]
    fn creates_yt_dlp_selector_for_requested_height() {
        let selector = yt_dlp_format_selector(Some(1080));
        assert!(selector.contains("bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]"));
        assert!(selector.ends_with("best[height<=1080]"));
    }

    #[test]
    fn yt_dlp_error_summary_preserves_the_order_of_recent_lines() {
        let stderr = (1..=14)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let summary = yt_dlp_error_summary(stderr.as_bytes());
        assert!(summary.starts_with("line-3\nline-4"));
        assert!(summary.ends_with("line-14"));
    }

    #[test]
    fn parses_streamed_yt_dlp_progress_with_estimated_total_size() {
        let progress = parse_yt_dlp_progress_line(
            "intervox-progress:downloading|524288|NA|1048576|12|262144.5",
            "lesson.mp4",
        )
        .unwrap();
        assert_eq!(progress.stage, "downloading");
        assert_eq!(progress.downloaded_bytes, 524_288);
        assert_eq!(progress.total_bytes, Some(1_048_576));
        assert_eq!(progress.progress, 0.5);
        assert_eq!(progress.eta_seconds, Some(12));
        assert_eq!(progress.speed_bytes_per_second, Some(262_145));
    }

    #[cfg(unix)]
    #[test]
    fn keeps_downloaded_video_when_optional_subtitle_request_is_rate_limited() {
        use std::os::unix::fs::PermissionsExt;

        let output_dir = tempfile::tempdir().unwrap();
        let fake_yt_dlp = output_dir.path().join("fake-yt-dlp");
        fs::write(
            &fake_yt_dlp,
            r#"#!/bin/sh
output=""
skip_download=0
continue_download=0
part_files=0
previous=""
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then
    output="$argument"
  fi
  if [ "$argument" = "--skip-download" ]; then
    skip_download=1
  fi
  if [ "$argument" = "--continue" ]; then
    continue_download=1
  fi
  if [ "$argument" = "--part" ]; then
    part_files=1
  fi
  previous="$argument"
done
if [ "$skip_download" = "1" ]; then
  echo "ERROR: Unable to download video subtitles for 'zh-Hans': HTTP Error 429: Too Many Requests" >&2
  exit 1
fi
if [ "$continue_download" != "1" ] || [ "$part_files" != "1" ]; then
  echo "missing resume flags" >&2
  exit 2
fi
echo "intervox-progress:downloading|5|10|10|1|5"
printf video > "$output"
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_yt_dlp).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_yt_dlp, permissions).unwrap();
        let mut events = Vec::new();

        let result = download_page_with_yt_dlp_command(
            YtDlpDownloadRequest {
                source_url: "https://www.youtube.com/watch?v=test".to_string(),
                output_dir: Some(output_dir.path().to_string_lossy().to_string()),
                title: Some("lesson".to_string()),
                quality_height: Some(1080),
                subtitle_language: Some("zh-Hans".to_string()),
                subtitle_automatic: true,
            },
            &fake_yt_dlp,
            |progress| events.push(progress),
        )
        .unwrap();

        assert_eq!(fs::read(&result.path).unwrap(), b"video");
        assert!(result.subtitle_paths.is_empty());
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("HTTP Error 429"));
        assert!(events
            .iter()
            .any(|event| event.stage == "downloading" && event.progress == 0.5));
        assert!(events.iter().any(|event| event.stage == "subtitles"));
        assert_eq!(events.last().unwrap().stage, "completed");
    }

    #[test]
    fn downloads_direct_media_into_downloads_directory() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 5\r\nConnection: close\r\n\r\nvideo",
                )
                .unwrap();
        });
        let output_dir = tempfile::tempdir().unwrap();
        let url = format!("http://{address}/lesson.mp4");
        let request = DownloadRequest {
            source_url: url.clone(),
            output_dir: Some(output_dir.path().to_string_lossy().to_string()),
            resource: DownloadResource {
                id: "DL-direct".to_string(),
                kind: "media".to_string(),
                url,
                label: "MP4".to_string(),
                extension: "mp4".to_string(),
                protocol: "http".to_string(),
                language: None,
                size_bytes: Some(5),
                format_id: None,
                source: "test".to_string(),
            },
            title: Some("lesson".to_string()),
        };
        let mut events = Vec::new();
        let result = download_with_progress(request, |progress| events.push(progress)).unwrap();
        server.join().unwrap();

        assert_eq!(fs::read(&result.path).unwrap(), b"video");
        assert_eq!(
            PathBuf::from(&result.path),
            output_dir.path().join("downloads").join("lesson.mp4")
        );
        assert_eq!(events.last().unwrap().stage, "completed");
    }

    #[test]
    fn bundled_yt_dlp_paths_include_current_platform_sidecar() {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert!(bundled_yt_dlp_paths()
            .iter()
            .any(|path| path.ends_with("binaries/yt-dlp-aarch64-apple-darwin")));

        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        assert!(bundled_yt_dlp_paths()
            .iter()
            .any(|path| path.ends_with("binaries/yt-dlp-x86_64-pc-windows-msvc.exe")));
    }
}
