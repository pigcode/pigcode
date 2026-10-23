/** 输入框建议列表的匹配：按子序列模糊匹配打分，文件名命中优先于目录命中。 */

/** 子序列匹配得分；不匹配返回 -1。连续命中、词首命中加分，越靠前越好。 */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  let score = 0
  let from = 0
  let previous = -2
  for (const char of needle) {
    const index = haystack.indexOf(char, from)
    if (index < 0) return -1
    score += index === previous + 1 ? 3 : 1
    const before = haystack[index - 1]
    if (index === 0 || before === "/" || before === "-" || before === "_" || before === ".")
      score += 2
    previous = index
    from = index + 1
  }
  return score - haystack.length * 0.01
}

/** 过滤文件路径：文件名匹配得分翻倍，结果最多 limit 条。 */
export function matchFiles(files: readonly string[], query: string, limit = 50): string[] {
  if (!query) return files.slice(0, limit)
  const scored: Array<{ path: string; score: number }> = []
  for (const path of files) {
    const name = path.slice(path.lastIndexOf("/") + 1)
    const nameScore = fuzzyScore(name, query)
    const pathScore = fuzzyScore(path, query)
    const score = Math.max(nameScore >= 0 ? nameScore * 2 : -1, pathScore)
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort((left, right) => right.score - left.score || left.path.length - right.path.length)
  return scored.slice(0, limit).map((entry) => entry.path)
}

/** 按标签与关键字过滤条目，保持原有顺序里的相对次序。 */
export function matchByLabel<T extends { label: string; keywords?: readonly string[] | undefined }>(
  items: readonly T[],
  query: string,
): T[] {
  if (!query) return [...items]
  return items
    .map((item) => ({
      item,
      score: Math.max(
        fuzzyScore(item.label, query),
        ...(item.keywords ?? []).map((keyword) => fuzzyScore(keyword, query)),
      ),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item)
}
