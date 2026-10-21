//! 直接匯出 PDF（不經過列印對話框）。
//!
//! 前端先把要輸出的內容放進主視窗的列印區（只在列印時顯示），這裡再請 WebView 把目前的頁面
//! 以列印樣式存成 PDF：Windows 用 WebView2 的 PrintToPdf，Linux 用 WebKitGTK 的列印到檔案。
//! 頁首、頁碼、封面都由前端的 CSS（`@page`）處理。其他平台回傳錯誤，前端改用列印對話框。

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;
use tauri::WebviewWindow;

/// 紙張大小與邊界（公釐），要和前端 CSS 的 `@page` 一致。
#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct PageLayout {
    pub width_mm: f64,
    pub height_mm: f64,
    pub margin_top_mm: f64,
    pub margin_bottom_mm: f64,
    pub margin_side_mm: f64,
}

/// 選擇 PDF 的存檔位置；取消時回傳 None。
#[tauri::command]
pub async fn pick_pdf_path(window: WebviewWindow, suggested_name: String) -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("匯出 PDF")
        .set_file_name(&suggested_name)
        .add_filter("PDF 文件", &["pdf"])
        .save_file()
        .await
        .map(|h| h.path().to_string_lossy().into_owned())
}

/// 把主視窗目前的內容（列印樣式）存成 PDF。
#[tauri::command]
pub async fn print_to_pdf(
    window: WebviewWindow,
    path: String,
    layout: PageLayout,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    start(&window, path, layout, tx)?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(120))
            .unwrap_or_else(|_| Err("匯出 PDF 逾時".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn start(
    window: &WebviewWindow,
    path: PathBuf,
    layout: PageLayout,
    tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    const MM_PER_INCH: f64 = 25.4;
    let fail = tx.clone();
    window
        .with_webview(move |webview| {
            let run = || -> windows_core::Result<()> {
                unsafe {
                    let core = webview.controller().CoreWebView2()?;
                    let env: ICoreWebView2Environment6 =
                        core.cast::<ICoreWebView2_2>()?.Environment()?.cast()?;
                    let settings = env.CreatePrintSettings()?;
                    settings.SetPageWidth(layout.width_mm / MM_PER_INCH)?;
                    settings.SetPageHeight(layout.height_mm / MM_PER_INCH)?;
                    settings.SetMarginTop(layout.margin_top_mm / MM_PER_INCH)?;
                    settings.SetMarginBottom(layout.margin_bottom_mm / MM_PER_INCH)?;
                    settings.SetMarginLeft(layout.margin_side_mm / MM_PER_INCH)?;
                    settings.SetMarginRight(layout.margin_side_mm / MM_PER_INCH)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    // 頁首與頁碼由 CSS 的 @page 處理，不要 WebView2 預設的網址與日期。
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let done = tx.clone();
                    let handler =
                        PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                            let _ = done.send(match result {
                                Ok(()) if ok => Ok(()),
                                Ok(()) => Err("無法寫入 PDF（檔案可能正被其他程式開著）".into()),
                                Err(e) => Err(format!("匯出 PDF 失敗：{e}")),
                            });
                            Ok(())
                        }));
                    core.cast::<ICoreWebView2_7>()?.PrintToPdf(
                        &HSTRING::from(path.as_os_str()),
                        &settings,
                        &handler,
                    )
                }
            };
            if let Err(e) = run() {
                let _ = fail.send(Err(format!("匯出 PDF 失敗：{e}")));
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn start(
    window: &WebviewWindow,
    path: PathBuf,
    layout: PageLayout,
    tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webkit2gtk::PrintOperationExt;

    window
        .with_webview(move |webview| {
            let op = webkit2gtk::PrintOperation::new(&webview.inner());
            let settings = gtk::PrintSettings::new();
            settings.set_printer("Print to File");
            settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
            let uri = format!("file://{}", path.to_string_lossy());
            settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&uri));
            op.set_print_settings(&settings);
            let setup = gtk::PageSetup::new();
            let paper = gtk::PaperSize::new_custom(
                "custom",
                "custom",
                layout.width_mm,
                layout.height_mm,
                gtk::Unit::Mm,
            );
            setup.set_paper_size(&paper);
            setup.set_top_margin(layout.margin_top_mm, gtk::Unit::Mm);
            setup.set_bottom_margin(layout.margin_bottom_mm, gtk::Unit::Mm);
            setup.set_left_margin(layout.margin_side_mm, gtk::Unit::Mm);
            setup.set_right_margin(layout.margin_side_mm, gtk::Unit::Mm);
            op.set_page_setup(&setup);
            let done = tx.clone();
            op.connect_finished(move |_| {
                let _ = done.send(Ok(()));
            });
            let failed = tx.clone();
            op.connect_failed(move |_, err| {
                let _ = failed.send(Err(format!("匯出 PDF 失敗：{err}")));
            });
            op.print();
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn start(
    _window: &WebviewWindow,
    _path: PathBuf,
    _layout: PageLayout,
    _tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    Err("這個平台不支援直接匯出 PDF".into())
}
