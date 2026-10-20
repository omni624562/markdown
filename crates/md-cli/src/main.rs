//! `mdtool`：在終端機把 Markdown、純文字或 JSON 轉成 HTML，或列出大綱與字數。

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand, ValueEnum};
use md_core::{DocKind, DocumentOptions, RenderOptions};

#[derive(Parser)]
#[command(
    name = "mdtool",
    version,
    about = "Markdown／純文字／JSON 轉換與分析工具"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Input {
    /// 輸入檔；省略或為 `-` 時從標準輸入讀取
    input: Option<PathBuf>,
    /// 文件類型；省略時依副檔名判斷（標準輸入預設為 Markdown）
    #[arg(short, long, value_enum)]
    format: Option<Format>,
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Md,
    Txt,
    Json,
}

#[derive(Subcommand)]
enum Command {
    /// 轉成 HTML
    Html {
        #[command(flatten)]
        input: Input,
        /// 輸出檔；省略時寫到標準輸出
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// 只輸出 HTML 片段，不包成完整頁面
        #[arg(long)]
        fragment: bool,
        /// 改用自訂 CSS 檔取代內建樣式
        #[arg(long, conflicts_with = "fragment")]
        css: Option<PathBuf>,
        /// 把單一換行視為 <br>（僅 Markdown）
        #[arg(long)]
        hardbreaks: bool,
    },
    /// 列出標題大綱
    Toc {
        #[command(flatten)]
        input: Input,
    },
    /// 顯示字數統計
    Stats {
        #[command(flatten)]
        input: Input,
    },
    /// 重新排版：JSON 縮排兩格；Markdown 對齊所有表格
    Fmt {
        #[command(flatten)]
        input: Input,
        /// 直接覆寫輸入檔
        #[arg(short, long)]
        write: bool,
    },
}

fn is_stdin(path: Option<&PathBuf>) -> bool {
    path.is_none_or(|p| p.as_os_str() == "-")
}

fn read_input(path: Option<&PathBuf>) -> io::Result<String> {
    if is_stdin(path) {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        Ok(buf)
    } else {
        fs::read_to_string(path.unwrap())
    }
}

impl Input {
    fn read(&self) -> io::Result<(String, DocKind)> {
        let kind = match self.format {
            Some(Format::Md) => DocKind::Markdown,
            Some(Format::Txt) => DocKind::Text,
            Some(Format::Json) => DocKind::Json,
            None if is_stdin(self.input.as_ref()) => DocKind::Markdown,
            None => DocKind::from_file_name(&self.input.as_ref().unwrap().to_string_lossy()),
        };
        Ok((read_input(self.input.as_ref())?, kind))
    }

    fn file_stem(&self) -> Option<String> {
        let path = self.input.as_deref().filter(|p| p.as_os_str() != "-")?;
        Path::new(path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
    }
}

fn parse_error(e: md_core::SourceError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("第 {} 行，第 {} 欄：{}", e.line, e.column, e.message),
    )
}

fn run(cli: Cli) -> io::Result<()> {
    match cli.command {
        Command::Html {
            input,
            output,
            fragment,
            css,
            hardbreaks,
        } => {
            let (text, kind) = input.read()?;
            let opts = RenderOptions {
                kind,
                hardbreaks,
                ..Default::default()
            };
            let rendered = md_core::render(&text, &opts);
            if let Some(e) = rendered.error {
                return Err(parse_error(e));
            }
            let html = if fragment {
                rendered.html
            } else {
                let css = css.map(fs::read_to_string).transpose()?;
                let title = input.file_stem();
                let doc = DocumentOptions {
                    css: css.as_deref(),
                    title: title.as_deref(),
                };
                md_core::render_document(&text, &opts, &doc)
            };
            match output {
                Some(path) => fs::write(path, html),
                None => io::stdout().write_all(html.as_bytes()),
            }
        }
        Command::Toc { input } => {
            let (text, kind) = input.read()?;
            let rendered = md_core::render(
                &text,
                &RenderOptions {
                    kind,
                    ..Default::default()
                },
            );
            let mut out = io::stdout().lock();
            for h in &rendered.headings {
                let indent = "  ".repeat(usize::from(h.level.saturating_sub(1)));
                writeln!(out, "{indent}- [{}](#{})", h.text, h.id)?;
            }
            Ok(())
        }
        Command::Stats { input } => {
            let (text, kind) = input.read()?;
            let s = md_core::render(
                &text,
                &RenderOptions {
                    kind,
                    ..Default::default()
                },
            )
            .stats;
            println!(
                "字數：{}（英文單字 {}、中日韓文字 {}）",
                s.words, s.latin_words, s.cjk_chars
            );
            println!("字元數（不含空白）：{}", s.chars);
            println!("預估閱讀時間：{} 分鐘", s.reading_minutes);
            Ok(())
        }
        Command::Fmt { input, write } => {
            if write && is_stdin(input.input.as_ref()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "--write 需要指定輸入檔",
                ));
            }
            let (text, kind) = input.read()?;
            let formatted = match kind {
                DocKind::Json => md_core::format_json(&text).map_err(parse_error)?,
                DocKind::Markdown => md_core::format_all_tables(&text),
                DocKind::Text => text,
            };
            match input.input {
                Some(path) if write => fs::write(path, formatted),
                _ => io::stdout().write_all(formatted.as_bytes()),
            }
        }
    }
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("mdtool: {e}");
            ExitCode::FAILURE
        }
    }
}
