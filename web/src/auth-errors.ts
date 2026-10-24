/**
 * 從錯誤訊息判斷是不是登入的問題（GitHub 登入過期、Azure DevOps／TFS 權杖過期），好在通知上直接附上重新登入的按鈕。
 * 訊息來自後端（中文或英文介面），所以兩種語言的寫法都要認得。
 */

export type AuthProblem = "github" | "ado";

export function authProblem(message: string): AuthProblem | null {
  if (/已取消登入|sign-in was cancel/i.test(message)) return null; // i18n-ignore：比對後端訊息
  if (/GitHub/.test(message) && /登入|sign(?:ed)?[ -]in|log ?in/i.test(message)) return "github"; // i18n-ignore
  if (/個人存取權杖|personal access token/i.test(message)) return "ado"; // i18n-ignore
  return null;
}
