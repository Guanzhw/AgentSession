//! Open the trusted numeric loopback URL using the platform's native launcher.
use std::process::{Command, Stdio};

pub fn open(port: u16) -> std::io::Result<()> {
    let url = format!("http://127.0.0.1:{port}");
    let mut command = if cfg!(windows) {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    } else if cfg!(target_os = "macos") {
        Command::new("open")
    } else {
        Command::new("xdg-open")
    };
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    std::thread::spawn(move || match child.wait() {
        Ok(status) if status.success() => {}
        Ok(status) => eprintln!("Default browser launcher exited with {status}"),
        Err(error) => eprintln!("Could not wait for the default browser launcher: {error}"),
    });
    Ok(())
}
