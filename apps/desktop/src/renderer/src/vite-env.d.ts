/** Vite 注入的环境声明；与 ui-primitives 保持一致，供跨包 typecheck 使用。 */
interface ImportMetaEnv {
  readonly DEV: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
