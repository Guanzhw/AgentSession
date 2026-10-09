use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn main() {
    let ui = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../ui/dist");
    println!("cargo:rerun-if-changed={}", ui.display());
    let output = PathBuf::from(env::var("OUT_DIR").unwrap()).join("static");
    if output.exists() {
        fs::remove_dir_all(&output).unwrap();
    }
    fs::create_dir_all(&output).unwrap();
    if ui.join("index.html").is_file() {
        copy_tree(&ui, &output).unwrap();
    } else if env::var("PROFILE").as_deref() == Ok("release") {
        panic!("build the Svelte UI in v3/ui before creating a release binary");
    } else {
        fs::write(output.join("index.html"), "<!doctype html><title>AgentSession 3.0</title><main>Build v3/ui to view the Reader.</main>").unwrap();
    }
}
