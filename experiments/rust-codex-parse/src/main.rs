use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn u64_bytes(value: usize) -> [u8; 8] {
    (value as u64).to_le_bytes()
}

fn field(hasher: &mut Sha256, value: &str) {
    let bytes = value.as_bytes();
    hasher.update((bytes.len() as u32).to_le_bytes());
    hasher.update(bytes);
}

#[cfg(windows)]
fn peak_rss() -> u64 {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let result = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    assert_ne!(result, 0, "GetProcessMemoryInfo failed");
    counters.PeakWorkingSetSize as u64
}

#[cfg(windows)]
fn cpu_ms() -> f64 {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    let result = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    assert_ne!(result, 0, "GetProcessTimes failed");
    let ticks = |time: FILETIME| ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
    (ticks(kernel) + ticks(user)) as f64 / 10_000.0
}

#[cfg(unix)]
fn peak_rss() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    assert_eq!(result, 0, "getrusage failed");
    #[cfg(target_os = "macos")]
    {
        usage.ru_maxrss as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        (usage.ru_maxrss as u64) * 1024
    }
}

#[cfg(unix)]
fn cpu_ms() -> f64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    assert_eq!(result, 0, "getrusage failed");
    let to_ms = |time: libc::timeval| time.tv_sec as f64 * 1000.0 + time.tv_usec as f64 / 1000.0;
    to_ms(usage.ru_utime) + to_ms(usage.ru_stime)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 || args[1] != "--manifest" {
        eprintln!("Usage: codex-parse-probe --manifest FILE");
        std::process::exit(2);
    }
    let manifest = fs::canonicalize(&args[2])?;
    let entries: Vec<String> = serde_json::from_slice(&fs::read(&manifest)?)?;
    if entries.iter().any(String::is_empty) {
        return Err("Manifest contains an empty path".into());
    }
    let base = manifest.parent().expect("manifest parent");
    let paths: Vec<PathBuf> = entries
        .iter()
        .map(|entry| {
            let path = Path::new(entry);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                base.join(path)
            }
        })
        .collect();
    let mut peak_rss_bytes = peak_rss();
    let started = Instant::now();
    let cpu_started = cpu_ms();
    let mut input_hash = Sha256::new();
    let mut output_hash = Sha256::new();
    let mut types: BTreeMap<String, usize> = BTreeMap::new();
    let (
        mut compressed_files,
        mut input_bytes,
        mut decoded_bytes,
        mut lines,
        mut records,
        mut malformed,
    ) = (0, 0, 0, 0, 0, 0);
    let (mut read_ms, mut decompress_ms, mut parse_ms) = (0.0, 0.0, 0.0);

    for (file_index, path) in paths.iter().enumerate() {
        let read_started = Instant::now();
        let source = fs::read(path)?;
        read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
        input_bytes += source.len();
        input_hash.update(u64_bytes(file_index));
        input_hash.update(u64_bytes(source.len()));
        input_hash.update(&source);

        let name = path.to_string_lossy().to_ascii_lowercase();
        let decoded = if name.ends_with(".jsonl.zst") {
            compressed_files += 1;
            let decompress_started = Instant::now();
            let result = zstd::stream::decode_all(source.as_slice())?;
            decompress_ms += decompress_started.elapsed().as_secs_f64() * 1000.0;
            result
        } else if name.ends_with(".jsonl") {
            source
        } else {
            return Err("Unsupported extension".into());
        };
        decoded_bytes += decoded.len();
        let parse_started = Instant::now();
        for (line_index, line) in decoded.split(|byte| *byte == b'\n').enumerate() {
            let text = std::str::from_utf8(line).ok().map(str::trim);
            if text == Some("") {
                continue;
            }
            lines += 1;
            let parsed = text.and_then(|text| serde_json::from_str::<Value>(text).ok());
            let object = parsed.as_ref().and_then(Value::as_object);
            let valid = object.is_some();
            let record_type = object
                .and_then(|row| row.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let payload_type = object
                .and_then(|row| row.get("payload"))
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if valid {
                records += 1;
                *types.entry(record_type.to_string()).or_default() += 1;
            } else {
                malformed += 1;
            }
            output_hash.update(u64_bytes(file_index));
            output_hash.update(u64_bytes(line_index));
            output_hash.update([u8::from(valid)]);
            output_hash.update(Sha256::digest(line));
            field(&mut output_hash, record_type);
            field(&mut output_hash, payload_type);
        }
        parse_ms += parse_started.elapsed().as_secs_f64() * 1000.0;
        peak_rss_bytes = peak_rss_bytes.max(peak_rss());
    }
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let cpu_elapsed_ms = cpu_ms() - cpu_started;
    let result = json!({
        "counts": { "files": paths.len(), "compressedFiles": compressed_files, "inputBytes": input_bytes,
            "decodedBytes": decoded_bytes, "lines": lines, "records": records, "malformed": malformed, "types": types },
        "inputSha256": format!("{:x}", input_hash.finalize()),
        "outputSha256": format!("{:x}", output_hash.finalize()),
        "timings": { "readMs": read_ms, "decompressMs": decompress_ms, "parseMs": parse_ms, "totalMs": total_ms, "cpuMs": cpu_elapsed_ms },
        "peakRssBytes": peak_rss_bytes
    });
    println!("{}", result);
    Ok(())
}
