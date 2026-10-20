/** 把 model/list 的未知响应收窄为 Pigcode 的模型条目。 */
export interface CodexModelInfo {
  id: string
  displayName: string
  isDefault: boolean
}

/** 兼容 data/models 两种列表包裹，并跳过缺少 id 的条目。 */
export function parseCodexModels(value: unknown): CodexModelInfo[] {
  if (typeof value !== "object" || value === null) return []
  const record = value as Record<string, unknown>
  const raw = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const result: CodexModelInfo[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const model = item as Record<string, unknown>
    const id =
      typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : null
    if (!id) continue
    result.push({
      id,
      displayName:
        typeof model.displayName === "string"
          ? model.displayName
          : typeof model.name === "string"
            ? model.name
            : id,
      isDefault: model.isDefault === true,
    })
  }
  return result
}
