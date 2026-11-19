use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy)]
pub enum Color {
    Ansi(u8),
    Rgb(u8, u8, u8),
}

#[derive(Default)]
pub struct Line {
    pub text: String,
    pub width: usize,
}

impl Line {
    pub fn paint(&mut self, color: Color, visible: &str) {
        match color {
            Color::Ansi(code) => self.invisible(&format!("\x1b[{code}m")),
            Color::Rgb(r, g, b) => self.invisible(&format!("\x1b[38;2;{r};{g};{b}m")),
        }
        self.visible(visible);
        self.invisible("\x1b[0m");
    }

    pub fn visible(&mut self, text: &str) {
        self.text.push_str(&text.replace('%', "%%"));
        self.width += text.width();
    }

    /// A FinalTerm shell integration mark: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
    pub fn mark(&mut self, code: &str) {
        self.invisible(&format!("\x1b]133;{code}\x07"));
    }

    fn invisible(&mut self, sequence: &str) {
        self.text.push_str("%{");
        self.text.push_str(sequence);
        self.text.push_str("%}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_percent_and_counts_only_visible_text() {
        let mut line = Line::default();
        line.paint(Color::Ansi(34), "a%b");
        line.mark("A");
        assert_eq!(line.text, "%{\x1b[34m%}a%%b%{\x1b[0m%}%{\x1b]133;A\x07%}");
        assert_eq!(line.width, 3);
    }
}
