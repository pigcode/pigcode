import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
      "**/target/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "max-lines": ["error", 500],
      // M0 验收：基础组件只用 Base UI。这条规则防止 Radix 被重新引进来。
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@radix-ui/*"], message: "基础组件只用 Base UI，Radix 在 M0 已移除。" },
          ],
        },
      ],
    },
  },
)
