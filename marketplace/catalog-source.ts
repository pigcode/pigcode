/** 内置市场 ID 含有个人市场名称不支持的字符，避免占用旧用户的市场。 */
export const OFFICIAL_MARKETPLACE_ID = "@pigcode/official"
export const OFFICIAL_MARKETPLACE_NAME = "pigcode-official"
export const OFFICIAL_MARKETPLACE_REPO = "https://github.com/pigcode/pigcode"
export const OFFICIAL_MARKETPLACE_BRANCH = "plugin-catalog"
export const OFFICIAL_MARKETPLACE_BASE = `https://raw.githubusercontent.com/pigcode/pigcode/refs/heads/${OFFICIAL_MARKETPLACE_BRANCH}`
export const OFFICIAL_MARKETPLACE_URL = `${OFFICIAL_MARKETPLACE_BASE}/marketplace.json`
