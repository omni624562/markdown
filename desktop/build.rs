fn main() {
    // Android 版（android/build.rs）會設 `omarker_mobile`，共用的程式用它分辨；桌面版不設。
    println!("cargo:rustc-check-cfg=cfg(omarker_mobile)");
    tauri_build::build()
}
