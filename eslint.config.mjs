import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "**/target/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "max-lines": ["error", 500],
    },
  },
)
