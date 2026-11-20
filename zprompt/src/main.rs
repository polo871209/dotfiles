mod context;
mod git;

use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use unicode_width::UnicodeWidthStr;

const USAGE: &str = "usage: zprompt init <zsh|bash>
       zprompt prompt <zsh|bash> <cached|fresh> <last status> <1 if a command ran, else 0> <duration ms, -1 if none> <columns>
       zprompt tooltip";

const WHITE: &str = "37";
const BLUE: &str = "34";
const GREY: &str = "38;2;108;108;108";
const BEHIND: &str = "38;2;161;32;54";
const AHEAD: &str = "38;2;16;133;78";
const KUBERNETES: &str = "38;2;58;123;225";
const PYTHON: &str = "38;2;255;211;67";
const GO: &str = "38;2;0;172;215";
const NODE: &str = "38;2;65;126;56";
const TERRAFORM: &str = "38;2;98;60;228";
const GOOGLE_YELLOW: &str = "38;2;255;206;68";
const GRUVBOX_BLUE: &str = "38;2;131;165;152";
const GRUVBOX_RED: &str = "38;2;251;73;52";

const PROMPT_CHAR: &str = "\u{f02a0}";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let text = match args[..] {
        ["init", "zsh"] => init(include_str!("init.zsh")),
        ["init", "bash"] => init(include_str!("init.bash")),
        [
            "prompt",
            shell @ ("zsh" | "bash"),
            freshness @ ("cached" | "fresh"),
            status,
            ran,
            duration,
            columns,
        ] => {
            let request = Request {
                shell: if shell == "bash" {
                    Shell::Bash
                } else {
                    Shell::Zsh
                },
                fresh: freshness == "fresh",
                ran: ran == "1",
                status: status.parse().unwrap_or(0),
                duration_ms: duration.parse().ok(),
                columns: columns.parse().unwrap_or(0),
            };
            Some(render(&request))
        }
        ["tooltip"] => Some(gcp_tooltip()),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match text.map(|text| std::io::stdout().write_all(text.as_bytes())) {
        Some(Ok(())) => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}

fn init(script: &str) -> Option<String> {
    let bin = std::env::current_exe()
        .ok()?
        .to_str()?
        .replace('\'', r"'\''");
    Some(format!("_zp_bin='{bin}'\n{script}"))
}

#[derive(Clone, Copy, PartialEq)]
enum Shell {
    Zsh,
    Bash,
}

struct Request {
    shell: Shell,
    fresh: bool,
    ran: bool,
    status: i32,
    duration_ms: Option<u64>,
    columns: usize,
}

fn render(request: &Request) -> String {
    let home = home();
    let cwd = std::env::var_os("PWD")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let (git, kube, right) = std::thread::scope(|scope| {
        let git = scope.spawn(|| git::status(&cwd, request.fresh));
        let kube = scope.spawn(|| context::kube(&home));
        let right = right_prompt(request, &cwd, &home);
        (git.join().ok().flatten(), kube.join().ok().flatten(), right)
    });

    let mut left = Line::new(request.shell);
    finished_command_mark(&mut left, request);
    left.mark("A");
    left.paint(WHITE, "\u{e711} ");
    left.paint(BLUE, &display_path(&cwd, &home));
    if let Some(git) = git {
        let head = match git.head {
            git::Head::Branch(name) => name,
            git::Head::Detached(commit) => format!("detached at \u{f417}{commit}"),
        };
        left.paint(
            GREY,
            &format!(
                " \u{f418} {head}{} ",
                if git.changes.dirty { "*" } else { "" }
            ),
        );
        if git.changes.behind > 0 {
            left.paint(BEHIND, "\u{ea9a}");
        }
        if git.changes.ahead > 0 {
            left.paint(AHEAD, "\u{eaa1}");
        }
    }
    if let Some(kube) = kube {
        let mut context = Line::new(request.shell);
        let namespace = kube
            .namespace
            .map(|ns| format!(":{ns}"))
            .unwrap_or_default();
        context.paint(KUBERNETES, &format!(" \u{e81d} {}{namespace}", kube.name));
        if left.width + context.width < request.columns {
            left.visible(&" ".repeat(request.columns - left.width - context.width));
            left.text.push_str(&context.text);
        }
    }
    left.text.push('\n');
    if request.shell == Shell::Bash && right.width > 0 && right.width < request.columns {
        let column = request.columns - right.width + 1;
        let right = right.text.replace(['\x01', '\x02'], "");
        left.invisible(&format!("\x1b7\x1b[{column}G{right}\x1b8"));
    }
    left.paint(
        if request.status == 0 {
            GRUVBOX_BLUE
        } else {
            GRUVBOX_RED
        },
        PROMPT_CHAR,
    );
    left.visible(" ");
    left.mark("B");
    if request.shell == Shell::Bash {
        return left.text;
    }

    let mut transient = Line::new(request.shell);
    finished_command_mark(&mut transient, request);
    transient.mark("A");
    transient.paint(GRUVBOX_BLUE, &format!("{PROMPT_CHAR} "));
    transient.mark("B");

    format!("{}\0{}\0{}", left.text, right.text, transient.text)
}

fn gcp_tooltip() -> String {
    let Some(config) = context::gcp(&home()) else {
        return String::new();
    };
    let mut line = Line::new(Shell::Zsh);
    line.paint(
        GOOGLE_YELLOW,
        &format!(
            "\u{e7b2} {}:{}:{}",
            config.name, config.project, config.region
        ),
    );
    line.text
}

fn finished_command_mark(line: &mut Line, request: &Request) {
    if request.ran {
        line.mark(&format!("D;{}", request.status));
    } else {
        line.mark("D");
    }
}

fn right_prompt(request: &Request, cwd: &Path, home: &Path) -> Line {
    let fresh = request.fresh;
    let names = context::file_names(cwd);
    let languages = cwd != home;
    let show_go = languages
        && context::has_any(
            &names,
            &["*.go", "go.mod", "go.sum", "go.work", "go.work.sum"],
        );
    let show_node = languages
        && context::has_any(
            &names,
            &[
                "*.js",
                "*.ts",
                "*.vue",
                "package.json",
                ".nvmrc",
                "pnpm-workspace.yaml",
                ".pnpmfile.cjs",
            ],
        );
    let show_terraform = context::has_any(&names, &[".terraform", "*.tf", "*.tfplan", "*.tfstate"])
        && context::which("terraform").is_some();

    let (python, go, node) = std::thread::scope(|scope| {
        let python = scope.spawn(|| languages.then(|| context::python(cwd, fresh)).flatten());
        let go = scope.spawn(|| {
            show_go
                .then(|| context::tool_version("go", cwd, fresh))
                .flatten()
        });
        let node = show_node
            .then(|| context::tool_version("node", cwd, fresh))
            .flatten();
        (python.join().ok().flatten(), go.join().ok().flatten(), node)
    });

    let mut right = Line::new(request.shell);
    if let Some((venv, version)) = python {
        right.paint(
            PYTHON,
            &format!("{venv} \u{f0320} {}", version.unwrap_or_default()),
        );
    }
    if let Some(go) = go {
        right.paint(GO, &format!("\u{e627} {go}"));
    }
    if let Some(node) = node {
        right.paint(NODE, &format!("\u{e60c} {node}"));
    }
    if show_terraform {
        right.paint(
            TERRAFORM,
            &format!("\u{f1062} {}", context::terraform_workspace(cwd)),
        );
    }
    if let Some(ms) = request.duration_ms.filter(|ms| *ms >= 500) {
        right.paint(WHITE, &format!(" {} ", format_duration(ms)));
    }
    right
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

struct Line {
    shell: Shell,
    text: String,
    width: usize,
}

impl Line {
    fn new(shell: Shell) -> Self {
        Self {
            shell,
            text: String::new(),
            width: 0,
        }
    }

    fn paint(&mut self, sgr: &str, visible: &str) {
        self.invisible(&format!("\x1b[{sgr}m"));
        self.visible(visible);
        self.invisible("\x1b[0m");
    }

    // bash reads PS1 as '${_zp_ps1}' and does not expand the value again, so its text needs no escaping.
    fn visible(&mut self, text: &str) {
        match self.shell {
            Shell::Zsh => self.text.push_str(&text.replace('%', "%%")),
            Shell::Bash => self.text.push_str(text),
        }
        self.width += text.width();
    }

    // Semantic prompt mark: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
    fn mark(&mut self, code: &str) {
        self.invisible(&format!("\x1b]133;{code}\x07"));
    }

    fn invisible(&mut self, sequence: &str) {
        let (start, end) = match self.shell {
            Shell::Zsh => ("%{", "%}"),
            Shell::Bash => ("\x01", "\x02"),
        };
        self.text.push_str(start);
        self.text.push_str(sequence);
        self.text.push_str(end);
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn hash(key: impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    hasher.finish()
}

fn cache_file(kind: &str, key: impl Hash) -> PathBuf {
    let dir =
        std::env::var_os("XDG_CACHE_HOME").map_or_else(|| home().join(".cache"), PathBuf::from);
    dir.join("zprompt")
        .join(kind)
        .join(format!("{:016x}", hash(key)))
}

fn cache_read(file: &Path) -> String {
    std::fs::read_to_string(file).unwrap_or_default()
}

fn cache_write(file: &Path, text: &str) {
    let temporary = file.with_extension(std::process::id().to_string());
    let _ = file.parent().map(std::fs::create_dir_all);
    if std::fs::write(&temporary, text).is_ok() && std::fs::rename(&temporary, file).is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
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

    #[test]
    fn wraps_sequences_for_each_shell_and_counts_only_visible_text() {
        let mut zsh = Line::new(Shell::Zsh);
        zsh.paint(BLUE, "a%b");
        zsh.mark("A");
        assert_eq!(zsh.text, "%{\x1b[34m%}a%%b%{\x1b[0m%}%{\x1b]133;A\x07%}");
        assert_eq!(zsh.width, 3);

        let mut bash = Line::new(Shell::Bash);
        bash.paint(BLUE, "a%$(b)");
        assert_eq!(bash.text, "\x01\x1b[34m\x02a%$(b)\x01\x1b[0m\x02");
        assert_eq!(bash.width, 6);
    }
}
