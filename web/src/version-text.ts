/**
 * 版本資訊的文字（見 app/version-info.ts）：版本與更新管道、建置、作業系統與顯示核心，
 * 以及帶著版本資訊的 GitHub 新問題網址。只有這些，不含檔案、帳號或公司的資料。
 */
import { t } from "./i18n.ts";
import { REPO_URL } from "./repo.ts";

export interface VersionParts {
  version: string;
  /** 穩定版、搶先版、網頁版；自己編譯的版本沒有。 */
  channel: string | null;
  /** 第幾次建置與提交編號（或「自行編譯」）。網頁版沒有。 */
  build: string | null;
  system: string;
  engine: string;
}

/** 三行：版本與管道、建置、作業系統與顯示核心。 */
export function versionInfoText(p: VersionParts): string {
  const head = p.channel ? t("oMarker {version}（{channel}）", { version: p.version, channel: p.channel }) : `oMarker ${p.version}`;
  return [head, p.build, `${p.system}・${p.engine}`].filter(Boolean).join("\n");
}

/**
 * 作業系統。Windows 10 與 11 的 User-Agent 一樣是「Windows NT 10.0」，要看 `platformVersion`
 * （User-Agent Client Hints）：13 以上是 Windows 11，1～12 是 Windows 10。
 */
export function systemName(ua: string, platformVersion?: string): string {
  if (/Windows NT/.test(ua)) {
    const major = Number(platformVersion?.split(".")[0]);
    if (major >= 13) return "Windows 11";
    if (major >= 1) return "Windows 10";
    return "Windows";
  }
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return t("不明的系統");
}

/** 顯示網頁的核心：桌面版在 Windows 上是 WebView2（User-Agent 裡的 Edg/版本），網頁版是瀏覽器。 */
export function engineName(ua: string, inApp: boolean): string {
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return inApp ? `WebView2 ${edge[1]}` : `Edge ${edge[1]}`;
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return `Chrome ${chrome[1]}`;
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return `Firefox ${firefox[1]}`;
  const safari = /Version\/([\d.]+).*Safari/.exec(ua);
  if (safari) return `Safari ${safari[1]}`;
  if (/AppleWebKit/.test(ua)) return "WebKit";
  return t("不明的瀏覽器");
}

/** GitHub 新問題的網址：內文先放好版本資訊。GitHub 上的問題是公開的，用註解提醒不要貼公司的資料（送出後看不到註解）。 */
export function reportIssueUrl(info: string): string {
  const note = t("請在這裡描述問題或建議，以及怎麼操作會發生。這裡是公開的頁面，請不要貼上公司的文件內容、帳號、內部網址，或含有這些資料的截圖。");
  const body = [`<!-- ${note} -->`, "", "", "", "---", info].join("\n");
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}
