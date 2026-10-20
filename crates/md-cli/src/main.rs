//! `mdtool`：在終端機把 Markdown 轉成 HTML，或列出大綱與字數。

use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use md_core::RenderOptions;

#[derive(Parser)]
#[command(name = "mdtool", version, about = "Markdown 轉換與分析工具")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 把 Markdown 轉成 HTML
    Html {
        /// 輸入檔；省略或為 `-` 時從標準輸入讀取
        input: Option<PathBuf>,
        /// 輸出檔；省略時寫到標準輸出
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// 只輸出 HTML 片段，不包成完整頁面
        #[arg(long)]
        fragment: bool,
        /// 改用自訂 CSS 檔取代內建樣式
        #[arg(long, conflicts_with = "fragment")]
        css: Option<PathBuf>,
        /// 把單一換行視為 <br>
        #[arg(long)]
        hardbreaks: bool,
    },
    /// 列出標題大綱
    Toc { input: Option<PathBuf> },
    /// 顯示字數統計
    Stats { input: Option<PathBuf> },
}

fn read_input(path: Option<&PathBuf>) -> io::Result<String> {
    match path {
        Some(p) if p.as_os_str() != "-" => fs::read_to_string(p),
        _ => {
            let mut buf = String::new();
            io::stdin().read_to_string(&mut buf)?;
            Ok(buf)
        }
    }
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
            let md = read_input(input.as_ref())?;
            let opts = RenderOptions {
                hardbreaks,
                ..Default::default()
            };
            let html = if fragment {
                md_core::render(&md, &opts).html
            } else {
                let css = css.map(fs::read_to_string).transpose()?;
                md_core::render_document(&md, &opts, css.as_deref())
            };
            match output {
                Some(path) => fs::write(path, html),
                None => io::stdout().write_all(html.as_bytes()),
            }
        }
        Command::Toc { input } => {
            let md = read_input(input.as_ref())?;
            let rendered = md_core::render(&md, &RenderOptions::default());
            let mut out = io::stdout().lock();
            for h in &rendered.headings {
                let indent = "  ".repeat(usize::from(h.level.saturating_sub(1)));
                writeln!(out, "{indent}- [{}](#{})", h.text, h.id)?;
            }
            Ok(())
        }
        Command::Stats { input } => {
            let md = read_input(input.as_ref())?;
            let s = md_core::render(&md, &RenderOptions::default()).stats;
            println!(
                "字數：{}（英文單字 {}、中日韓文字 {}）",
                s.words, s.latin_words, s.cjk_chars
            );
            println!("字元數（不含空白）：{}", s.chars);
            println!("預估閱讀時間：{} 分鐘", s.reading_minutes);
            Ok(())
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
