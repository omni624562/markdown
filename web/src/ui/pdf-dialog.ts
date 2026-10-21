/**
 * 匯出 PDF 的選項：頁首文字、頁碼、封面、紙張大小。上次的選擇會記住（頁首文字除外，每份文件不同）。
 */
import { PAPERS, type Paper, type PdfOptions } from "../pdf-print.ts";

/** `direct` 為 true 時按鈕是「匯出 PDF」（桌面版直接存檔），否則是「列印…」（開啟列印對話框）。 */
export function askPdfOptions(initial: PdfOptions, direct: boolean): Promise<PdfOptions | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "choice pdf-dialog";
  dialog.setAttribute("aria-labelledby", "pdf-title");
  dialog.innerHTML = `
    <h2 id="pdf-title">${direct ? "匯出 PDF" : "列印／匯出 PDF"}</h2>
    <form method="dialog" class="pdf-form">
      <label class="pdf-field"><span>頁首文字</span><input name="header" type="text" placeholder="不顯示頁首" /></label>
      <label class="pdf-check"><input name="pageNumbers" type="checkbox" /> 頁尾顯示頁碼（第 1 頁，共 N 頁）</label>
      <label class="pdf-check"><input name="cover" type="checkbox" /> 加上封面（標題與日期）</label>
      <label class="pdf-field pdf-subtitle-field"><span>封面副標題</span><input name="subtitle" type="text" placeholder="例如：業務部 王小明" /></label>
      <label class="pdf-field"><span>紙張</span><select name="paper"></select></label>
      ${direct ? "" : '<p class="pdf-hint">在列印對話框中選「另存為 PDF」就能存成 PDF；頁首與頁碼需要較新的瀏覽器（Chrome、Edge）。</p>'}
      <div class="choice-actions">
        <button type="button" class="btn" value="cancel">取消</button>
        <button class="btn btn-primary" value="ok">${direct ? "匯出 PDF" : "列印…"}</button>
      </div>
    </form>`;
  const form = dialog.querySelector("form")!;
  const field = <T extends HTMLElement>(name: string) => form.querySelector<T>(`[name=${name}]`)!;
  const paper = field<HTMLSelectElement>("paper");
  for (const [id, p] of Object.entries(PAPERS)) paper.append(new Option(p.label, id));
  field<HTMLInputElement>("header").value = initial.header;
  field<HTMLInputElement>("pageNumbers").checked = initial.pageNumbers;
  field<HTMLInputElement>("cover").checked = initial.cover;
  field<HTMLInputElement>("subtitle").value = initial.subtitle;
  paper.value = initial.paper;
  const subtitleRow = form.querySelector<HTMLElement>(".pdf-subtitle-field")!;
  const syncCover = () => (subtitleRow.hidden = !field<HTMLInputElement>("cover").checked);
  field<HTMLInputElement>("cover").addEventListener("change", syncCover);
  syncCover();
  return new Promise((resolve) => {
    let result: PdfOptions | null = null;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      result = {
        header: field<HTMLInputElement>("header").value,
        pageNumbers: field<HTMLInputElement>("pageNumbers").checked,
        cover: field<HTMLInputElement>("cover").checked,
        subtitle: field<HTMLInputElement>("subtitle").value,
        paper: paper.value as Paper,
      };
      dialog.close();
    });
    form.querySelector<HTMLButtonElement>("[value=cancel]")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    form.querySelector<HTMLButtonElement>(".btn-primary")!.focus();
  });
}
