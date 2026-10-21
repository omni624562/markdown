/**
 * GitHub Actions 的 Claude Code 工作流程範本（指令「Git：加入 Claude Code 自動校對」寫入
 * `.github/workflows/claude.yml`）。
 * - 開 PR 修改文件時：Claude 用台灣繁體中文校對，在 PR 上留言，不直接改檔案。
 * - 在 issue 或 PR 留言提到 @claude：Claude 照指示處理，必要時開 PR。
 * 使用 anthropics/claude-code-action@v1。
 */
export const CLAUDE_WORKFLOW = `# Claude Code 自動校對與助理（由 Markdown 編輯器建立）
#
# 設定一次：
#   在 GitHub 儲存庫的 Settings → Secrets and variables → Actions 新增 CLAUDE_CODE_OAUTH_TOKEN
#   （在終端機執行 \`claude setup-token\` 取得）。用 API 金鑰的話改設 ANTHROPIC_API_KEY，
#   並把下面兩處的 claude_code_oauth_token 改成 anthropic_api_key。
#   也可以在 Claude Code 裡執行 /install-github-app，它會自動安裝 GitHub App 並設定權杖。
#
# 之後：
#   - 開 PR 修改文件時，Claude 會用台灣繁體中文校對，在 PR 上留言建議（不會直接修改檔案）。
#   - 在 issue 或 PR 留言寫「@claude 請幫我……」，Claude 會照著做，需要修改時會開 PR。
name: Claude Code

on:
  pull_request:
    types: [opened, synchronize]
    paths: ["**/*.md", "**/*.markdown", "**/*.txt"]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened]

jobs:
  proofread:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: |
            REPO: \${{ github.repository }}
            PR NUMBER: \${{ github.event.pull_request.number }}

            請校對這個 PR 修改的文件（Markdown 與純文字），一律用台灣繁體中文與台灣用語回覆：
            - 錯字、標點、語病與不通順的句子
            - 中國大陸用語（例如「軟件」「視頻」「信息」），建議改成台灣用語
            - 中英文之間的空格、全形與半形標點是否一致
            - Markdown 格式（標題層級、清單、表格、連結）
            針對具體的行用行內留言提出建議，最後用 gh pr comment 留一則簡短的總結。不要直接修改檔案。
          claude_args: >-
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"

  assistant:
    if: >-
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'issues' && (contains(github.event.issue.body, '@claude') || contains(github.event.issue.title, '@claude')))
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: >-
            --append-system-prompt "一律用台灣繁體中文與台灣用語回覆，不要使用中國大陸用語。"
`;
