use crate::{cache_file, cache_read, cache_write, hash};
use saphyr::{LoadableYamlNode, Yaml};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

pub fn file_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

/// A pattern that starts with `*` matches a suffix, any other pattern matches the whole name.
pub fn has_any(names: &[String], patterns: &[&str]) -> bool {
    names.iter().any(|name| {
        patterns
            .iter()
            .any(|pattern| match pattern.strip_prefix('*') {
                Some(suffix) => name.ends_with(suffix),
                None => name == pattern,
            })
    })
}

pub fn which(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| {
            path.metadata()
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

/// Returns the venv name and the Python version when a venv is active.
pub fn python(cwd: &Path, fresh: bool) -> Option<(String, Option<String>)> {
    let interpreter = which("python").or_else(|| which("python3"));
    let venv_root = interpreter
        .as_deref()
        .and_then(Path::parent)
        .and_then(|bin| {
            [bin, bin.parent()?]
                .into_iter()
                .find(|dir| dir.join("pyvenv.cfg").is_file())
        })
        .map(Path::to_path_buf);
    let cfg = venv_root
        .and_then(|root| std::fs::read_to_string(root.join("pyvenv.cfg")).ok())
        .unwrap_or_default();
    let venv = cfg_value(&cfg, "prompt")
        .map(|prompt| prompt.trim_matches('"').to_owned())
        .or_else(venv_from_env)?;
    let version = match cfg_value(&cfg, "version_info").or_else(|| cfg_value(&cfg, "version")) {
        Some(version) => Some(version.to_owned()),
        None => tool_version("python", cwd, fresh),
    };
    Some((venv, version))
}

fn venv_from_env() -> Option<String> {
    ["VIRTUAL_ENV", "CONDA_ENV_PATH", "CONDA_DEFAULT_ENV"]
        .into_iter()
        .find_map(|var| {
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

/// Picks the workspace the way `terraform workspace show` does, without running terraform.
pub fn terraform_workspace(cwd: &Path) -> String {
    std::env::var("TF_WORKSPACE")
        .ok()
        .filter(|name| !name.is_empty())
        .or_else(|| {
            std::fs::read_to_string(cwd.join(".terraform/environment"))
                .ok()
                .map(|name| name.trim().to_owned())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "default".to_owned())
}

/// Returns the version of a tool on PATH. A mise shim takes about 35 ms, and over a second when it fetches a missing
/// version, so only a fresh render runs the tool, and only after a file that can select another version changed.
pub fn tool_version(tool: &str, cwd: &Path, fresh: bool) -> Option<String> {
    let bin = which(tool)?;
    let file = cache_file("versions", (tool, cwd));
    let cached = cache_read(&file);
    let (cached_stamp, cached_version) = cached.split_once('\n').unwrap_or_default();
    let cached_version = Some(cached_version.to_owned()).filter(|version| !version.is_empty());
    if !fresh {
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
    cache_write(
        &file,
        &format!("{stamp}\n{}", version.as_deref().unwrap_or_default()),
    );
    version
}

fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let word = word
            .strip_prefix("go")
            .or_else(|| word.strip_prefix('v'))
            .unwrap_or(word);
        let version: String = word
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        (version.contains('.') && version.starts_with(|c: char| c.is_ascii_digit()))
            .then_some(version)
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
    let modified = |path: &Path| {
        let time = path.metadata().and_then(|meta| meta.modified()).ok()?;
        Some(
            time.duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default(),
        )
    };
    let tool_env = format!("MISE_{}_VERSION", tool.to_uppercase());
    let env = [
        "PATH",
        "MISE_ENV",
        "GOTOOLCHAIN",
        "VIRTUAL_ENV",
        tool_env.as_str(),
    ]
    .map(std::env::var_os);
    let env_files: Vec<String> = std::env::var("MISE_ENV")
        .unwrap_or_default()
        .split(',')
        .filter(|env| !env.is_empty())
        .flat_map(|env| [format!("mise.{env}.toml"), format!("mise.{env}.local.toml")])
        .collect();
    let version_files: Vec<_> = cwd
        .ancestors()
        .flat_map(|dir| {
            VERSION_FILES
                .iter()
                .copied()
                .chain(env_files.iter().map(String::as_str))
                .map(|name| modified(&dir.join(name)))
        })
        .collect();
    let home = crate::home();
    let config = mise_dir("MISE_CONFIG_DIR", "XDG_CONFIG_HOME", &home.join(".config"));
    let data = mise_dir("MISE_DATA_DIR", "XDG_DATA_HOME", &home.join(".local/share"));
    let mise_files = [
        modified(&config.join("config.toml")),
        modified(&data.join("installs").join(tool)),
    ];
    format!(
        "{:016x}",
        hash((bin, modified(bin), cwd, env, version_files, mise_files))
    )
}

fn mise_dir(own: &str, xdg: &str, xdg_default: &Path) -> PathBuf {
    match std::env::var_os(own) {
        Some(dir) => PathBuf::from(dir),
        None => std::env::var_os(xdg)
            .map_or_else(|| xdg_default.to_path_buf(), PathBuf::from)
            .join("mise"),
    }
}

#[derive(Debug, PartialEq)]
pub struct KubeContext {
    pub name: String,
    pub namespace: Option<String>,
}

/// Reads the current context the way kubectl merges KUBECONFIG: the first file that sets a key wins.
pub fn kube(home: &Path) -> Option<KubeContext> {
    let files: Vec<PathBuf> = match std::env::var_os("KUBECONFIG") {
        Some(list) if !list.is_empty() => std::env::split_paths(&list).collect(),
        _ => vec![home.join(".kube/config")],
    };
    let mut current = None;
    let mut namespaces: Vec<(String, Option<String>)> = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Some(config) = Yaml::load_from_str(&content)
            .ok()
            .and_then(|docs| docs.into_iter().next())
        else {
            continue;
        };
        for entry in config
            .as_mapping_get("contexts")
            .and_then(Yaml::as_sequence)
            .into_iter()
            .flatten()
        {
            let Some(name) = entry.as_mapping_get("name").and_then(Yaml::as_str) else {
                continue;
            };
            if namespaces.iter().all(|(known, _)| known != name) {
                let namespace = entry
                    .as_mapping_get("context")
                    .and_then(|context| context.as_mapping_get("namespace"));
                namespaces.push((
                    name.to_owned(),
                    namespace.and_then(Yaml::as_str).map(str::to_owned),
                ));
            }
        }
        if current.as_deref().is_none_or(str::is_empty) {
            current = config
                .as_mapping_get("current-context")
                .and_then(Yaml::as_str)
                .map(str::to_owned);
        }
        let name = current.as_deref().unwrap_or_default();
        if let Some((_, namespace)) = namespaces.iter().find(|(known, _)| known == name) {
            return Some(KubeContext {
                name: name.to_owned(),
                namespace: namespace.clone().filter(|ns| !ns.is_empty()),
            });
        }
    }
    None
}

pub struct GcpConfig {
    pub name: String,
    pub project: String,
    pub region: String,
}

/// Reads the active gcloud configuration from files, because running gcloud takes over a second.
pub fn gcp(home: &Path) -> Option<GcpConfig> {
    let dir = std::env::var_os("CLOUDSDK_CONFIG")
        .map_or_else(|| home.join(".config/gcloud"), PathBuf::from);
    let name = match std::env::var("CLOUDSDK_ACTIVE_CONFIG_NAME") {
        Ok(name) if !name.is_empty() => name,
        _ => std::fs::read_to_string(dir.join("active_config"))
            .ok()?
            .trim()
            .to_owned(),
    };
    let ini =
        std::fs::read_to_string(dir.join("configurations").join(format!("config_{name}"))).ok()?;
    Some(GcpConfig {
        project: ini_value(&ini, "core", "project"),
        region: ini_value(&ini, "compute", "region"),
        name,
    })
}

fn ini_value(ini: &str, section: &str, key: &str) -> String {
    let mut current = "";
    for line in ini.lines().map(str::trim) {
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            current = name.trim();
        } else if current == section
            && let Some((name, value)) = line.split_once('=')
            && name.trim() == key
        {
            return value.trim().to_owned();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_output() {
        assert_eq!(parse_version("v24.11.1\n").as_deref(), Some("24.11.1"));
        assert_eq!(
            parse_version("go version go1.27.4 darwin/arm64\n").as_deref(),
            Some("1.27.4")
        );
        assert_eq!(parse_version("Python 3.15.2\n").as_deref(), Some("3.15.2"));
        assert_eq!(parse_version("command not found"), None);
    }

    #[test]
    fn matches_suffix_and_exact_patterns() {
        let names = ["main.go".to_owned(), ".nvmrc".to_owned()];
        assert!(has_any(&names, &["*.go"]));
        assert!(has_any(&names, &[".nvmrc"]));
        assert!(!has_any(&names, &["*.ts", "package.json"]));
    }

    #[test]
    fn reads_venv_config() {
        let cfg = "home = /usr/bin\nprompt = \"shop\"\nversion_info = 3.12.7\n";
        assert_eq!(cfg_value(cfg, "prompt"), Some("\"shop\""));
        assert_eq!(cfg_value(cfg, "version_info"), Some("3.12.7"));
        assert_eq!(cfg_value(cfg, "version"), None);
    }

    #[test]
    fn merges_kubeconfig_files_in_order() {
        let dir = std::env::temp_dir().join(format!("zprompt-kube-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("first");
        let second = dir.join("second");
        std::fs::write(&first, "current-context: prod\ncontexts: []\n").unwrap();
        std::fs::write(
            &second,
            "current-context: dev\ncontexts:\n- name: dev\n  context: {cluster: c}\n- name: prod\n  context:\n    cluster: c\n    namespace: shop\n",
        )
        .unwrap();
        unsafe {
            std::env::set_var(
                "KUBECONFIG",
                std::env::join_paths([&first, &second]).unwrap(),
            )
        };
        assert_eq!(
            kube(&dir),
            Some(KubeContext {
                name: "prod".into(),
                namespace: Some("shop".into())
            })
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_ini_keys_by_section() {
        let ini = "[core]\naccount = me@example.com\nproject = shop\n\n[compute]\nregion = asia-southeast1\n";
        assert_eq!(ini_value(ini, "core", "project"), "shop");
        assert_eq!(ini_value(ini, "compute", "region"), "asia-southeast1");
        assert_eq!(ini_value(ini, "compute", "project"), "");
    }
}
