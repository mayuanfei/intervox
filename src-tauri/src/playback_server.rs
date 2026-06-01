use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use uuid::Uuid;

static PLAYBACK_SERVER: OnceLock<Result<PlaybackServer, String>> = OnceLock::new();

struct PlaybackServer {
    port: u16,
    sources: Arc<Mutex<HashMap<String, PlaybackSource>>>,
}

#[derive(Clone)]
enum PlaybackSource {
    File(PathBuf),
    Directory(PathBuf),
}

pub fn register_playback_file(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("播放器预览文件不存在。".to_string());
    }

    let server = PLAYBACK_SERVER
        .get_or_init(PlaybackServer::start)
        .as_ref()
        .map_err(Clone::clone)?;
    let token = Uuid::new_v4().simple().to_string();
    server
        .sources
        .lock()
        .map_err(|_| "播放器媒体服务状态异常。".to_string())?
        .insert(token.clone(), PlaybackSource::File(path.to_path_buf()));

    Ok(format!("http://127.0.0.1:{}/media/{token}", server.port))
}

pub fn register_playback_directory(path: &Path, entrypoint: &str) -> Result<String, String> {
    if !is_safe_relative_path(Path::new(entrypoint)) || !path.join(entrypoint).is_file() {
        return Err("播放器流媒体入口不存在。".to_string());
    }

    let server = PLAYBACK_SERVER
        .get_or_init(PlaybackServer::start)
        .as_ref()
        .map_err(Clone::clone)?;
    let token = Uuid::new_v4().simple().to_string();
    server
        .sources
        .lock()
        .map_err(|_| "播放器媒体服务状态异常。".to_string())?
        .insert(token.clone(), PlaybackSource::Directory(path.to_path_buf()));

    Ok(format!(
        "http://127.0.0.1:{}/media/{token}/{entrypoint}",
        server.port
    ))
}

impl PlaybackServer {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("无法启动本机播放器媒体服务：{error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("无法读取播放器媒体服务端口：{error}"))?
            .port();
        let sources = Arc::new(Mutex::new(HashMap::new()));
        let server_sources = Arc::clone(&sources);

        thread::Builder::new()
            .name("intervox-playback-server".to_string())
            .spawn(move || {
                for stream in listener.incoming() {
                    match stream {
                        Ok(stream) => {
                            let sources = Arc::clone(&server_sources);
                            let _ = thread::Builder::new()
                                .name("intervox-playback-request".to_string())
                                .spawn(move || {
                                    if let Err(error) = handle_request(stream, &sources) {
                                        eprintln!("[playback_server] {error}");
                                    }
                                });
                        }
                        Err(error) => eprintln!("[playback_server] 接收请求失败：{error}"),
                    }
                }
            })
            .map_err(|error| format!("无法启动播放器媒体服务线程：{error}"))?;

        Ok(Self { port, sources })
    }
}

fn handle_request(
    mut stream: TcpStream,
    sources: &Arc<Mutex<HashMap<String, PlaybackSource>>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("无法读取播放器请求：{error}"))?,
    );
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| format!("无法读取播放器请求：{error}"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let request_path = request_parts.next().unwrap_or_default();

    let mut range_header = None;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| format!("无法读取播放器请求头：{error}"))?;
        if line == "\r\n" || line == "\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }

    if !matches!(method, "GET" | "HEAD") {
        return write_error_response(&mut stream, "405 Method Not Allowed");
    }

    let media_path = request_path
        .split('?')
        .next()
        .unwrap_or_default()
        .strip_prefix("/media/")
        .unwrap_or_default();
    let mut media_parts = media_path.split('/');
    let token = media_parts.next().unwrap_or_default();
    if token.is_empty() {
        return write_error_response(&mut stream, "404 Not Found");
    }
    let relative_path = media_parts.collect::<Vec<_>>().join("/");

    let source = sources
        .lock()
        .map_err(|_| "播放器媒体服务状态异常。".to_string())?
        .get(token)
        .cloned();
    let Some(source) = source else {
        return write_error_response(&mut stream, "404 Not Found");
    };
    let path = match source {
        PlaybackSource::File(path) if relative_path.is_empty() => path,
        PlaybackSource::Directory(path) if is_safe_relative_path(Path::new(&relative_path)) => {
            path.join(relative_path)
        }
        _ => return write_error_response(&mut stream, "404 Not Found"),
    };

    let mut file = File::open(&path).map_err(|error| format!("无法打开播放器预览：{error}"))?;
    let file_len = file
        .metadata()
        .map_err(|error| format!("无法读取播放器预览信息：{error}"))?
        .len();
    let range = match parse_range(range_header.as_deref(), file_len) {
        Ok(range) => range,
        Err(()) => {
            write!(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{file_len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .map_err(|error| format!("无法返回播放器范围错误：{error}"))?;
            return Ok(());
        }
    };
    let (status, start, end) = match range {
        Some((start, end)) => ("206 Partial Content", start, end),
        None => ("200 OK", 0, file_len.saturating_sub(1)),
    };
    let content_len = if file_len == 0 { 0 } else { end - start + 1 };

    write!(
        stream,
        "HTTP/1.1 {status}\r\nAccept-Ranges: bytes\r\nContent-Type: {}\r\nContent-Length: {content_len}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n",
        content_type(&path)
    )
    .map_err(|error| format!("无法返回播放器响应头：{error}"))?;
    if range.is_some() {
        write!(stream, "Content-Range: bytes {start}-{end}/{file_len}\r\n")
            .map_err(|error| format!("无法返回播放器范围响应头：{error}"))?;
    }
    write!(stream, "Connection: close\r\n\r\n")
        .map_err(|error| format!("无法结束播放器响应头：{error}"))?;

    if method == "HEAD" || content_len == 0 {
        return Ok(());
    }

    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("无法定位播放器预览片段：{error}"))?;
    match std::io::copy(&mut file.take(content_len), &mut stream) {
        Ok(_) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::ConnectionReset
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(format!("无法传输播放器预览片段：{error}")),
    }
}

fn parse_range(header: Option<&str>, file_len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else {
        return Ok(None);
    };
    let value = header.strip_prefix("bytes=").ok_or(())?;
    if file_len == 0 || value.contains(',') {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix_len = end.parse::<u64>().map_err(|_| ())?;
        if suffix_len == 0 {
            return Err(());
        }
        return Ok(Some((
            file_len.saturating_sub(suffix_len.min(file_len)),
            file_len - 1,
        )));
    }

    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= file_len {
        return Err(());
    }
    let end = if end.is_empty() {
        file_len - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(file_len - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mov" => "video/quicktime",
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        _ => "video/mp4",
    }
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn write_error_response(stream: &mut TcpStream, status: &str) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .map_err(|error| format!("无法返回播放器错误响应：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};

    #[test]
    fn parses_requested_byte_ranges() {
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Ok(Some((10, 19))));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Err(()));
    }

    #[test]
    fn accepts_only_safe_relative_stream_paths() {
        assert!(is_safe_relative_path(Path::new("index.m3u8")));
        assert!(is_safe_relative_path(Path::new(
            "segments/segment_00001.ts"
        )));
        assert!(!is_safe_relative_path(Path::new("")));
        assert!(!is_safe_relative_path(Path::new("../outside.ts")));
        assert!(!is_safe_relative_path(Path::new("/absolute.ts")));
    }

    #[test]
    fn serves_registered_files_with_range_support() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("preview.mp4");
        fs::write(&path, b"0123456789").unwrap();
        let url = register_playback_file(&path).unwrap();
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let request_path = url.split_once(address).unwrap().1;
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "GET {request_path} HTTP/1.1\r\nHost: {address}\r\nRange: bytes=2-5\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();

        assert!(response.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(response.contains("Content-Range: bytes 2-5/10\r\n"));
        assert!(response.ends_with("\r\n\r\n2345"));
    }

    #[test]
    fn serves_registered_hls_segments_with_stream_content_type() {
        let temp_dir = tempfile::tempdir().unwrap();
        fs::write(temp_dir.path().join("index.m3u8"), b"#EXTM3U").unwrap();
        fs::write(temp_dir.path().join("segment_00000.ts"), b"segment-data").unwrap();
        let url = register_playback_directory(temp_dir.path(), "index.m3u8").unwrap();
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let request_path = url
            .split_once(address)
            .unwrap()
            .1
            .replace("index.m3u8", "segment_00000.ts");
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "GET {request_path} HTTP/1.1\r\nHost: {address}\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("Content-Type: video/mp2t\r\n"));
        assert!(response.ends_with("\r\n\r\nsegment-data"));
    }
}
