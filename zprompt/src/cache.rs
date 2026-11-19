use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq)]
pub enum Freshness {
    Cached,
    Fresh,
}

impl Freshness {
    pub fn parse(arg: &str) -> Option<Self> {
        match arg {
            "cached" => Some(Self::Cached),
            "fresh" => Some(Self::Fresh),
            _ => None,
        }
    }
}

pub fn dir() -> PathBuf {
    let xdg = std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from);
    let home = || PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".cache");
    xdg.unwrap_or_else(home).join("zprompt")
}

pub fn file(kind: &str, key: impl Hash) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    dir().join(kind).join(format!("{:016x}", hasher.finish()))
}

pub fn read(file: &Path) -> String {
    std::fs::read_to_string(file).unwrap_or_default()
}

pub fn write(file: &Path, text: &str) {
    let temporary = file.with_extension(std::process::id().to_string());
    let _ = file.parent().map(std::fs::create_dir_all);
    if std::fs::write(&temporary, text).is_ok() && std::fs::rename(&temporary, file).is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}
