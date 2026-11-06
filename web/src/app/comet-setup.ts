/**
 * COMET 專案的設定（新專案對話框右邊的「② COMET 設定」，見 app/new-project.ts）。
 *
 * - 填寫：oMarker 已經連線 Azure DevOps 時，從清單選專案、團隊、Sprint（預設目前的 Sprint），Sprint 天數從
 *   Sprint 的日期算；指派給預設是 oMarker 目前登入的帳號。沒有連線時改成貼上 Sprint 工作板的網址。
 * - 設定：建立資料夾後，原生端用參數執行 `comet setup --assume-yes`（comet_setup_run，不必回答問題），
 *   對話框顯示每一步與輸出。
 * - 完成：列出建立的檔案；失敗時說原因，可以改在終端機一問一答（`comet setup` 的互動模式）。
 */
import type { AdoAccount, AdoTeam, AdoTeamIteration, CometSetupEvent, CometSetupRequest } from "../desktop.ts";
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

/** 「COMET 設定」那一段的欄位。 */
export interface CometForm {
  /** 讀取 Azure DevOps 的清單（每次打開對話框時）。 */
  load(): Promise<void>;
  /** 欄位都填好時回傳 `comet setup` 的參數（不含資料夾）；還沒填好時回傳 null。 */
  request(): Omit<CometSetupRequest, "dir"> | null;
  /** 填好的設定，給設定中、完成時的「COMET 設定」摘要。 */
  summary(): CometSummaryRow[];
}

const DEFAULT_CADENCE = 14;
const DAY = 24 * 60 * 60 * 1000;

/** 從相鄰兩個 Sprint 的開始日算 Sprint 天數（算不出來時回傳 null）。 */
export function cadenceOf(sprints: AdoTeamIteration[], index: number): number | null {
  const start = (i: number) => (sprints[i]?.start ? Date.parse(sprints[i].start!) : Number.NaN);
  for (const other of [index + 1, index - 1]) {
    const days = Math.round(Math.abs(start(other) - start(index)) / DAY);
    if (Number.isFinite(days) && days >= 1 && days <= 90) return days;
  }
  return null;
}

/** Sprint 的日期範圍，例如「11/2 – 11/13」（沒有日期時回傳空字串）。日期是 Azure DevOps 的 UTC 午夜。 */
export function sprintRange(sprint: { start: string | null; finish: string | null }): string {
  if (!sprint.start || !sprint.finish) return "";
  const md = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  const [a, b] = [md(sprint.start), md(sprint.finish)];
  return a && b ? `${a} – ${b}` : "";
}

/** Sprint 的編號（名稱或路徑最後的數字，例如「Sprint 102」→ 102）；沒有數字時回傳 null。 */
export function sprintNumberOf(sprint: { name: string; path: string }): number | null {
  for (const text of [sprint.name, sprint.path.split("\\").pop() ?? ""]) {
    const m = /(\d+)\s*$/.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Azure DevOps 網頁上這個 Sprint 工作板的網址（comet setup 從網址讀出專案、團隊與 Sprint）。 */
export function sprintBoardUrl(collection: string, project: string, team: string, iterationPath: string): string {
  const parts = iterationPath.split("\\").map(encodeURIComponent).join("/");
  return `${collection.replace(/\/+$/, "")}/${encodeURIComponent(project)}/_sprints/taskboard/${encodeURIComponent(team)}/${parts}`;
}

/** Sprint 工作板網址的格式（`…/_sprints/taskboard/…`）。 */
export function isSprintUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+\/_sprints\/[^\s]+$/i.test(url.trim());
}

/** 建立「COMET 設定」那一段，放進 `host`。欄位改了就呼叫 `changed`（更新「建立並設定」能不能按）。 */
export function cometForm(host: HTMLElement, changed: () => void): CometForm {
  const tr = {
    heading: t("COMET 設定"),
    offNote: t("選「COMET 專案」時才會用到"),
    project: t("Azure DevOps 專案"),
    team: t("團隊"),
    sprint: t("Sprint"),
    cadence: t("Sprint 天數"),
    url: t("Sprint 網址"),
    urlNote: t("oMarker 還沒連線 Azure DevOps：貼上 Sprint 工作板的網址（瀏覽器開啟工作板時網址列上的網址）。到設定連線 Azure DevOps 後，這裡就能直接選。"),
    assigned: t("指派給"),
    assignedNote: t("姓名、完整帳號或員工編號；預設是 oMarker 目前登入的帳號。AreaPath 由團隊設定自動帶入。"),
    assignedAuto: t("oMarker 登入的帳號"),
    change: t("換人"),
    smoke: t("完成後查詢我的工作，確認連得上 Azure DevOps"),
    local: t("設定本機 PATH（第一次使用 COMET 需要）"),
    localDone: t("這台電腦已經設定過"),
  };
  host.innerHTML = `
    <h3><span class="np-num" aria-hidden="true">2</span>${tr.heading}<span class="nc-off-note">${tr.offNote}</span></h3>
    <div class="nc-grid nc-ado">
      <label>${tr.project}<select name="nc-project"></select></label>
      <label>${tr.team}<select name="nc-team"></select></label>
      <label>${tr.sprint}<select name="nc-sprint"></select></label>
    </div>
    <div class="nc-url" hidden>
      <p class="nc-note">${tr.urlNote}</p>
      <div class="nc-grid"><label class="nc-wide">${tr.url}<input name="nc-url" spellcheck="false" autocomplete="off" placeholder="https://…/_sprints/taskboard/…" /></label></div>
    </div>
    <label class="nc-cadence">${tr.cadence}<input name="nc-cadence" type="number" min="1" max="365" value="${DEFAULT_CADENCE}" /></label>
    <div class="nc-who" hidden>
      <span class="nc-who-label">${tr.assigned}</span><span class="nc-who-name"></span><span class="nc-who-note">${tr.assignedAuto}</span>
      <button type="button" class="nc-who-change">${tr.change}</button>
    </div>
    <label class="nc-who-input">${tr.assigned}<input name="nc-assigned" spellcheck="false" autocomplete="off" /><span class="nc-note">${tr.assignedNote}</span></label>
    <label class="pe-check"><input type="checkbox" name="nc-smoke" checked /> ${tr.smoke}</label>
    <label class="pe-check"><input type="checkbox" name="nc-local" checked /> ${tr.local}<span class="nc-local-done" hidden>${tr.localDone}</span></label>`;
  const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const project = q<HTMLSelectElement>("select[name=nc-project]");
  const team = q<HTMLSelectElement>("select[name=nc-team]");
  const sprint = q<HTMLSelectElement>("select[name=nc-sprint]");
  const url = q<HTMLInputElement>("input[name=nc-url]");
  const cadence = q<HTMLInputElement>("input[name=nc-cadence]");
  const assigned = q<HTMLInputElement>("input[name=nc-assigned]");
  const who = q(".nc-who");
  const whoInput = q(".nc-who-input");
  const adoBox = q(".nc-ado");
  const urlBox = q(".nc-url");
  const cadenceLabel = q(".nc-cadence");

  let account: AdoAccount | null = null;
  let teams: AdoTeam[] = [];
  let sprints: AdoTeamIteration[] = [];
  /** 使用者自己改過 Sprint 天數：換 Sprint 時不再自動帶入。 */
  let cadenceTouched = false;
  let seq = 0;

  /** 有連線時從清單選，沒有時貼網址。Sprint 天數放在對應的那一區。 */
  const useAdo = (on: boolean) => {
    adoBox.hidden = !on;
    urlBox.hidden = on;
    (on ? adoBox : urlBox.querySelector(".nc-grid")!).append(cadenceLabel);
  };
  const fill = (select: HTMLSelectElement, options: [string, string][], value: string) => {
    select.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
    select.value = options.some(([v]) => v === value) ? value : (options[0]?.[0] ?? "");
  };
  const autoCadence = () => {
    if (cadenceTouched) return;
    cadence.value = String(cadenceOf(sprints, sprints.findIndex((s) => s.id === sprint.value)) ?? DEFAULT_CADENCE);
  };
  const loadSprints = async (n: number) => {
    const name = teams.find((x) => x.id === team.value)?.name;
    sprints = name ? await desktop!.adoTeamIterations(project.value, name).catch(() => []) : [];
    if (n !== seq) return;
    fill(
      sprint,
      sprints.map((s) => [s.id, s.current ? t("{name}（目前）", { name: s.name }) : s.name]),
      sprints.find((s) => s.current)?.id ?? sprints[sprints.length - 1]?.id ?? "",
    );
    autoCadence();
    changed();
  };
  const loadTeams = async (n: number) => {
    teams = project.value ? await desktop!.adoTeams(project.value).catch(() => []) : [];
    if (n !== seq) return;
    const saved = storage.load("comet-team") ?? storage.load("board-team") ?? "";
    fill(
      team,
      teams.map((x) => [x.id, x.default ? t("{name}（預設）", { name: x.name }) : x.name]),
      teams.some((x) => x.id === saved) ? saved : (teams.find((x) => x.default)?.id ?? ""),
    );
    await loadSprints(n);
  };
  project.addEventListener("change", () => void loadTeams(++seq));
  team.addEventListener("change", () => void loadSprints(++seq));
  sprint.addEventListener("change", () => {
    autoCadence();
    changed();
  });
  cadence.addEventListener("input", () => {
    cadenceTouched = true;
    changed();
  });
  for (const el of [url, assigned]) el.addEventListener("input", changed);
  /** 已經登入 Azure DevOps：「指派給」直接用登入的帳號，只顯示一行（按「換人」才出現輸入框）。 */
  const autoAssign = (on: boolean) => {
    who.hidden = !on;
    whoInput.hidden = on;
  };
  q(".nc-who-change").addEventListener("click", () => {
    autoAssign(false);
    assigned.select();
    assigned.focus();
  });

  // 設定本機 PATH：comet 已經在 PATH 裡（這台電腦做過 COMET 的本機設定）就預設不勾，註明已經設定過。
  // 查詢期間使用者自己改了勾選就照使用者的。
  const local = q<HTMLInputElement>("input[name=nc-local]");
  let localTouched = false;
  local.addEventListener("change", () => (localTouched = true));
  const checkLocal = () => {
    localTouched = false;
    local.checked = true;
    q(".nc-local-done").hidden = true;
    void desktop
      ?.cometPathReady()
      .then((ready) => {
        if (ready !== true || localTouched) return;
        local.checked = false;
        q(".nc-local-done").hidden = false;
      })
      .catch(() => {});
  };

  return {
    async load() {
      const n = ++seq;
      cadenceTouched = false;
      checkLocal();
      cadence.value = String(DEFAULT_CADENCE);
      account = await desktop!.adoAccount().catch(() => null);
      if (n !== seq) return;
      // 指派給：登入的帳號（「網域\帳號」或 Email；沒有時用顯示名稱），已登入時不用填。
      assigned.value = account?.account || account?.name || "";
      const name = account?.name.trim() ?? "";
      const login = account?.account?.trim() ?? "";
      q(".nc-who-name").textContent = name && login && name !== login ? t("{name}（{account}）", { name, account: login }) : name || login;
      autoAssign(assigned.value !== "");
      const projects = account ? await desktop!.adoWorkItemFilters().then((f) => f.projects).catch(() => [] as string[]) : [];
      if (n !== seq) return;
      useAdo(projects.length > 0);
      if (projects.length) {
        const saved = storage.load("comet-project") ?? storage.load("board-project") ?? "";
        fill(
          project,
          projects.map((p) => [p, p]),
          projects.includes(saved) ? saved : projects[0],
        );
        await loadTeams(n);
      }
      changed();
    },
    request() {
      const days = Number(cadence.value);
      const who = assigned.value.trim();
      if (!who || !Number.isInteger(days) || days < 1 || days > 365) return null;
      const common = {
        assignedTo: who,
        cadenceDays: days,
        connectionTest: q<HTMLInputElement>("input[name=nc-smoke]").checked,
        localTools: q<HTMLInputElement>("input[name=nc-local]").checked,
      };
      if (adoBox.hidden) return isSprintUrl(url.value) ? { ...common, sprintUrl: url.value.trim() } : null;
      const tm = teams.find((x) => x.id === team.value);
      const it = sprints.find((s) => s.id === sprint.value);
      if (!account || !project.value || !tm || !it) return null;
      storage.save("comet-project", project.value);
      storage.save("comet-team", tm.id);
      // comet setup --assume-yes 一定要知道 Sprint 編號：從 Sprint 名稱取；名稱沒有編號時改傳工作板網址，由 comet 解析。
      const number = sprintNumberOf(it);
      if (number === null) return { ...common, sprintUrl: sprintBoardUrl(account.url, project.value, tm.name, it.path) };
      return { ...common, collectionUrl: account.url, project: project.value, team: tm.name, iterationPath: it.path, sprintNumber: number };
    },
    summary() {
      const days = t("{n} 天", { n: cadence.value.trim() });
      const who = { label: tr.assigned, value: assigned.value.trim() };
      if (adoBox.hidden) return [{ label: tr.url, value: url.value.trim() }, { label: tr.cadence, value: days }, who];
      const it = sprints.find((s) => s.id === sprint.value);
      const range = it ? sprintRange(it) : "";
      return [
        { label: tr.project, value: project.value },
        { label: tr.team, value: teams.find((x) => x.id === team.value)?.name ?? "" },
        { label: tr.sprint, value: it?.name ?? "", note: range ? `${range}・${days}` : days },
        who,
      ];
    },
  };
}

// ---- 設定中、完成 --------------------------------------------------------------

/** 「COMET 設定」摘要的一行（設定中、完成時右邊的卡片）。 */
export interface CometSummaryRow {
  label: string;
  value: string;
  /** 值後面的淡色說明（例如 Sprint 的日期與天數）。 */
  note?: string;
}

/** `comet setup` 建立的檔案或資料夾（相對於專案資料夾）。 */
export interface CreatedFile {
  /** 資料夾以 `/` 結尾。 */
  path: string;
  /** 後面附的說明（例如「新增 9 份基線文件」）。 */
  note: string;
}

/** `comet setup` 輸出裡建立的檔案（「已建立 / 更新：路徑」「已產生 …：路徑」），換成相對於專案資料夾的路徑。 */
export function createdFiles(lines: string[], dir: string): CreatedFile[] {
  const out: CreatedFile[] = [];
  const root = dir.replace(/[\\/]+$/, "");
  for (const line of lines) {
    const m = /^\s*已(建立 \/ 更新|產生[^：:]*|建立 SDD workspace)[：:]\s*(.+?)\s*$/.exec(line); // i18n-ignore：比對 comet 的輸出
    if (!m) continue;
    let path = m[2];
    let note = "";
    // 路徑後面的括號是說明：「…\docs\spec\（新增 9 份基線文件）」。
    const n = /^(.+?)(?:\s+|(?<=[\\/]))[（(]\s*([^（）()]+?)\s*[)）]$/.exec(path);
    if (n) [path, note] = [n[1], n[2]];
    if (path.toLowerCase().startsWith(root.toLowerCase())) path = path.slice(root.length).replace(/^[\\/]+/, "");
    path = path.replace(/\\/g, "/");
    // SDD workspace 是資料夾。
    if (m[1].includes("SDD") && path && !path.endsWith("/")) path += "/";
    if (path && !out.some((f) => f.path === path)) out.push({ path, note });
  }
  return out;
}

type Step = { label: string; state: "done" | "run" | "wait" | "fail" };

/** 正在執行的設定（同一時間只有一個）：「在背景繼續」關掉對話框後，完成時用通知告訴使用者。 */
let running: { done: Promise<boolean> } | null = null;

export function cometSetupRunning(): boolean {
  return running !== null;
}

/**
 * 在對話框 `d` 的 `view` 裡顯示進度，等 `ready`（切換到新專案）之後執行 `comet setup`，等它結束（成功回傳 true）。
 * 版面：上面是狀態與說明；左邊「做了什麼」（每一步）、右邊「COMET 設定」（`info.summary`）；
 * 下面同一個位置在設定中是即時輸出，完成後是建立的檔案（可以切換成完整輸出）。設定中與完成時對話框一樣大。
 */
export function runCometSetup(
  d: HTMLDialogElement,
  view: HTMLElement,
  req: CometSetupRequest,
  info: { name: string; git: boolean; summary: CometSummaryRow[]; existing?: boolean },
  ready: Promise<unknown> = Promise.resolve(),
): Promise<boolean> {
  // 已經有的專案（設定成 COMET 專案、重新設定）：沒有建立資料夾、Git 儲存庫這兩步。
  const setupStep: Step = { label: t("執行 comet setup"), state: "run" };
  const steps: Step[] = [
    ...(info.existing ? [] : [{ label: t("建立資料夾與 README.md"), state: "done" } as Step]),
    ...(!info.existing && info.git ? [{ label: t("建立 Git 儲存庫"), state: "done" } as Step] : []),
    setupStep,
    ...(req.connectionTest ? [{ label: t("查詢我的工作"), state: "wait" } as Step] : []),
  ];
  const smokeStep = req.connectionTest ? steps[steps.length - 1] : null;
  const tr = { steps: t("做了什麼"), settings: t("COMET 設定"), files: t("建立的檔案") };
  view.innerHTML = `
    <div class="nc-head">
      <span class="nc-badge" aria-hidden="true"></span>
      <div><h2 id="nc-title"></h2><p class="nc-hint"></p></div>
    </div>
    <div class="nc-cols">
      <section class="np-card"><h3>${tr.steps}</h3><ul class="nc-steps"></ul></section>
      <section class="np-card"><h3>${tr.settings}</h3><dl class="nc-summary"></dl></section>
    </div>
    <div class="nc-bottom">
      <section class="np-card nc-files" hidden><h3>${tr.files}<span class="nc-count"></span></h3><ul></ul></section>
      <pre class="nc-log" tabindex="0"></pre>
    </div>
    <div class="nc-foot"><button type="button" class="nc-toggle" hidden></button><div class="choice-actions"></div></div>`;
  const q = <T extends HTMLElement>(sel: string) => view.querySelector<T>(sel)!;
  const badge = q(".nc-badge");
  const title = q("#nc-title");
  const hint = q(".nc-hint");
  const list = q(".nc-steps");
  const log = q(".nc-log");
  const files = q(".nc-files");
  const toggle = q<HTMLButtonElement>(".nc-toggle");
  const actions = q(".choice-actions");
  const lines: string[] = [];

  const head = (state: "run" | "ok" | "fail", heading: string, text: string) => {
    badge.dataset.state = state;
    badge.replaceChildren(...(state === "ok" ? [icon("check")] : state === "fail" ? [icon("x")] : []));
    title.textContent = heading;
    hint.textContent = text;
  };
  const span = (cls: string, text: string) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const renderSteps = () => {
    list.replaceChildren(
      ...steps.map((s) => {
        const li = document.createElement("li");
        li.dataset.state = s.state;
        const mark = document.createElement("span");
        mark.className = "nc-mark";
        if (s.state === "done") mark.append(icon("check"));
        else if (s.state === "fail") mark.append(icon("x"));
        li.append(mark, s.label);
        return li;
      }),
    );
  };
  /** 下面那一格顯示建立的檔案（true）或完整輸出（false）。 */
  const showFiles = (on: boolean) => {
    files.hidden = !on;
    log.hidden = on;
    toggle.textContent = on ? t("顯示完整輸出") : t("顯示建立的檔案");
    if (!on) log.scrollTop = log.scrollHeight;
  };
  const button = (label: string, run: () => void, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "btn btn-primary" : "btn";
    b.textContent = label;
    b.addEventListener("click", run);
    return b;
  };
  const close = () => d.close();
  d.setAttribute("aria-labelledby", "nc-title");
  head("run", t("正在設定「{name}」…", { name: info.name }), t("大約需要半分鐘，不必回答任何問題；可以按「在背景繼續」先做別的事。"));
  q(".nc-summary").replaceChildren(
    ...info.summary.flatMap((row) => {
      const dt = document.createElement("dt");
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.textContent = row.value;
      if (row.note) dd.append(span("nc-sub", row.note));
      return [dt, dd];
    }),
  );
  renderSteps();
  actions.replaceChildren(button(t("在背景繼續"), close));

  const done = new Promise<boolean>((resolve) => {
    let unlisten: (() => void) | null = null;
    const finish = (e: Extract<CometSetupEvent, { kind: "done" }>) => {
      unlisten?.();
      running = null;
      setupStep.state = e.ok ? "done" : "fail";
      if (smokeStep) smokeStep.state = e.ok ? "done" : smokeStep.state === "run" ? "fail" : "wait";
      renderSteps();
      if (e.ok) {
        if (info.existing) {
          head(
            "ok",
            t("「{name}」設定好了", { name: info.name }),
            req.connectionTest ? t("已經是 COMET 專案，也查詢了你的工作，確認連得上 Azure DevOps。") : t("已經是 COMET 專案了。"),
          );
        } else {
          head(
            "ok",
            t("「{name}」建立好了", { name: info.name }),
            req.connectionTest ? t("已切換到這個專案，也查詢了你的工作，確認連得上 Azure DevOps。") : t("已切換到這個專案。"),
          );
        }
        const made = createdFiles(lines, req.dir);
        if (made.length) {
          q(".nc-count").textContent = String(made.length);
          files.querySelector("ul")!.replaceChildren(
            ...made.map((f) => {
              const li = document.createElement("li");
              const code = document.createElement("code");
              code.textContent = f.path;
              code.title = f.path;
              li.append(icon(f.path.endsWith("/") ? "folder" : "file"), code);
              if (f.note) li.append(span("nc-sub", f.note));
              return li;
            }),
          );
          // 成功時下面那一格換成建立的檔案，想看輸出再切換。
          showFiles(true);
          toggle.hidden = false;
        }
        actions.replaceChildren(button(t("完成"), close, true));
      } else {
        head(
          "fail",
          t("「{name}」的 COMET 設定沒有完成", { name: info.name }),
          e.error
            ? t("comet setup 沒有完成：{error}", { error: e.error })
            : t("comet setup 沒有完成（結束代碼 {code}）。", { code: String(e.code ?? "?") }),
        );
        actions.replaceChildren(
          button(t("在終端機重試"), () => {
            close();
            app.terminal?.runCometSetup();
          }),
          button(t("關閉"), close, true),
        );
      }
      if (!d.open) {
        if (e.ok) {
          toast(t("「{name}」的 COMET 設定完成", { name: info.name }), {
            tone: "success",
            action: { label: t("查看"), run: () => d.showModal() },
          });
        } else {
          toast(t("「{name}」的 COMET 設定沒有完成", { name: info.name }), {
            tone: "error",
            duration: 15000,
            action: { label: t("查看"), run: () => d.showModal() },
          });
        }
      }
      resolve(e.ok);
    };
    void ready
      .then(() =>
        desktop!.onCometSetup((e) => {
          if (e.kind === "done") {
            finish(e);
            return;
          }
          lines.push(e.text);
          if (lines.length > 4000) lines.splice(0, lines.length - 4000);
          log.append(`${e.text}\n`);
          if (log.childNodes.length > 4000) log.firstChild?.remove();
          log.scrollTop = log.scrollHeight;
          // my-tasks 開始查詢時，「查詢我的工作」這一步亮起來（看輸出判斷，看不出來也沒關係，結束時一起打勾）。
          if (smokeStep?.state === "wait" && /my-tasks|查詢中/.test(e.text)) { // i18n-ignore：比對 comet 的輸出
            setupStep.state = "done";
            smokeStep.state = "run";
            renderSteps();
          }
        }),
      )
      .then((stop) => {
        unlisten = stop;
        return desktop!.cometSetupRun(req);
      })
      .catch((err) => finish({ kind: "done", ok: false, code: null, error: err instanceof Error ? err.message : String(err) }));
  });
  toggle.addEventListener("click", () => showFiles(files.hidden));
  running = { done };
  return done;
}
