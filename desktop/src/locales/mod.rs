//! 英文介面的翻譯（鍵是 `tr!` 裡的繁體中文原文，一字不差）。依模組分開；同一句只能出現一次。

mod ado;
mod ai;
mod common;
mod dav;
mod files;
mod git;
mod git_flow;
mod git_log;
mod github;
mod misc;
mod update;
mod workspace;

pub static ALL: &[&[(&str, &str)]] = &[
    ado::EN,
    ai::EN,
    common::EN,
    dav::EN,
    files::EN,
    git::EN,
    git_flow::EN,
    git_log::EN,
    github::EN,
    misc::EN,
    update::EN,
    workspace::EN,
];
