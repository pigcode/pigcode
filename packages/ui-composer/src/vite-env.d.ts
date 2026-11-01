/** 与 ui-primitives 保持一致的 Vite 环境声明，供跨包 typecheck 使用。 */
interface ImportMetaEnv {
  readonly DEV: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "*?raw" {
  const content: string
  export default content
}
