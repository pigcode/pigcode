/** 声明 Vite 注入的环境变量；本包只用到开发标志。 */
interface ImportMetaEnv {
  readonly DEV: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
