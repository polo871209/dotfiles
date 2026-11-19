use crate::cache::Freshness;
use crate::lang::{self, Folder};
use crate::style::{Color, Line};
use crate::{gcp, git, kube};
use std::path::{Path, PathBuf};

const WHITE: Color = Color::Ansi(37);
const BLUE: Color = Color::Ansi(34);
const GREY: Color = Color::Rgb(0x6c, 0x6c, 0x6c);
const BEHIND: Color = Color::Rgb(0xa1, 0x20, 0x36);
const AHEAD: Color = Color::Rgb(0x10, 0x85, 0x4e);
const KUBERNETES: Color = Color::Rgb(0x3a, 0x7b, 0xe1);
const PYTHON: Color = Color::Rgb(0xff, 0xd3, 0x43);
const GO: Color = Color::Rgb(0x00, 0xac, 0xd7);
const NODE: Color = Color::Rgb(0x41, 0x7e, 0x38);
const TERRAFORM: Color = Color::Rgb(0x62, 0x3c, 0xe4);
const GOOGLE_YELLOW: Color = Color::Rgb(0xff, 0xce, 0x44);
const GRUVBOX_BLUE: Color = Color::Rgb(0x83, 0xa5, 0x98);
const GRUVBOX_RED: Color = Color::Rgb(0xfb, 0x49, 0x34);

const PROMPT_CHAR: &str = "\u{f02a0}";

pub struct Request {
    pub freshness: Freshness,
    pub status: Option<i32>,
    pub last_status: i32,
    pub duration_ms: Option<u64>,
    pub columns: usize,
}

pub struct Rendered {
    pub left: String,
    pub right: String,
    pub transient: String,
}

pub fn render(request: &Request) -> Rendered {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let cwd = std::env::var_os("PWD").map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let (git, kube, right) = std::thread::scope(|scope| {
        let git = scope.spawn(|| git::status(&cwd, request.freshness));
        let kube = scope.spawn(|| kube::current(&home));
        let right = right_prompt(request, &cwd, &home);
        (git.join().ok().flatten(), kube.join().ok().flatten(), right)
    });

    let mut left = Line::default();
    finished_command_mark(&mut left, request);
    left.mark("A");
    left.paint(WHITE, "\u{e711} ");
    left.paint(BLUE, &display_path(&cwd, &home));
    if let Some(git) = git {
        let head = match git.head {
            git::Head::Branch(name) => name,
            git::Head::Detached(commit) => format!("detached at \u{f417}{commit}"),
        };
        left.paint(GREY, &format!(" \u{f418} {head}{} ", if git.changes.dirty { "*" } else { "" }));
        if git.changes.behind > 0 {
            left.paint(BEHIND, "\u{ea9a}");
        }
        if git.changes.ahead > 0 {
            left.paint(AHEAD, "\u{eaa1}");
        }
    }
    if let Some(kube) = kube {
        let mut context = Line::default();
        let namespace = kube.namespace.map(|ns| format!(":{ns}")).unwrap_or_default();
        context.paint(KUBERNETES, &format!(" \u{e81d} {}{namespace}", kube.name));
        if left.width + context.width < request.columns {
            left.visible(&" ".repeat(request.columns - left.width - context.width));
            left.text.push_str(&context.text);
        }
    }
    left.text.push('\n');
    left.paint(if request.last_status == 0 { GRUVBOX_BLUE } else { GRUVBOX_RED }, PROMPT_CHAR);
    left.visible(" ");
    left.mark("B");

    let mut transient = Line::default();
    finished_command_mark(&mut transient, request);
    transient.mark("A");
    transient.paint(GRUVBOX_BLUE, &format!("{PROMPT_CHAR} "));
    transient.mark("B");

    Rendered { left: left.text, right, transient: transient.text }
}

pub fn gcp_tooltip() -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let Some(config) = gcp::active(&home) else { return String::new() };
    let mut line = Line::default();
    line.paint(GOOGLE_YELLOW, &format!("\u{e7b2} {}:{}:{}", config.name, config.project, config.region));
    line.text
}

fn finished_command_mark(line: &mut Line, request: &Request) {
    match request.status {
        Some(status) => line.mark(&format!("D;{status}")),
        None => line.mark("D"),
    }
}

fn right_prompt(request: &Request, cwd: &Path, home: &Path) -> String {
    let freshness = request.freshness;
    let folder = Folder::read(cwd);
    let languages = cwd != home;
    let show_go = languages && folder.has_any(&["*.go", "go.mod", "go.sum", "go.work", "go.work.sum"]);
    let show_node = languages
        && folder.has_any(&["*.js", "*.ts", "package.json", ".nvmrc", "pnpm-workspace.yaml", ".pnpmfile.cjs", ".vue"]);
    let show_terraform = folder.has_any(&[".terraform", "*.tf", "*.tfplan", "*.tfstate"]) && lang::which("terraform").is_some();

    let (python, go, node) = std::thread::scope(|scope| {
        let python = scope.spawn(|| languages.then(|| lang::python(cwd, freshness)).flatten());
        let go = scope.spawn(|| show_go.then(|| lang::tool_version("go", cwd, freshness)).flatten());
        let node = show_node.then(|| lang::tool_version("node", cwd, freshness)).flatten();
        (python.join().ok().flatten(), go.join().ok().flatten(), node)
    });

    let mut right = Line::default();
    if let Some(python) = python {
        right.paint(PYTHON, &format!("{} \u{f0320} {}", python.venv, python.version.unwrap_or_default()));
    }
    if let Some(go) = go {
        right.paint(GO, &format!("\u{e627} {go}"));
    }
    if let Some(node) = node {
        right.paint(NODE, &format!("\u{e60c} {node}"));
    }
    if show_terraform {
        right.paint(TERRAFORM, &format!("\u{f1062} {}", lang::terraform_workspace(cwd)));
    }
    if let Some(ms) = request.duration_ms.filter(|ms| *ms >= 500) {
        right.paint(WHITE, &format!(" {} ", format_duration(ms)));
    }
    right.text
}

fn display_path(cwd: &Path, home: &Path) -> String {
    match cwd.strip_prefix(home) {
        Ok(rest) if !home.as_os_str().is_empty() && rest.as_os_str().is_empty() => "~".to_owned(),
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => cwd.display().to_string(),
    }
}

fn format_duration(ms: u64) -> String {
    const MINUTE: u64 = 60_000;
    const HOUR: u64 = 60 * MINUTE;
    const DAY: u64 = 24 * HOUR;
    if ms < 1000 {
        return format!("{ms}ms");
    }
    let mut text = format!("{}s", (ms % MINUTE) as f64 / 1000.0);
    if ms >= MINUTE {
        text = format!("{}m {text}", ms / MINUTE % 60);
    }
    if ms >= HOUR {
        text = format!("{}h {text}", ms / HOUR % 24);
    }
    if ms >= DAY {
        text = format!("{}d {text}", ms / DAY);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_durations() {
        assert_eq!(format_duration(812), "812ms");
        assert_eq!(format_duration(1234), "1.234s");
        assert_eq!(format_duration(75_000), "1m 15s");
        assert_eq!(format_duration(3_605_250), "1h 0m 5.25s");
        assert_eq!(format_duration(90_000_000), "1d 1h 0m 0s");
    }

    #[test]
    fn shortens_home() {
        let home = Path::new("/Users/me");
        assert_eq!(display_path(Path::new("/Users/me"), home), "~");
        assert_eq!(display_path(Path::new("/Users/me/code"), home), "~/code");
        assert_eq!(display_path(Path::new("/Users/meow"), home), "/Users/meow");
        assert_eq!(display_path(Path::new("/tmp"), Path::new("")), "/tmp");
    }
}
