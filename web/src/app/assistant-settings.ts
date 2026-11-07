/**
 * 設定 →「Claude API 助理」那一頁：總開關、API 金鑰、模型、每月上限、哪些專案可以用。
 * 金鑰交給原生端存進 Windows 認證管理員，這裡只顯示有沒有設定。
 */
import { MODEL_LABELS, formatUsd, listed, toggled } from "../assistant-text.ts";
import { type Project, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { CLAUDE_MODELS, type ClaudeModel } from "../settings.ts";
import { askText } from "../ui/choice.ts";
import { toast } from "../ui/toast.ts";
import { assistantKeyChanged } from "./assistant.ts";
import { app } from "./context.ts";

function row(id: string, label: string, hint: string | undefined, control: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "settings-row";
  const text = document.createElement("div");
  const l = document.createElement("label");
  l.htmlFor = `setting-${id}`;
  l.textContent = label;
  text.append(l);
  if (hint) {
    const h = document.createElement("small");
    h.textContent = hint;
    text.append(h);
  }
  if (!control.id) control.id = `setting-${id}`;
  el.append(text, control);
  return el;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-small";
  b.textContent = label;
  b.addEventListener("click", run);
  return b;
}

function switchInput(checked: boolean, onChange: (on: boolean) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.role = "switch";
  input.className = "switch";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

/** 設定裡「Claude API 助理」那一頁的說明與選項。 */
export function assistantSettings(): { desc: string; content: HTMLElement[] } | null {
  const d = desktop;
  if (!d) return null;
  const s = () => app.settings.value;
  const desc = t("用你自己的 Claude API 金鑰，在右側的助理問問題、摘要、改寫、翻譯。只在私人電腦使用，公司電腦請保持關閉；Azure DevOps 的內容一律不會送出。");
  const card = document.createElement("div");
  card.className = "settings-group";
  card.id = "assistant-settings";

  const enabled = switchInput(s().claudeApiEnabled, (on) => app.settings.update({ claudeApiEnabled: on }));
  enabled.dataset.key = "claudeApiEnabled";

  const keyText = document.createElement("span");
  keyText.className = "assistant-key-status";
  const keyBox = document.createElement("span");
  keyBox.className = "setting-buttons";
  const change = button(t("輸入金鑰…"), async () => {
    const key = await askText(t("Claude API 金鑰"), t("貼上 Anthropic Console 建立的 API 金鑰（sk-ant- 開頭）。金鑰存在 Windows 認證管理員，不會存在設定檔。"), "", t("儲存"), true);
    if (!key) return;
    try {
      await d.assistantKeySet(key);
      toast(t("已儲存 API 金鑰"), { tone: "success" });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "error" });
    }
    void refreshKey();
  });
  const remove = button(t("移除"), async () => {
    await d.assistantKeyForget().catch(() => {});
    void refreshKey();
  });
  keyBox.append(keyText, change, remove);
  const refreshKey = async () => {
    const has = await d.assistantKeyStatus().catch(() => false);
    keyText.textContent = has ? t("已存在 Windows 認證管理員") : t("還沒設定");
    change.textContent = has ? t("更換…") : t("輸入金鑰…");
    remove.hidden = !has;
    assistantKeyChanged();
  };

  const model = document.createElement("select");
  for (const m of CLAUDE_MODELS) model.append(new Option(MODEL_LABELS[m](), m));
  model.value = s().claudeModel;
  model.addEventListener("change", () => app.settings.update({ claudeModel: model.value as ClaudeModel }));

  const limitBox = document.createElement("span");
  limitBox.className = "setting-buttons";
  const limit = document.createElement("input");
  limit.type = "number";
  limit.min = "0";
  limit.max = "1000";
  limit.step = "1";
  limit.value = String(s().claudeMonthlyLimit);
  limit.setAttribute("aria-label", t("每月上限（美元）"));
  limit.addEventListener("change", () => {
    const n = Number(limit.value);
    if (Number.isFinite(n) && n >= 0 && n <= 1000) app.settings.update({ claudeMonthlyLimit: n });
    else limit.value = String(s().claudeMonthlyLimit);
  });
  const used = document.createElement("small");
  limitBox.append(document.createTextNode("US$"), limit, used);
  const refreshUsage = async () => {
    const u = await d.assistantUsage().catch(() => null);
    used.textContent = u ? t("本月已用 {usd}", { usd: formatUsd(u.usd) }) : "";
  };

  const projectsTitle = document.createElement("h5");
  projectsTitle.className = "assistant-projects-title";
  projectsTitle.textContent = t("哪些專案可以使用 AI");
  const projects = document.createElement("div");
  projects.className = "assistant-projects";
  const projectsHint = document.createElement("small");
  projectsHint.className = "assistant-projects-hint";
  projectsHint.textContent = t("新專案預設不允許。Azure DevOps 下載的儲存庫就算打開也不會送出。");
  const renderProjects = (list: Project[]) => {
    const paths = new Map(list.map((p) => [p.path, p.label]));
    const root = app.workspaceRoot;
    if (root && ![...paths.keys()].some((p) => listed([p], root.path))) paths.set(root.path, root.name);
    // 允許過、但已經不在專案清單裡的資料夾也列出來，才能取消。
    for (const p of s().assistantProjects) if (![...paths.keys()].some((k) => listed([k], p))) paths.set(p, p);
    if (!paths.size) {
      const empty = document.createElement("small");
      empty.textContent = t("還沒有專案。開啟資料夾後會出現在這裡。");
      projects.replaceChildren(empty);
      return;
    }
    projects.replaceChildren(
      ...[...paths].map(([path, label], i) => {
        const input = switchInput(listed(s().assistantProjects, path), (on) =>
          app.settings.update({ assistantProjects: toggled(s().assistantProjects, path, on) }),
        );
        input.setAttribute("aria-label", t("「{name}」可以使用 AI", { name: label }));
        const r = row(`assistant-project-${i}`, label, path === label ? undefined : path, input);
        r.title = path;
        return r;
      }),
    );
  };
  const refreshProjects = async () => renderProjects(await d.projects().catch(() => []));

  const dependents = document.createElement("div");
  dependents.className = "assistant-dependents";
  dependents.append(
    row("assistant-key", t("API 金鑰"), t("在 Anthropic Console 建立；費用算在這把金鑰上"), keyBox),
    row("claudeModel", t("預設模型"), t("Haiku 最便宜、Opus 最強；側欄也可以臨時換"), model),
    row("claudeMonthlyLimit", t("每月上限"), t("這個月估計的費用到了上限就停止送出"), limitBox),
    projectsTitle,
    projects,
    projectsHint,
  );
  card.append(
    row("claudeApiEnabled", t("啟用 Claude API 助理"), t("只在私人電腦開啟；開啟時會再確認一次"), enabled),
    dependents,
  );

  const sync = () => {
    enabled.checked = s().claudeApiEnabled;
    dependents.classList.toggle("is-off", !s().claudeApiEnabled);
    model.value = s().claudeModel;
    if (limit !== document.activeElement) limit.value = String(s().claudeMonthlyLimit);
  };
  app.settings.subscribe((_, changed) => {
    sync();
    if (changed.includes("assistantProjects")) void refreshProjects();
  });
  sync();
  void refreshKey();
  void refreshUsage();
  void refreshProjects();
  // 每次打開設定時更新用量與專案清單。
  card.addEventListener("assistant-refresh", () => {
    void refreshUsage();
    void refreshProjects();
  });
  return { desc, content: [card] };
}
