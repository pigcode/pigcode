import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"

interface Schema {
  type?: string
  $ref?: string
  enum?: string[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
}

const root = new URL("../../../", import.meta.url)
const file = new URL("apps/mobile/packages/pigcode_client/lib/sidebar_models.dart", root)
const vite = await createServer({
  root: fileURLToPath(root),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: null },
})
const scratch = await mkdtemp(join(tmpdir(), "pigcode-dart-models-"))

function quote(value: string): string {
  return "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("$", "\\$") + "'"
}

function dartType(schema: Schema): string {
  if (schema.$ref) return schema.$ref
  switch (schema.type) {
    case "string":
      return "String"
    case "integer":
      return "int"
    case "boolean":
      return "bool"
    default:
      throw new Error("不支持的手机协议类型 " + schema.type)
  }
}

function read(schema: Schema, value: string, models: Record<string, Schema>): string {
  if (!schema.$ref) return value + " as " + dartType(schema)
  if (models[schema.$ref]?.enum) return schema.$ref + ".fromWire(" + value + " as String)"
  return schema.$ref + ".fromJson(" + value + " as Map<String, dynamic>)"
}

function encode(schema: Schema, value: string, models: Record<string, Schema>): string {
  if (!schema.$ref) return value
  return value + (models[schema.$ref]?.enum ? ".wire" : ".toJson()")
}

function validators(field: string, schema: Schema): string[] {
  const tests: string[] = []
  if (schema.minimum !== undefined) tests.push(field + " < " + schema.minimum)
  if (schema.maximum !== undefined) tests.push(field + " > " + schema.maximum)
  if (schema.minLength === 1) tests.push(field + ".isEmpty")
  else if (schema.minLength !== undefined) tests.push(field + ".length < " + schema.minLength)
  if (schema.maxLength !== undefined) tests.push(field + ".length > " + schema.maxLength)
  if (schema.pattern !== undefined)
    tests.push("!RegExp(" + quote(schema.pattern) + ").hasMatch(" + field + ")")
  return tests
}

function objectModel(name: string, schema: Schema, models: Record<string, Schema>): string[] {
  const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => ({
    key,
    value,
    required: schema.required?.includes(key) ?? false,
  }))
  const lines = ["final class " + name + " {"]
  lines.push(
    fields.length
      ? "  const " +
          name +
          "({" +
          fields
            .map(({ key, required }) => (required ? "required " : "") + "this." + key)
            .join(", ") +
          "});"
      : "  const " + name + "();",
  )
  for (const { key, value, required } of fields) {
    lines.push("  final " + dartType(value) + (required ? "" : "?") + " " + key + ";")
  }
  lines.push("", "  factory " + name + ".fromJson(Map<String, dynamic> json) {")
  if (schema.additionalProperties === false) {
    const check = fields.length
      ? "json.keys.any((key) => !const {" +
        fields.map(({ key }) => quote(key)).join(", ") +
        "}.contains(key))"
      : "json.isNotEmpty"
    lines.push(
      "    if (" + check + ") {",
      "      throw const FormatException(" + quote(name + " contains an unknown field") + ");",
      "    }",
    )
  }
  for (const { key, value, required } of fields) {
    const expression = read(value, "json[" + quote(key) + "]", models)
    const presence = "json.containsKey(" + quote(key) + ")"
    lines.push(
      "    final " +
        key +
        " = " +
        (required ? expression : presence + " ? " + expression + " : null") +
        ";",
    )
    const conditions = validators(key, value)
    if (conditions.length > 0) {
      const invalid = conditions.join(" || ")
      const guard = required ? invalid : key + " != null && (" + invalid + ")"
      lines.push(
        "    if (" + guard + ") {",
        "      throw const FormatException(" + quote("Invalid " + key) + ");",
        "    }",
      )
    }
  }
  lines.push(
    "    return " + name + "(" + fields.map(({ key }) => key + ": " + key).join(", ") + ");",
    "  }",
    "",
  )
  lines.push("  Map<String, Object?> toJson() => {")
  for (const { key, value, required } of fields) {
    if (!required && value.$ref) {
      throw new Error("未实现可选引用字段 " + key)
    }
    lines.push(
      "    " + quote(key) + ": " + (required ? "" : "?") + encode(value, key, models) + ",",
    )
  }
  return [...lines, "  };", "}", ""]
}

function model(name: string, schema: Schema, models: Record<string, Schema>): string[] {
  if (schema.enum) {
    return [
      "enum " + name + " {",
      ...schema.enum.map((value, index, entries) => {
        const item = value.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())
        return "  " + item + "(" + quote(value) + ")" + (index === entries.length - 1 ? ";" : ",")
      }),
      "",
      "  const " + name + "(this.wire);",
      "  final String wire;",
      "",
      "  factory " + name + ".fromWire(String wire) {",
      "    for (final value in values) { if (value.wire == wire) return value; }",
      "    throw const FormatException(" + quote("Invalid " + name) + ");",
      "  }",
      "}",
      "",
    ]
  }
  if (schema.type === "array" && schema.items) {
    const item = schema.items
    return [
      "typedef " + name + " = List<" + dartType(item) + ">;",
      name + " decode" + name + "(Object? json) => List.unmodifiable(",
      "  (json as List<dynamic>).map((entry) => " + read(item, "entry", models) + "),",
      ");",
      "",
    ]
  }
  if (schema.type === "object") return objectModel(name, schema, models)
  throw new Error("不支持的手机模型 " + name)
}

try {
  const contract = await vite.ssrLoadModule("/packages/contracts/src/mobile-sidebar.ts")
  const models = contract.mobileSidebarJsonSchemas() as Record<string, Schema>
  const methods = contract.mobileSidebarMethods as Record<string, string>
  const lines = [
    "// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。",
    "",
    "abstract final class MobileSidebarMethods {",
    ...Object.entries(methods).map(
      ([name, method]) => "  static const " + name + " = " + quote(method) + ";",
    ),
    "}",
    "",
    "const mobileSidebarPageSize = " + contract.mobileSidebarPageSize + ";",
    "",
  ]
  for (const [name, schema] of Object.entries(models)) lines.push(...model(name, schema, models))
  const draft = join(scratch, "sidebar_models.dart")
  await writeFile(draft, lines.join("\n"))
  execFileSync("dart", ["format", draft], { stdio: "pipe" })
  const generated = await readFile(draft, "utf8")
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== generated)
      throw new Error("Dart 契约与 contracts 不一致")
  } else {
    await writeFile(file, generated)
  }
} finally {
  await vite.close()
  await rm(scratch, { recursive: true, force: true })
}
