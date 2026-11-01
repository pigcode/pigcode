/** Vite 的 `?raw` 导入：构建时把文件原文打包成字符串。 */
declare module "*?raw" {
  const content: string
  export default content
}
