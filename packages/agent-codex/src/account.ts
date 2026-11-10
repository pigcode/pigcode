/**
 * Codex 的登录账号：app-server 的 `account/read` 给出登录方式、ChatGPT 订阅与邮箱，
 * 比 `codex login status` 的一句话多出账号信息，设置页据此显示「谁登录着、什么订阅」。
 */

/** 读出来的账号；loggedIn 为 null 表示应答看不懂，交给 `login status` 再判断。 */
export interface CodexAccount {
  loggedIn: boolean | null
  /** 登录方式与订阅，例如「ChatGPT Pro」「OpenAI API Key」。 */
  label: string | null
  email: string | null
}

/** ChatGPT 订阅档位的显示名；没见过的档位原样显示。 */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Pro Lite",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  self_serve_business_usage_based: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  enterprise_cbp_usage_based: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  unknown: "ChatGPT",
}

/** 非空字符串，否则 null。 */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** 把 `account/read` 的应答收窄成登录状态、显示名与邮箱。 */
export function parseCodexAccount(result: unknown): CodexAccount {
  if (typeof result !== "object" || result === null || !("account" in result)) {
    return { loggedIn: null, label: null, email: null }
  }
  const account = (result as { account?: unknown }).account
  if (typeof account !== "object" || account === null) {
    return { loggedIn: false, label: null, email: null }
  }
  const record = account as Record<string, unknown>
  const type = text(record.type)
  if (type === "chatgpt") {
    const plan = text(record.planType)
    return {
      loggedIn: true,
      label: plan ? (PLAN_LABELS[plan] ?? `ChatGPT ${plan}`) : "ChatGPT",
      email: text(record.email),
    }
  }
  if (type === "apiKey") return { loggedIn: true, label: "OpenAI API Key", email: null }
  if (type === "amazonBedrock") return { loggedIn: true, label: "Amazon Bedrock", email: null }
  return { loggedIn: true, label: type, email: null }
}
