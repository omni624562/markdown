/**
 * Git：合併衝突、分支、Pull Request；GitHub Pages、Gist。
 */
import type { Command } from "../commands.ts";
import { desktop, isRemote } from "../desktop.ts";
import { stem } from "../files.ts";
import { t } from "../i18n.ts";
import { basename } from "../paths.ts";
import { askText, choose } from "../ui/choice.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { openGitHistory } from "./git-history.ts";
import { createWorkItemDialog, createWorkItemFromSelection, copySelection, pasteFromClipboard } from "./new-work-item.ts";
import { keptPicker, keptPages } from "./offline-copies.ts";
import { openWikiHistory } from "./wiki-history.ts";
import { gitPanel, showAdo } from "./work-item-updates.ts";
import { issuesRepo } from "./work-items-panel.ts";
import { selectAll, indentMore, indentLess } from "@codemirror/commands";
import { app } from "./context.ts";


/** 開啟衝突的檔案（磁碟上是都採用本機的內容），逐段和「都採用遠端」比較。 */
export async function resolveMergeConflict(path: string, theirs: string): Promise<void> {
  const existing = app.tabForPath(path);
  if (existing) {
    app.activate(existing);
    await app.reloadDoc(existing, path);
  } else {
    await app.openPath(path);
  }
  if (app.fileHandle?.path !== path) return;
  if (app.review.active) app.review.finish();
  const started = app.review.start(theirs, {
    title: t("合併衝突：「{name}」", { name: basename(path) }),
    hint: t("每一段選「採用遠端」或「保留本機」，處理完存檔，再到原始碼控制按「完成合併」"),
    acceptLabel: t("採用遠端"),
    rejectLabel: t("保留本機"),
  });
  if (!started) toast(t("這個檔案已經處理好了，存檔後按「完成合併」。"));
  app.showPanel("git", false);
}

type BranchChoice = { name: string; kind: "local" | "remote" | "new" };

export async function switchBranch(): Promise<void> {
  if (!desktop) return;
  const b = await desktop.gitBranches();
  const items: BranchChoice[] = [
    { name: "", kind: "new" },
    ...b.local.map((name) => ({ name, kind: "local" as const })),
    ...b.remote.map((name) => ({ name, kind: "remote" as const })),
  ];
  new Picker<BranchChoice>({
    label: t("切換分支"),
    placeholder: t("目前在「{branch}」，選要切換的分支", { branch: b.current ?? t("（未知）") }),
    empty: t("找不到符合的分支"),
    query: (q) => {
      const needle = q.trim().toLowerCase();
      return items.filter((i) => i.kind === "new" || !needle || i.name.toLowerCase().includes(needle));
    },
    render: (i) =>
      i.kind === "new"
        ? { title: t("建立新分支…"), detail: t("從目前的提交建立，並切換過去"), icon: "plus" }
        : {
            title: i.name,
            detail: i.name === b.current ? t("目前的分支") : i.kind === "remote" ? t("遠端的分支（會在本機建立）") : "",
            icon: "git-branch",
          },
    pick: (i) => void (i.kind === "new" ? createBranch() : checkoutBranch(i.name)).catch(reportError),
  }).open();
}

async function checkoutBranch(name: string): Promise<void> {
  if (!desktop) return;
  if (app.docs.some((d) => d.dirty)) {
    toast(t("有分頁還沒存檔，請先存檔再切換分支。"), { tone: "error" });
    return;
  }
  toast(await desktop.gitCheckout(name), { tone: "success" });
  await gitPanel?.refresh();
  await app.fileTree?.refresh();
}

async function createBranch(): Promise<string | null> {
  if (!desktop) return null;
  const name = await askText(t("建立新分支"), t("分支名稱（例如 draft、fix-typo，不能有空白）："), "", t("建立"));
  if (!name?.trim()) return null;
  toast(await desktop.gitCreateBranch(name.trim()), { tone: "success" });
  await gitPanel?.refresh();
  return name.trim();
}

/** 建立 Pull Request：在預設分支上時先建立新分支，推送後在 GitHub 或 Azure DevOps 建立。 */
/** 拉取遠端的更新，再推送自己的提交（拉取失敗或有衝突時不推送）。 */
async function gitSync(): Promise<void> {
  if (!gitPanel) return;
  app.showPanel("git");
  await gitPanel.pull();
  if (gitPanel.status?.merging) return;
  await gitPanel.push();
}

export async function createPullRequest(): Promise<void> {
  const status = gitPanel?.status;
  if (!desktop || !status?.repo) return;
  if (status.changes.length) {
    toast(t("還有未提交的變更，請先提交再建立 Pull Request。"));
    app.showPanel("git");
    return;
  }
  const branch = status.branch?.name ?? "";
  let newBranch: string | null = null;
  if (/^(main|master|develop|trunk)$/i.test(branch)) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    newBranch = await askText(
      t("建立 Pull Request"),
      t("目前在「{branch}」。Pull Request 需要另一個分支，會用這個名稱建立新分支並推送：", { branch }),
      `update-${stamp}`,
      t("下一步"),
    );
    if (!newBranch?.trim()) return;
  }
  const title = await askText(t("建立 Pull Request"), t("標題："), "", t("建立"));
  if (!title?.trim()) return;
  const wait = toast(t("正在推送並建立 Pull Request…"), { duration: 600000 });
  try {
    const url = await desktop.gitCreatePr(title.trim(), t("由 oMarker 建立"), newBranch?.trim() || null);
    wait.dismiss();
    toast(t("已建立 Pull Request"), {
      tone: "success",
      duration: 15000,
      action: { label: t("在瀏覽器開啟"), run: () => void desktop!.openExternal(url) },
    });
  } catch (e) {
    wait.dismiss();
    reportError(e);
  } finally {
    await gitPanel?.refresh();
  }
}

/** 用 GitHub Pages 把資料夾發佈成網站。 */
async function publishPages(): Promise<void> {
  if (!desktop) return;
  const ok = await choose(
    t("發佈成網站（GitHub Pages）"),
    t("會把這個儲存庫預設分支的內容發佈成網站，所有人都看得到（就算儲存庫是私人的）。Markdown 會自動轉成網頁，README.md 或 index.md 是首頁。第一次發佈大約要一兩分鐘才看得到。"),
    [
      { id: "cancel", label: t("取消") },
      { id: "go", label: t("發佈"), primary: true },
    ],
  );
  if (ok !== "go") return;
  const wait = toast(t("正在設定 GitHub Pages…"), { duration: 60000 });
  try {
    const url = await desktop.githubPages();
    wait.dismiss();
    toast(t("網站網址：{url}（之後推送就會自動更新）", { url: url.replace(/^https:\/\//, "") }), {
      tone: "success",
      duration: 20000,
      action: { label: t("開啟網站"), run: () => void desktop!.openExternal(url) },
    });
  } catch (e) {
    wait.dismiss();
    reportError(e);
  }
}

/** 把選取的內容（沒有選取時是整份文件）分享成 Gist。 */
async function shareGist(): Promise<void> {
  if (!desktop) return;
  const sel = app.editor.view.state.selection.main;
  const content = sel.empty ? app.editor.text : app.editor.view.state.sliceDoc(sel.from, sel.to);
  if (!content.trim()) {
    toast(t("沒有內容可以分享。"));
    return;
  }
  const visibility = await choose(
    t("分享成 Gist"),
    sel.empty
      ? t("會把整份「{name}」上傳到你的 GitHub Gist，產生一個可以分享的網址。", { name: app.fileName })
      : t("會把選取的內容上傳到你的 GitHub Gist，產生一個可以分享的網址。"),
    [
      { id: "cancel", label: t("取消") },
      { id: "public", label: t("公開（所有人都找得到）") },
      { id: "secret", label: t("秘密（知道網址的人才看得到）"), primary: true },
    ],
  );
  if (visibility !== "public" && visibility !== "secret") return;
  const wait = toast(t("正在上傳…"), { duration: 60000 });
  try {
    const url = await desktop.githubGist(app.fileName, content, stem(app.fileName), visibility === "public");
    wait.dismiss();
    await navigator.clipboard.writeText(url).catch(() => {});
    toast(t("已分享成 Gist，網址已複製"), {
      tone: "success",
      duration: 15000,
      action: { label: t("在瀏覽器開啟"), run: () => void desktop!.openExternal(url) },
    });
  } catch (e) {
    wait.dismiss();
    reportError(e);
  }
}

/** 外部修改後，以修改前的版本為基準逐段標示（A4）。沒有差異時回傳 false。 */
export function showExternalChanges(original: string, current: string): boolean {
  return app.review.start(current, {
    original,
    source: "external",
    title: t("「{name}」被外部程式修改了", { name: app.fileName }),
    hint: t("逐段檢查改了哪裡；選「還原」後記得存檔"),
    acceptLabel: t("保留"),
    rejectLabel: t("還原"),
  });
}

export function reportError(e: unknown): void {
  console.error(e);
  const message = e instanceof Error ? e.message : String(e);
  // 訊息本身已經說了哪個動作失敗（「無法儲存…」「拉取失敗：…」）：不再加上「操作失敗」。
  const described = /^(無法|不能|找不到|Couldn't|Can't|Cannot|Unable)/i.test(message) || /^[^：:]{1,24}(失敗|failed)[：:]/i.test(message);
  toast(described ? message : t("操作失敗：{error}", { error: message }), { tone: "error" });
}

export function initGitActions(): void {
  app.commands.register(
    {
      id: "toggle-terminal",
      title: t("顯示／隱藏終端機"),
      group: t("AI 與終端機"),
      icon: "square-terminal",
      keys: "Mod-`",
      when: () => !!app.terminal,
      run: () => app.terminal?.toggle(),
    },
    {
      id: "ai-actions",
      title: t("AI：處理選取的文字…"),
      group: t("AI 與終端機"),
      icon: "sparkles",
      keys: "Mod-j",
      when: () => !!app.ai?.enabled && app.view !== "preview",
      run() {
        const { from, to } = app.editor.view.state.selection.main;
        if (from === to) toast(t("請先選取要處理的文字。"));
        else app.aiPicker.open();
      },
    },
    ...(
      [
        [
          "git-commit",
          t("Git：提交變更…"),
          "git-commit-horizontal",
          () => {
            app.showPanel("git");
            gitPanel?.focusMessage();
          },
        ],
        ["git-pull", t("Git：拉取"), "arrow-down-to-line", () => gitPanel?.pull()],
        ["git-push", t("Git：推送"), "arrow-up-from-line", () => gitPanel?.push()],
      ] as const
    ).map(
      ([id, title, iconName, run]): Command => ({
        id,
        title,
        group: t("檔案"),
        icon: iconName,
        when: () => !!gitPanel?.status?.repo,
        run: () => void run(),
      }),
    ),
    ...(
      [
        ["github-open", t("GitHub：下載或開啟儲存庫…"), "github", () => app.github?.openRepo(), () => true],
        ["github-publish", t("GitHub：把這個資料夾上傳到 GitHub…"), "arrow-up-from-line", () => app.github?.publish(), () => !!app.workspaceRoot && !isRemote(app.workspaceRoot.path)],
        ["github-login", t("GitHub：登入"), "shield-check", () => app.github?.login(), () => !app.github?.account],
        ["github-logout", t("GitHub：登出"), "x", () => app.github?.logout(), () => !!app.github?.account],
        [
          "git-commit",
          t("Git：提交變更…"),
          "git-commit-horizontal",
          () => {
            app.showPanel("git");
            gitPanel?.focusMessage();
          },
          () => !!gitPanel?.status?.repo,
        ],
        ["git-sync", t("Git：同步（拉取再推送）"), "arrow-down-up", () => void gitSync(), () => !!gitPanel?.status?.remote && !gitPanel.status.merging],
        ["git-branch-switch", t("Git：切換或建立分支…"), "git-branch", () => void switchBranch().catch(reportError), () => !!gitPanel?.status?.repo && !gitPanel.status.merging],
        ["git-create-pr", t("Git：建立 Pull Request…"), "git-pull-request", () => void createPullRequest().catch(reportError), () => !!gitPanel?.status?.remote],
        ["git-merge-finish", t("Git：完成合併"), "git-merge", () => void gitPanel?.finishMerge(), () => !!gitPanel?.status?.merging],
        ["github-pages", t("GitHub：發佈成網站（GitHub Pages）…"), "globe", () => void publishPages(), () => !!app.github?.account && !!issuesRepo],
        ["github-gist", t("GitHub：分享成 Gist…"), "share-2", () => void shareGist(), () => !!app.github?.account],
        ["ado-open", t("Azure DevOps／TFS：下載或開啟儲存庫、Wiki…"), "briefcase-business", () => app.ado?.openRepo(), () => !!app.ado],
        ["ado-items", t("Azure DevOps／TFS：工作項目"), "square-kanban", () => showAdo("workitems"), () => !!app.ado?.account],
        ["ado-wiki", t("Azure DevOps／TFS：Wiki"), "book-open-text", () => showAdo("wiki"), () => !!app.ado?.account],
        ["ado-offline", t("Azure DevOps／TFS：保留離線的頁面…"), "download", () => keptPicker.open(), () => !!desktop && keptPages.length > 0],
        ["ado-connect", t("Azure DevOps／TFS：連線設定…"), "shield-check", () => app.settingsDialog.open(t("Azure DevOps／TFS")), () => !!app.ado],
        ["ado-create-work-item", t("Azure DevOps／TFS：建立工作項目…"), "plus", () => createWorkItemDialog(), () => !!app.ado?.account],
        [
          "ado-create-from-selection",
          t("Azure DevOps／TFS：用選取的文字建立工作項目…"),
          "plus",
          () => createWorkItemFromSelection(),
          () => !!app.ado?.account && app.kind === "markdown" && !app.editor.view.state.selection.main.empty,
        ],
      ] as const
    ).map(
      ([id, title, iconName, run, when]): Command => ({
        id,
        title,
        group: "Git",
        icon: iconName,
        when: () => !!app.github && when(),
        run: () => void run(),
      }),
    ),
    {
      id: "open-recent",
      title: t("最近開啟…"),
      group: t("檔案"),
      icon: "clock",
      when: () => !!desktop,
      run: () => app.recentPicker.open(),
    },
    {
      id: "activity-add",
      title: t("圖示列：新增按鈕…"),
      group: t("檢視"),
      icon: "plus",
      run: () => app.addActivityCommand(),
    },
    {
      id: "activity-customize",
      title: t("圖示列：自訂…"),
      group: t("檢視"),
      icon: "settings",
      run: () => app.settingsDialog.open(t("外觀")),
    },
    {
      id: "git-history",
      title: t("Git：顯示歷史（線圖）"),
      group: t("Git"),
      icon: "git-graph",
      keys: "Mod-Alt-h",
      when: () => !!desktop && !!gitPanel?.status?.repo,
      run: () => openGitHistory(),
    },
    {
      id: "git-file-history",
      title: t("Git：這個檔案的提交歷史…"),
      group: t("Git"),
      icon: "git-commit-horizontal",
      when: () => !!desktop && !!app.fileHandle?.path && !!gitPanel?.status?.repo,
      run: () => openGitHistory(app.fileHandle?.path ?? null),
    },
    {
      id: "git-open-web",
      title: t("Git：在網頁上開啟這個檔案（GitHub／Azure DevOps）"),
      group: t("Git"),
      icon: "external-link",
      when: () => !!desktop && !!app.fileHandle?.path && !!gitPanel?.status?.remote,
      run: () => void app.openOnWeb().catch(reportError),
    },
    {
      id: "git-copy-link",
      title: t("Git：複製這個檔案的網頁連結"),
      group: t("Git"),
      icon: "link",
      when: () => !!desktop && !!app.fileHandle?.path && !!gitPanel?.status?.remote,
      run: () => void app.copyWebLink().catch(reportError),
    },
    {
      id: "wiki-history",
      title: t("Wiki 頁面的修改記錄…"),
      group: t("檔案"),
      icon: "history",
      when: () => !!desktop && (!!app.active.wiki || (app.issueView.isOpen && !!app.wikiPage && !app.wikiPage.wiki.code)),
      run: () => {
        if (app.issueView.isOpen && app.wikiPage) {
          const { wiki, path } = app.wikiPage;
          openWikiHistory({ projectId: wiki.projectId, wikiId: wiki.id, repositoryId: wiki.repositoryId, path }, wiki);
        } else if (app.active.wiki) openWikiHistory(app.active.wiki, null);
      },
    },
    {
      id: "history",
      title: t("版本記錄…"),
      group: t("檔案"),
      icon: "history",
      when: () => !!desktop && !!app.fileHandle?.path,
      run: () => app.historyPicker.open(),
    },
    {
      id: "check-update",
      title: t("檢查更新"),
      group: t("說明"),
      icon: "refresh-cw",
      when: () => !!app.updater,
      run: () => app.updater?.check(),
    },
    {
      id: "ai-cancel",
      title: t("AI：取消處理中的動作"),
      group: t("AI 與終端機"),
      icon: "circle-stop",
      when: () => !!app.ai?.running,
      run: () => app.ai?.cancel(),
    },
    ...(["claude", "codex"] as const).map(
      (tool): Command => ({
        id: `start-${tool}`,
        title: t("AI：在終端機啟動 {tool}", { tool: tool === "claude" ? "Claude Code" : "Codex" }),
        group: t("AI 與終端機"),
        icon: "sparkles",
        // 沒開啟 AI 協作或沒安裝時也列出來，按下去說明怎麼開始，而不是找不到這個功能。
        when: () => !!app.terminal,
        run: () => void app.startAiTool(tool),
      }),
    ),
    {
      id: "insert-work-item-link",
      title: t("插入工作項目連結…"),
      group: t("插入"),
      icon: "square-kanban",
      when: () => !!desktop && !!app.ado?.account && app.kind === "markdown" && app.view !== "preview",
      run: () => app.workItemLinkPicker.open(),
    },
    {
      id: "insert-wiki-link",
      title: t("插入 Wiki 頁面連結…"),
      group: t("插入"),
      icon: "book-open-text",
      when: () => !!desktop && !!app.ado?.account && app.kind === "markdown" && app.view !== "preview",
      run: () => app.wikiLinkPicker.open(),
    },
    {
      id: "insert-symbol",
      title: t("插入符號…"),
      group: t("插入"),
      icon: "omega",
      keys: "Mod-Alt-s",
      when: () => app.view !== "preview",
      run: () => app.symbolPicker.open(),
    },
    ...(
      [
        ["cut", t("剪下"), "scissors", "Mod-x", () => copySelection(true)],
        ["copy", t("複製"), "copy", "Mod-c", () => copySelection(false)],
        ["paste", t("貼上"), "clipboard-paste", "Mod-v", () => pasteFromClipboard(false)],
        ["paste-plain", t("貼上純文字"), "clipboard-type", "Mod-Shift-v", () => pasteFromClipboard(true)],
        ["select-all", t("全選"), "text-cursor", "Mod-a", () => app.editor.exec(selectAll)],
        ["indent-more", t("增加縮排"), "list-indent-increase", "Tab", () => app.editor.exec(indentMore)],
        ["indent-less", t("減少縮排"), "list-indent-decrease", "Shift-Tab", () => app.editor.exec(indentLess)],
      ] as const
    ).map(
      ([id, title, iconName, shownKeys, run]): Command => ({
        id,
        title,
        group: t("編輯"),
        icon: iconName,
        shownKeys,
        when: () =>
          app.view !== "preview" && ((id !== "cut" && id !== "copy") || !app.editor.view.state.selection.main.empty),
        run: () => void run(),
      }),
    ),
    {
      id: "send-to-terminal-ai",
      title: t("AI：把選取範圍傳給終端機中的 Claude Code／Codex"),
      group: t("AI 與終端機"),
      icon: "square-terminal",
      keys: "Mod-Alt-j",
      when: () => app.terminalAiReady() && app.view !== "preview",
      run: () => app.sendSelectionToAi(),
    },
    {
      id: "ai-settings",
      title: t("AI 協作設定…"),
      group: t("AI 與終端機"),
      icon: "sparkles",
      when: () => !!desktop,
      run: () => app.settingsDialog.open(t("AI 協作")),
    },
    {
      id: "git-claude-workflow",
      title: t("Git：加入 Claude Code 自動校對（GitHub Actions）…"),
      group: t("Git"),
      icon: "github",
      when: () => !!gitPanel?.status?.repo && !!app.workspaceRoot && !isRemote(app.workspaceRoot.path),
      run: () => app.addClaudeWorkflow(),
    },
  );
  // 全域快速鍵：在捕獲階段處理，確保焦點在任何地方都一致。
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing || document.querySelector("dialog[open]")) return;
      const cmd = app.commands.match(e);
      if (!cmd) return;
      const target = e.target as HTMLElement;
      // 終端機裡的按鍵大多要交給終端機（例如 Ctrl+W、Ctrl+P），只保留少數全域快速鍵。
      if (target.closest(".terminal-panel") && !app.TERMINAL_KEYS.has(cmd.id)) return;
      const inField =
        (target.matches("input, select, textarea") && !target.closest(".cm-editor")) || target.isContentEditable && !!target.closest(".cm-lp-table");
      if (inField && (cmd.group === t("格式") || cmd.group === t("插入"))) return;
      e.preventDefault();
      e.stopPropagation();
      app.commands.run(cmd.id).catch(reportError);
    },
    { capture: true },
  );
}
