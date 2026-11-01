/** 声明 Vite 注入的环境变量；本包只用到开发标志。 */
interface ImportMetaEnv {
  readonly DEV: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Vite 的 `?raw` 导入：构建时把文件原文打包成字符串（外观推导读 tokens.css 原文）。 */
declare module "*?raw" {
  const content: string
  export default content
}
