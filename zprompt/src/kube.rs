use saphyr::{LoadableYamlNode, Yaml};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub struct Context {
    pub name: String,
    pub namespace: Option<String>,
}

/// Reads the current context the way kubectl merges KUBECONFIG: the first file that sets a key wins.
pub fn current(home: &Path) -> Option<Context> {
    let files: Vec<PathBuf> = match std::env::var_os("KUBECONFIG") {
        Some(list) if !list.is_empty() => std::env::split_paths(&list).collect(),
        _ => vec![home.join(".kube/config")],
    };
    let mut current = None;
    let mut namespaces: Vec<(String, Option<String>)> = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(&file) else { continue };
        let Some(config) = Yaml::load_from_str(&content).ok().and_then(|docs| docs.into_iter().next()) else {
            continue;
        };
        for entry in config.as_mapping_get("contexts").and_then(Yaml::as_sequence).into_iter().flatten() {
            let Some(name) = entry.as_mapping_get("name").and_then(Yaml::as_str) else { continue };
            if namespaces.iter().all(|(known, _)| known != name) {
                let namespace = entry.as_mapping_get("context").and_then(|context| context.as_mapping_get("namespace"));
                namespaces.push((name.to_owned(), namespace.and_then(Yaml::as_str).map(str::to_owned)));
            }
        }
        if current.as_deref().is_none_or(str::is_empty) {
            current = config.as_mapping_get("current-context").and_then(Yaml::as_str).map(str::to_owned);
        }
        let name = current.as_deref().unwrap_or_default();
        if let Some((_, namespace)) = namespaces.iter().find(|(known, _)| known == name) {
            return Some(Context { name: name.to_owned(), namespace: namespace.clone().filter(|ns| !ns.is_empty()) });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_files_in_order() {
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
        unsafe { std::env::set_var("KUBECONFIG", std::env::join_paths([&first, &second]).unwrap()) };
        assert_eq!(current(&dir), Some(Context { name: "prod".into(), namespace: Some("shop".into()) }));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
