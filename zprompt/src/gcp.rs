use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub struct Config {
    pub name: String,
    pub project: String,
    pub region: String,
}

/// Reads the active gcloud configuration from files, because running gcloud takes over a second.
pub fn active(home: &Path) -> Option<Config> {
    let dir = std::env::var_os("CLOUDSDK_CONFIG").map_or_else(|| home.join(".config/gcloud"), PathBuf::from);
    let name = match std::env::var("CLOUDSDK_ACTIVE_CONFIG_NAME") {
        Ok(name) if !name.is_empty() => name,
        _ => std::fs::read_to_string(dir.join("active_config")).ok()?.trim().to_owned(),
    };
    let ini = std::fs::read_to_string(dir.join("configurations").join(format!("config_{name}"))).ok()?;
    Some(Config {
        project: value(&ini, "core", "project"),
        region: value(&ini, "compute", "region"),
        name,
    })
}

fn value(ini: &str, section: &str, key: &str) -> String {
    let mut current = "";
    for line in ini.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
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
    fn reads_keys_by_section() {
        let ini = "[core]\naccount = me@example.com\nproject = shop\n\n[compute]\nregion = asia-southeast1\n";
        assert_eq!(value(ini, "core", "project"), "shop");
        assert_eq!(value(ini, "compute", "region"), "asia-southeast1");
        assert_eq!(value(ini, "compute", "project"), "");
    }
}
