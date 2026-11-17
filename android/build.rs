fn main() {
    // 桌面版的程式（desktop/src/assistant.rs 等）直接拿來編譯時，用這個分辨是 Android 版
    // （在電腦上跑測試、檢查時 `mobile` 不成立，所以另外設一個）。
    println!("cargo:rustc-check-cfg=cfg(omarker_mobile)");
    println!("cargo:rustc-cfg=omarker_mobile");
    // 版本號跟著桌面版（desktop/Cargo.toml）走，發佈時只升那一份。
    println!("cargo:rerun-if-changed=../desktop/Cargo.toml");
    let manifest = std::fs::read_to_string("../desktop/Cargo.toml").unwrap_or_default();
    let version = manifest
        .lines()
        .find_map(|l| l.strip_prefix("version = \""))
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    println!("cargo:rustc-env=OMARKER_VERSION={version}");
    tauri_build::build()
}
