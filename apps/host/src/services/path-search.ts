/**
 * 按路径模糊搜索文件与目录：查询词的字符按顺序出现在路径里即算命中，
 * 命中在文件名里、在词首、连续出现的排在前面。文件列表按根目录短时缓存。
 */
import { listFiles } from "./workspace-files"

/** 一条命中。 */
export interface PathMatch {
  path: string
  kind: "file" | "directory"
}

/** 搜索结果；truncated 表示命中数超过上限。 */
export interface PathSearchResult {
  entries: PathMatch[]
  truncated: boolean
}

const SEPARATORS = new Set(["/", "-", "_", ".", " "])

/** 在 text 里按顺序匹配 query 的每个字符；返回得分，不命中时为 null。两者都已转小写。 */
function subsequenceScore(text: string, original: string, query: string): number | null {
  let score = 0
  let position = 0
  let previous = -2
  for (const char of query) {
    const index = text.indexOf(char, position)
    if (index === -1) return null
    const before = original[index - 1]
    const current = original[index] ?? ""
    if (index === 0 || (before !== undefined && SEPARATORS.has(before))) score += 8
    else if (before !== undefined && /[a-z0-9]/.test(before) && /[A-Z]/.test(current)) score += 6
    if (index === previous + 1) score += 5
    score += 1 - Math.min(index - position, 10) * 0.15
    previous = index
    position = index + 1
  }
  return score
}

/**
 * 给一条路径打分：查询词能在文件名里匹配上时按文件名计分并额外加分，
 * 完全相同与前缀匹配再加分；路径越短越靠前。空格分开的多个词都要命中。
 */
export function scorePath(path: string, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const lowerPath = path.toLowerCase()
  const slash = path.lastIndexOf("/")
  const name = path.slice(slash + 1)
  const lowerName = name.toLowerCase()
  let total = 0
  for (const word of words) {
    const inName = subsequenceScore(lowerName, name, word)
    if (inName !== null) {
      total += inName + 20
      if (lowerName === word) total += 50
      else if (lowerName.startsWith(word)) total += 25
      continue
    }
    const inPath = subsequenceScore(lowerPath, path, word)
    if (inPath === null) return null
    total += inPath
  }
  return total - path.length * 0.05
}

/** 由文件路径推出全部祖先目录。 */
function directoriesOf(files: readonly string[]): string[] {
  const directories = new Set<string>()
  for (const file of files) {
    let slash = file.indexOf("/")
    while (slash !== -1) {
      directories.add(file.slice(0, slash))
      slash = file.indexOf("/", slash + 1)
    }
  }
  return [...directories]
}

/** 在文件与目录里搜索，按得分排序，最多返回 limit 条。 */
export function searchPaths(
  files: readonly string[],
  query: string,
  limit = 200,
): PathSearchResult {
  const scored: Array<{ match: PathMatch; score: number }> = []
  for (const path of files) {
    const score = scorePath(path, query)
    if (score !== null) scored.push({ match: { path, kind: "file" }, score })
  }
  for (const path of directoriesOf(files)) {
    const score = scorePath(path, query)
    // 目录略微靠后：同样的分数时用户通常要找的是文件。
    if (score !== null) scored.push({ match: { path, kind: "directory" }, score: score - 1 })
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.match.path.length - right.match.path.length ||
      left.match.path.localeCompare(right.match.path),
  )
  return {
    entries: scored.slice(0, limit).map((item) => item.match),
    truncated: scored.length > limit,
  }
}

/** 文件列表缓存：搜索框每次按键都会查询，列表 10 秒内复用，保存文件后立即失效。 */
export interface PathIndex {
  files(root: string): Promise<string[]>
  invalidate(root?: string): void
}

/** 创建文件列表缓存；同一根目录的并发读取共享一次 git ls-files。 */
export function createPathIndex(options: { ttlMs?: number; now?: () => number } = {}): PathIndex {
  const ttlMs = options.ttlMs ?? 10_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { files: Promise<string[]>; expiresAt: number }>()
  return {
    files(root) {
      const cached = entries.get(root)
      if (cached && cached.expiresAt > now()) return cached.files
      const files = listFiles(root)
      entries.set(root, { files, expiresAt: now() + ttlMs })
      // 读取失败不缓存，下一次重新列出。
      files.catch(() => {
        if (entries.get(root)?.files === files) entries.delete(root)
      })
      return files
    },
    invalidate(root) {
      if (root === undefined) entries.clear()
      else entries.delete(root)
    },
  }
}
