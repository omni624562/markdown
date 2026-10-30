//! 直接匯出 PDF（不經過列印對話框）。
//!
//! 前端先把要輸出的內容放進主視窗的列印區（只在列印時顯示），這裡再請 WebView 把目前的頁面
//! 以列印樣式存成 PDF：Windows 用 WebView2 的 PrintToPdf，Linux 用 WebKitGTK 的列印到檔案。
//! 頁首、頁碼、封面都由前端的 CSS（`@page`）處理。其他平台回傳錯誤，前端改用列印對話框。

use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{State, Webview, Window};

/// 使用者在「匯出 PDF」對話框選的位置。`print_to_pdf` 只能寫到這裡，而且只能用一次，
/// 前端不能自己指定要寫到哪個路徑。
#[derive(Default)]
pub struct PdfTarget(Mutex<Option<PathBuf>>);

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
pub async fn pick_pdf_path(
    window: Window,
    suggested_name: String,
    target: State<'_, PdfTarget>,
) -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("匯出 PDF"))
        .set_file_name(&suggested_name)
        .add_filter(tr!("PDF 文件"), &["pdf"])
        .save_file()
        .await
        .map(|h| h.path().to_path_buf());
    *target.0.lock().unwrap() = picked.clone();
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

/// 取出剛才在對話框選的位置；`path` 必須和它相同。
fn take_target(target: &PdfTarget, path: &str) -> Result<PathBuf, String> {
    let mut slot = target.0.lock().unwrap();
    match slot.as_ref() {
        Some(p) if p.as_os_str() == std::ffi::OsStr::new(path) => Ok(slot.take().unwrap()),
        _ => Err(tr!("請重新選擇 PDF 的存檔位置")),
    }
}

/// 把主視窗目前的內容（列印樣式）存成 PDF。`path` 必須是剛才用 `pick_pdf_path` 選的位置。
#[tauri::command]
pub async fn print_to_pdf(
    webview: Webview,
    path: String,
    layout: PageLayout,
    target: State<'_, PdfTarget>,
) -> Result<(), String> {
    let path = take_target(&target, &path)?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    start(&webview, path, layout, tx)?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(120))
            .unwrap_or_else(|_| Err(tr!("匯出 PDF 逾時")))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn start(
    webview: &Webview,
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
    webview
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
                                Ok(()) => Err(tr!("無法寫入 PDF（檔案可能正被其他程式開著）")),
                                Err(e) => Err(tr!("匯出 PDF 失敗：{e}", e = e)),
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
                let _ = fail.send(Err(tr!("匯出 PDF 失敗：{e}", e = e)));
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn start(
    webview: &Webview,
    path: PathBuf,
    layout: PageLayout,
    tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webkit2gtk::PrintOperationExt;

    webview
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
                let _ = failed.send(Err(tr!("匯出 PDF 失敗：{e}", e = err)));
            });
            op.print();
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn start(
    _webview: &Webview,
    _path: PathBuf,
    _layout: PageLayout,
    _tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    Err(tr!("這個平台不支援直接匯出 PDF"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_picked_path_can_be_written_once() {
        let target = PdfTarget::default();
        assert!(take_target(&target, "/tmp/a.pdf").is_err(), "沒選過位置");
        *target.0.lock().unwrap() = Some(PathBuf::from("/tmp/匯出.pdf"));
        assert!(take_target(&target, "/home/me/.bashrc").is_err());
        assert_eq!(
            take_target(&target, "/tmp/匯出.pdf").unwrap(),
            PathBuf::from("/tmp/匯出.pdf")
        );
        assert!(take_target(&target, "/tmp/匯出.pdf").is_err(), "只能用一次");
    }
}
