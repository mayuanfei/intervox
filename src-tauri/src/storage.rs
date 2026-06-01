use std::fs;
use std::io;
use std::path::PathBuf;

pub fn configured_output_root(output_dir: Option<&str>) -> Result<PathBuf, io::Error> {
    output_dir
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "请先在设置中配置输出目录。"))
}

pub fn ensure_output_subdir(output_dir: Option<&str>, name: &str) -> Result<PathBuf, io::Error> {
    let dir = configured_output_root(output_dir)?.join(name);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_configured_output_root() {
        let error = configured_output_root(None).expect_err("missing output directory should fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn creates_subdirectories_under_configured_root() {
        let root = tempfile::tempdir().expect("temp output root");
        let dir = ensure_output_subdir(root.path().to_str(), "temp_audio").expect("temp audio dir");

        assert_eq!(dir, root.path().join("temp_audio"));
        assert!(dir.is_dir());
    }
}
