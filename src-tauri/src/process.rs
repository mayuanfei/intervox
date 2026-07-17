use std::ffi::OsStr;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Creates a command for work that should stay behind the Intervox window.
///
/// A GUI-subsystem parent does not prevent console-subsystem children such as
/// yt-dlp, FFmpeg, FFprobe, and whisper.cpp from opening their own console on
/// Windows. `CREATE_NO_WINDOW` keeps those child processes headless while
/// preserving their piped stdout and stderr.
#[cfg(target_os = "windows")]
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(target_os = "windows"))]
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}
