/**
 * 設定：套用設定、字型大小、簡體轉繁體、設定對話框。
 */
import { desktop, isRemote } from "../desktop.ts";
import { fontStack } from "../fonts.ts";
import { t, currentLang } from "../i18n.ts";
import { refreshLivePreview } from "../live-preview.ts";
import { recheckTerms, scanDocument } from "../proofread.ts";
import { type Convert, loadConverter, conversionChanges, looksSimplified } from "../s2t.ts";
import { type Settings, FONT_SIZE_RANGE } from "../settings.ts";
import * as storage from "../storage.ts";
import { sureFixes } from "../terms.ts";
import { SettingsDialog } from "../ui/settings-dialog.ts";
import { clampSidebarWidth, setupSidebarResize } from "../ui/sidebar-resize.ts";
import { setupSplitter } from "../ui/splitter.ts";
import { toast } from "../ui/toast.ts";
import { versionLabel, versionDetail, versionTooltip } from "../updater.ts";
import { applyActivityLayout, openUrl, showShortcuts, openWelcome, openChangelog, panelOrder, PANEL_LABELS, PANEL_ICONS, addActivityCommand } from "./activity-bar.ts";
import { reportError } from "./git-actions.ts";
import { buildFormatBar } from "./new-work-item.ts";
import { showAdo, gitPanel } from "./work-item-updates.ts";
import { renderAdoTab, renderIssuesTab } from "./work-items-panel.ts";
import type { ViewUpdate } from "@codemirror/view";
import type { ViewMode } from "../main.ts";
import { app } from "./context.ts";


const PREVIEW_WIDTH: Record<Settings["previewWidth"], string> = { narrow: "680px", medium: "820px", wide: "1080px" };
/** 內文字型：英文字型在前，中文指定台灣的字型（沒有安裝時往後找）。 */
const DOC_FONT: Record<Settings["docFont"], string> = {
  sans: "",
  serif:
    'Georgia, "Times New Roman", "Noto Serif TC", "Source Han Serif TC", "思源宋體", "PMingLiU", "新細明體", "Songti TC", serif', // i18n-ignore
  kai: 'Georgia, "Times New Roman", "BiauKai", "DFKai-SB", "標楷體", "TW-Kai", "Kaiti TC", "AR PL UKai TW", serif', // i18n-ignore
  mono: "var(--font-mono)",
  // 由 docFontCustom 決定（見 applySettings）。
  custom: "",
};
const DOC_LINE_HEIGHT: Record<Settings["docLineHeight"], string> = { compact: "1.6", normal: "1.8", relaxed: "2.1" };

export function toggleSetting(key: "focusMode" | "typewriterMode", label: string): void {
  const on = !app.settings.value[key];
  app.settings.update({ [key]: on });
  toast(on ? t("{label}已開啟", { label }) : t("{label}已關閉", { label }));
  app.editor.view.focus();
}

export function changeFontSize(delta: number): void {
  const size = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, app.settings.value.editorFontSize + delta));
  if (size === app.settings.value.editorFontSize) {
    toast(delta > 0 ? t("已經是最大的字級（{size}px）", { size }) : t("已經是最小的字級（{size}px）", { size }));
    return;
  }
  app.settings.update({ editorFontSize: size });
}

export function applySettings(s: Readonly<Settings>, changed?: (keyof Settings)[]): void {
  if (!changed || changed.some((k) => k.startsWith("activity"))) applyActivityLayout();
  const root = document.documentElement.style;
  root.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  root.setProperty("--preview-width", PREVIEW_WIDTH[s.previewWidth]);
  const docFont =
    s.docFont === "custom" ? fontStack(s.docFontCustom, "var(--font-doc-default)") : DOC_FONT[s.docFont];
  if (docFont) root.setProperty("--font-doc", docFont);
  else root.removeProperty("--font-doc");
  const codeFont = fontStack(s.codeFont, "var(--font-mono-default)");
  if (codeFont) root.setProperty("--font-mono", codeFont);
  else root.removeProperty("--font-mono");
  root.setProperty("--doc-line-height", DOC_LINE_HEIGHT[s.docLineHeight]);
  // 介面大小：整個視窗縮放（啟動時預設 100% 就不用呼叫）。
  if (desktop && (changed ? changed.includes("uiScale") : s.uiScale !== "100")) {
    void desktop.setUiZoom(Number(s.uiScale) / 100).catch(reportError);
    app.terminal?.relayout();
  }
  if (!changed) return;
  const fontKeys: (keyof Settings)[] = ["docFont", "docFontCustom", "codeFont", "docLineHeight"];
  if (changed.some((k) => fontKeys.includes(k))) app.editor.view.requestMeasure();
  const editorKeys: (keyof Settings)[] = ["lineNumbers", "autoPairBrackets", "focusMode", "typewriterMode"];
  if (changed.some((k) => editorKeys.includes(k))) {
    app.editor.configure({
      lineNumbers: s.lineNumbers,
      autoPairBrackets: s.autoPairBrackets,
      focusMode: s.focusMode,
      typewriterMode: s.typewriterMode,
    });
  }
  if (changed.includes("editorFontSize")) {
    app.editor.view.requestMeasure();
    app.terminal?.applyFont();
  }
  if (changed.includes("fixedToolbar")) {
    buildFormatBar();
    app.editor.view.requestMeasure();
  }
  if (changed.includes("math") || changed.includes("mermaid") || changed.includes("blockRemoteImages")) {
    app.preview.clear();
    app.renderNow();
    refreshLivePreview(app.editor.view);
    app.rerenderIssue();
  }
  if (changed.includes("termCheck") || changed.includes("termIgnore")) recheckTerms(app.editor.view);
  if (changed.includes("outlineRight")) {
    // 打開「大綱放在右邊」時，一定讓它顯示出來。
    if (app.settings.value.outlineRight) app.rightOutlineShown = true;
    app.applyLayout();
  }
}

/** 整份文件的兩國用語與錯字：不需要判斷文意的直接換掉，其他的留著波浪底線。 */
/** 簡體轉繁體：有選取時只轉選取範圍，否則轉整份文件。程式碼與網址不轉。 */
export async function convertToTraditional(ranges?: readonly { from: number; to: number }[]): Promise<void> {
  const doc = app.active;
  const loading = window.setTimeout(() => toast(t("正在載入簡繁轉換詞庫…")), 300);
  let convert: Convert;
  try {
    convert = await loadConverter();
  } finally {
    clearTimeout(loading);
  }
  if (app.active !== doc) return;
  const state = app.editor.view.state;
  const targets = ranges ?? state.selection.ranges.filter((r) => !r.empty);
  const list = targets.length ? targets : [{ from: 0, to: state.doc.length }];
  const changes = list.flatMap((r) => conversionChanges(state.sliceDoc(r.from, r.to), convert, r.from));
  if (!changes.length) {
    toast(t("沒有需要轉換的簡體字。"), { tone: "success" });
    return;
  }
  app.editor.view.dispatch({ changes, userEvent: "input.s2t" });
  toast(
    targets.length
      ? t("已轉成繁體（選取範圍，{n} 處；可以按 Ctrl+Z 復原）。", { n: changes.length })
      : t("已轉成繁體（整份文件，{n} 處；可以按 Ctrl+Z 復原）。", { n: changes.length }),
    { tone: "success" },
  );
}

/** 貼上的內容看起來是簡體時，提示可以轉成繁體。 */
export function onSimplifiedPaste(u: ViewUpdate): void {
  if (app.kind === "json" || !u.transactions.some((tr) => tr.isUserEvent("input.paste"))) return;
  const ranges: { from: number; to: number }[] = [];
  let inserted = "";
  u.changes.iterChanges((_fa, _ta, from, to, text) => {
    ranges.push({ from, to });
    inserted += text.toString();
  });
  if (!looksSimplified(inserted)) return;
  const doc = app.active;
  toast(t("貼上的內容看起來是簡體中文。"), {
    duration: 10000,
    action: {
      label: t("轉成繁體"),
      run: () => {
        // 貼上的內容還在原處就只轉它；之後又改過內容時改為轉換整份文件（或選取範圍）。
        const state = app.editor.view.state;
        const intact = app.active === doc && ranges.every((r) => r.to <= state.doc.length) &&
          ranges.map((r) => state.sliceDoc(r.from, r.to)).join("") === inserted;
        void convertToTraditional(intact ? ranges : undefined).catch(reportError);
      },
    },
  });
}

export function fixTerms(): void {
  const matches = scanDocument(app.editor.view.state, new Set(app.settings.value.termIgnore));
  const fixes = sureFixes(matches);
  const left = matches.length - fixes.length;
  if (fixes.length) app.editor.view.dispatch({ changes: fixes, userEvent: "input.proofread" });
  if (!matches.length) toast(t("沒有找到中國用語、常見錯字或半形標點。"), { tone: "success" });
  else {
    const parts = [
      fixes.length ? t("已修正 {n} 處（可以按 Ctrl+Z 復原）。", { n: fixes.length }) : "",
      left
        ? app.settings.value.termCheck
          ? t("另有 {n} 處要依文意判斷，已畫上波浪底線，滑鼠移上去可以選擇。", { n: left })
          : t("另有 {n} 處要依文意判斷；打開設定的「檢查兩國用語與錯字」就會標示出來。", { n: left })
        : "",
    ];
    // 英文的句子之間要空一格。
    toast(
      parts.filter(Boolean).join(currentLang() === "en" ? " " : ""),
      { tone: fixes.length ? "success" : "info", duration: left ? 8000 : undefined },
    );
  }
}
export // 在 init 時建立。
let settingsDialog: SettingsDialog;

export function initSettingsUi(): void {
  app.settings.subscribe(applySettings);
  settingsDialog = new SettingsDialog(
    app.settings,
    { get: () => app.themePref, set: app.setTheme },
    desktop && app.ai ? { available: () => desktop!.aiTools(), copyRegistration: (tool) => app.ai!.copyRegistration(tool) } : null,
    app.updater
      ? {
          async version() {
            const v = await app.updater!.version();
            return { label: versionLabel(v), detail: versionDetail(v), title: versionTooltip(v) };
          },
          pending: () => (app.updater!.state.kind === "ready" ? app.updater!.state.version : null),
          checking: () => app.updater!.checking,
          onChange: (fn) => void app.updater!.subscribe(fn),
          check: () => void app.updater!.check(),
          restart: () => app.updater!.restart(),
        }
      : null,
    app.github
      ? {
          account: () => app.github!.account,
          canPublish: () => !!app.workspaceRoot && !isRemote(app.workspaceRoot.path),
          login: () => void app.github!.login(),
          logout: () => void app.github!.logout(),
          openRepo: () => void app.github!.openRepo(),
          publish: () => void app.github!.publish(),
        }
      : null,
    app.ado
      ? {
          account: () => app.ado!.account,
          connect: (url, pat) => app.ado!.connect(url, pat),
          disconnect: () => void app.ado!.disconnect(),
          openRepo: () => void app.ado!.openRepo(),
          workItems: () => showAdo("workitems"),
          check: () => desktop!.adoCheck(),
        }
      : null,
    {
      version: __APP_VERSION__,
      openUrl,
      shortcuts: () => showShortcuts(),
      welcome: () => openWelcome(),
      changelog: () => void openChangelog().catch(reportError),
    },
    {
      panels: () =>
        panelOrder().map((p) => ({ id: p, label: PANEL_LABELS[p](), icon: PANEL_ICONS[p], available: !app.$(`#side-tab-${p}`).hidden })),
      command(id) {
        const c = app.commands.get(id);
        return c ? { title: c.title, icon: c.icon ?? "command" } : null;
      },
      add: () => void addActivityCommand().catch(reportError),
    },
  );
  void app.ado?.ready().then(() => {
    renderAdoTab();
    settingsDialog.refresh();
  });
  // 讀到 GitHub 登入狀態後更新設定頁與原始碼控制面板。
  void app.github?.ready().then(() => {
    settingsDialog.refresh();
    void gitPanel?.refresh();
    void renderIssuesTab();
  });
  document.querySelectorAll<HTMLButtonElement>(".segmented [data-view]").forEach((btn) => {
    const mode = btn.dataset.view as ViewMode;
    const cmd = app.commands.get(`view-${mode}`)!;
    btn.title = app.withKeys(cmd.title, cmd.keys);
    // 視窗窄時只剩圖示（文字藏起來）：螢幕閱讀器仍然要念得出名稱。
    btn.setAttribute("aria-label", btn.querySelector(".label")?.textContent || cmd.title);
    btn.addEventListener("click", () => app.setView(mode));
  });
  // 側邊欄與右邊大綱的寬度：拖曳面板邊緣調整，各自記住。
  for (const [panel, side, key, cssVar] of [
    [app.$("#sidebar"), "left", "sidebar-width", "--outline-width"],
    [app.$("#outline-right"), "right", "outline-right-width", "--outline-right-width"],
  ] as const) {
    const saved = Number(storage.load(key));
    if (saved) document.documentElement.style.setProperty(cssVar, `${clampSidebarWidth(saved)}px`);
    setupSidebarResize(
      app.workspace,
      side,
      () => panel.getBoundingClientRect().width,
      (px) => {
        document.documentElement.style.setProperty(cssVar, `${px}px`);
        storage.save(key, String(px));
        app.editor.view.requestMeasure();
      },
    );
  }
  setupSplitter(app.$("#splitter"), app.workspace, app.splitRatio, (r) => {
    app.splitRatio = r;
    storage.save("split", String(r));
    app.applyLayout();
  });
  app.wideQuery.addEventListener("change", () => app.applyLayout());
  app.narrowQuery.addEventListener("change", () => {
    // 切換到手機寬度時，大綱抽屜先收起來，避免蓋住內容。
    if (app.narrowQuery.matches) app.outlineShown = false;
    app.applyLayout();
  });
  // 手機版：大綱以抽屜方式蓋在內容上，點外面關閉。
  app.workspace.addEventListener("click", (e) => {
    if (app.narrowQuery.matches && app.outlineShown && !(e.target as HTMLElement).closest(".sidebar, .activity-bar")) {
      app.setOutline(false);
    }
  });
}
