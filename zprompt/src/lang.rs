use crate::cache::{self, Freshness};
use std::collections::hash_map::DefaultHasher;
use std::ffi::OsString;
use std::hash::{Hash, Hasher};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

pub struct Folder {
    names: Vec<OsString>,
}

impl Folder {
    pub fn read(cwd: &Path) -> Self {
        let names = std::fs::read_dir(cwd).into_iter().flatten().flatten().map(|entry| entry.file_name()).collect();
        Self { names }
    }

    pub fn has_any(&self, patterns: &[&str]) -> bool {
        self.names.iter().filter_map(|name| name.to_str()).any(|name| {
            patterns.iter().any(|pattern| match pattern.strip_prefix('*') {
                Some(suffix) => name.ends_with(suffix),
                None => name == *pattern,
            })
        })
    }
}

pub struct Python {
    pub venv: String,
    pub version: Option<String>,
}

pub fn python(cwd: &Path, freshness: Freshness) -> Option<Python> {
    let interpreter = which("python").or_else(|| which("python3"));
    let venv_root = interpreter
        .as_deref()
        .and_then(Path::parent)
        .and_then(|bin| [bin, bin.parent()?].into_iter().find(|dir| dir.join("pyvenv.cfg").is_file()))
        .map(Path::to_path_buf);
    let cfg = venv_root.and_then(|root| std::fs::read_to_string(root.join("pyvenv.cfg")).ok()).unwrap_or_default();
    let venv = cfg_value(&cfg, "prompt").map(|prompt| prompt.trim_matches('"').to_owned()).or_else(venv_from_env)?;
    let version = match cfg_value(&cfg, "version_info").or_else(|| cfg_value(&cfg, "version")) {
        Some(version) => Some(version.to_owned()),
        None => tool_version("python", cwd, freshness),
    };
    Some(Python { venv, version })
}

fn venv_from_env() -> Option<String> {
    ["VIRTUAL_ENV", "CONDA_ENV_PATH", "CONDA_DEFAULT_ENV"].into_iter().find_map(|var| {
        let path = PathBuf::from(std::env::var_os(var).filter(|value| !value.is_empty())?);
        let name = path.file_name()?.to_str()?;
        let folder = match name {
            ".venv" | "venv" => path.parent()?.file_name()?.to_str()?,
            _ => name,
        };
        Some(folder.to_owned())
    })
}

fn cfg_value<'a>(cfg: &'a str, key: &str) -> Option<&'a str> {
    cfg.lines().find_map(|line| {
        let (name, value) = line.split_once('=')?;
        (name.trim() == key).then(|| value.trim())
    })
}

/// Shows the terraform workspace the way `terraform workspace show` picks it, without running terraform.
pub fn terraform_workspace(cwd: &Path) -> String {
    std::env::var("TF_WORKSPACE")
        .ok()
        .filter(|name| !name.is_empty())
        .or_else(|| std::fs::read_to_string(cwd.join(".terraform/environment")).ok().map(|name| name.trim().to_owned()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "default".to_owned())
}

pub fn which(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| {
        path.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    })
}

/// Returns the version of a tool on PATH. A mise shim takes about 35 ms, and over a second when it fetches a missing
/// version, so only a `Fresh` render runs the tool, and only after a file that can select another version changed.
pub fn tool_version(tool: &str, cwd: &Path, freshness: Freshness) -> Option<String> {
    let bin = which(tool)?;
    let file = cache::file("versions", (tool, cwd));
    let cached = cache::read(&file);
    let (cached_stamp, cached_version) = cached.split_once('\n').unwrap_or_default();
    let cached_version = Some(cached_version.to_owned()).filter(|version| !version.is_empty());
    if freshness == Freshness::Cached {
        return cached_version;
    }
    let stamp = stamp(tool, &bin, cwd);
    if cached_stamp == stamp {
        return cached_version;
    }
    let flag = if tool == "go" { "version" } else { "--version" };
    let version = Command::new(&bin)
        .arg(flag)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| parse_version(&String::from_utf8_lossy(&output.stdout)));
    cache::write(&file, &format!("{stamp}\n{}", version.as_deref().unwrap_or_default()));
    version
}

fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let word = word.strip_prefix("go").or_else(|| word.strip_prefix('v')).unwrap_or(word);
        let version: String = word.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        (version.contains('.') && version.starts_with(|c: char| c.is_ascii_digit())).then_some(version)
    })
}

const VERSION_FILES: &[&str] = &[
    "mise.toml",
    ".mise.toml",
    "mise.local.toml",
    ".mise.local.toml",
    ".config/mise.toml",
    ".config/mise/config.toml",
    "mise/config.toml",
    ".mise/config.toml",
    ".tool-versions",
    ".nvmrc",
    ".node-version",
    ".python-version",
    "go.mod",
    "go.work",
];

fn stamp(tool: &str, bin: &Path, cwd: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    let modified = |path: &Path| path.metadata().and_then(|meta| meta.modified()).ok();
    let modified = |path: &Path| modified(path).map(|time| time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default());
    (bin, modified(bin), cwd).hash(&mut hasher);
    let tool_env = format!("MISE_{}_VERSION", tool.to_uppercase());
    for var in ["PATH", "MISE_ENV", "GOTOOLCHAIN", "VIRTUAL_ENV", &tool_env] {
        std::env::var_os(var).hash(&mut hasher);
    }
    let env_files: Vec<String> = std::env::var("MISE_ENV")
        .unwrap_or_default()
        .split(',')
        .filter(|env| !env.is_empty())
        .flat_map(|env| [format!("mise.{env}.toml"), format!("mise.{env}.local.toml")])
        .collect();
    for dir in cwd.ancestors() {
        for name in VERSION_FILES.iter().copied().chain(env_files.iter().map(String::as_str)) {
            modified(&dir.join(name)).hash(&mut hasher);
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let config = env_dir("MISE_CONFIG_DIR", "XDG_CONFIG_HOME", &home.join(".config"), "mise");
    let data = env_dir("MISE_DATA_DIR", "XDG_DATA_HOME", &home.join(".local/share"), "mise");
    modified(&config.join("config.toml")).hash(&mut hasher);
    modified(&data.join("installs").join(tool)).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn env_dir(own: &str, xdg: &str, xdg_default: &Path, name: &str) -> PathBuf {
    match std::env::var_os(own) {
        Some(dir) => PathBuf::from(dir),
        None => std::env::var_os(xdg).map_or_else(|| xdg_default.to_path_buf(), PathBuf::from).join(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_output() {
        assert_eq!(parse_version("v24.11.1\n").as_deref(), Some("24.11.1"));
        assert_eq!(parse_version("go version go1.27.4 darwin/arm64\n").as_deref(), Some("1.27.4"));
        assert_eq!(parse_version("Python 3.15.2\n").as_deref(), Some("3.15.2"));
        assert_eq!(parse_version("command not found"), None);
    }

    #[test]
    fn matches_suffix_and_exact_patterns() {
        let folder = Folder { names: vec!["main.go".into(), ".nvmrc".into()] };
        assert!(folder.has_any(&["*.go"]));
        assert!(folder.has_any(&[".nvmrc"]));
        assert!(!folder.has_any(&["*.ts", "package.json"]));
    }

    #[test]
    fn reads_venv_config() {
        let cfg = "home = /usr/bin\nprompt = \"shop\"\nversion_info = 3.12.7\n";
        assert_eq!(cfg_value(cfg, "prompt"), Some("\"shop\""));
        assert_eq!(cfg_value(cfg, "version_info"), Some("3.12.7"));
        assert_eq!(cfg_value(cfg, "version"), None);
    }
}
