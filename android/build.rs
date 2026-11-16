fn main() {
    // 桌面版的程式（desktop/src/assistant.rs 等）直接拿來編譯時，用這個分辨是 Android 版
    // （在電腦上跑測試、檢查時 `mobile` 不成立，所以另外設一個）。
    println!("cargo:rustc-check-cfg=cfg(omarker_mobile)");
    println!("cargo:rustc-cfg=omarker_mobile");
    tauri_build::build()
}
