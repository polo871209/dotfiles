mod cache;
mod gcp;
mod git;
mod kube;
mod lang;
mod prompt;
mod style;

use std::io::Write;
use std::process::ExitCode;

const USAGE: &str = "usage: zprompt init
       zprompt prompt <cached|fresh> <last status> <1 if a command ran, else 0> <duration ms, -1 if none> <columns>
       zprompt tooltip";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("init") => init(),
        Some("prompt") => render(&args[1..]),
        Some("tooltip") => output(&prompt::gcp_tooltip()),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn init() -> ExitCode {
    let Some(bin) = std::env::current_exe().ok().and_then(|path| path.to_str().map(str::to_owned)) else {
        return ExitCode::FAILURE;
    };
    output(&format!("_zp_bin='{}'\n{}", bin.replace('\'', r"'\''"), include_str!("init.zsh")))
}

fn render(args: &[String]) -> ExitCode {
    let [freshness, status, ran, duration, columns] = args else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let Some(freshness) = cache::Freshness::parse(freshness) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let last_status = status.parse().unwrap_or(0);
    let request = prompt::Request {
        freshness,
        status: (ran == "1").then_some(last_status),
        last_status,
        duration_ms: duration.parse().ok(),
        columns: columns.parse().unwrap_or(0),
    };
    let rendered = prompt::render(&request);
    output(&format!("{}\0{}\0{}", rendered.left, rendered.right, rendered.transient))
}

fn output(text: &str) -> ExitCode {
    match std::io::stdout().write_all(text.as_bytes()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
