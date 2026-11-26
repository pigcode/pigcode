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
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
}

/** 少数 JSON Schema 无法直接表达的 Dart 兼容语义（默认空列表、兼容旧端默认值、refine 校验）。 */
interface FieldOverride {
  /** 字段改用非空 `List<T>` 且默认 `const []`，通过指定函数解析并在非空时写出。 */
  emptyListParser?: string
  /** 字段改用指定解析函数返回可空值（如 `parseMobileAttachmentIds`）。 */
  nullableParser?: string
  /** 构造参数默认值（如 `''`），替代 `required`。 */
  defaultValue?: string
  /** 字符串先 trim 再校验（对应 Zod 的 `z.string().trim()`）。 */
  trim?: boolean
  /** 私有可空布尔字段，对外暴露 `?? true` getter（兼容旧端未下发字段）。 */
  defaultTrueBool?: boolean
}

interface ModelOverride {
  fields?: Record<string, FieldOverride>
  /** Zod `.refine` 等跨字段校验（插入在 `return ...` 之前）。 */
  validate?: string[]
}

const root = new URL("../../../", import.meta.url)
const clientLib = new URL("apps/mobile/packages/pigcode_client/lib/", root)
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

function refType(ref: string, externalModels: Record<string, string>): string {
  return externalModels[ref] ?? ref
}

function dartType(schema: Schema, externalModels: Record<string, string>): string {
  if (schema.$ref) return refType(schema.$ref, externalModels)
  if (schema.type === "array" && schema.items)
    return "List<" + dartType(schema.items, externalModels) + ">"
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

function read(
  schema: Schema,
  value: string,
  models: Record<string, Schema>,
  externalModels: Record<string, string>,
  trimItem = false,
): string {
  if (schema.type === "array" && schema.items) {
    const item = schema.items
    const itemExpr = read(item, "item", models, externalModels)
    const itemChecks = validators("value", item)
    if (trimItem || itemChecks.length > 0) {
      const valueExpr = trimItem ? "(" + itemExpr + ").trim()" : itemExpr
      const checkLine =
        itemChecks.length > 0
          ? "if (" + itemChecks.join(" || ") + ") { throw const FormatException('Invalid item'); } "
          : ""
      return (
        dartType(schema, externalModels) +
        ".unmodifiable((" +
        value +
        " as List<dynamic>).map((item) { final value = " +
        valueExpr +
        "; " +
        checkLine +
        "return value; }))"
      )
    }
    return (
      dartType(schema, externalModels) +
      ".unmodifiable((" +
      value +
      " as List<dynamic>).map((item) => " +
      itemExpr +
      "))"
    )
  }
  if (!schema.$ref) return value + " as " + dartType(schema, externalModels)
  const target = refType(schema.$ref, externalModels)
  if (models[schema.$ref]?.enum) return target + ".fromWire(" + value + " as String)"
  return target + ".fromJson(" + value + " as Map<String, dynamic>)"
}

function encode(
  schema: Schema,
  value: string,
  models: Record<string, Schema>,
  optional = false,
): string {
  if (schema.type === "array" && schema.items) {
    if (!schema.items.$ref) return value + (optional ? "?" : "") + ".toList()"
    return (
      value +
      (optional ? "?" : "") +
      ".map((item) => " +
      encode(schema.items, "item", models) +
      ").toList()"
    )
  }
  if (!schema.$ref) return value
  return value + (optional ? "?" : "") + (models[schema.$ref]?.enum ? ".wire" : ".toJson()")
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
  if (schema.minItems === 1) tests.push(field + ".isEmpty")
  else if (schema.minItems !== undefined) tests.push(field + ".length < " + schema.minItems)
  if (schema.maxItems !== undefined) tests.push(field + ".length > " + schema.maxItems)
  return tests
}

function objectModel(
  name: string,
  schema: Schema,
  models: Record<string, Schema>,
  externalModels: Record<string, string>,
  override?: ModelOverride,
): string[] {
  const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => ({
    key,
    value,
    required: schema.required?.includes(key) ?? false,
    spec: override?.fields?.[key],
  }))
  const lines = ["final class " + name + " {"]
  lines.push(
    fields.length
      ? "  const " +
          name +
          "({" +
          fields
            .map(({ key, required, spec }) => {
              if (spec?.emptyListParser) return "this." + key + " = const []"
              if (spec?.defaultTrueBool) return "this._" + key
              if (spec?.defaultValue !== undefined) return "this." + key + " = " + spec.defaultValue
              return (required ? "required " : "") + "this." + key
            })
            .join(", ") +
          "});"
      : "  const " + name + "();",
  )
  for (const { key, value, required, spec } of fields) {
    if (spec?.defaultTrueBool) {
      lines.push("  final bool? _" + key + ";")
      lines.push("  bool get " + key + " => _" + key + " ?? true;")
      continue
    }
    const nullable = !required && !spec?.emptyListParser
    lines.push(
      "  final " + dartType(value, externalModels) + (nullable ? "?" : "") + " " + key + ";",
    )
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
  for (const { key, value, required, spec } of fields) {
    const raw = "json[" + quote(key) + "]"
    if (spec?.emptyListParser) {
      lines.push("    final " + key + " = " + spec.emptyListParser + "(" + raw + ");")
      continue
    }
    if (spec?.nullableParser) {
      lines.push("    final " + key + " = " + spec.nullableParser + "(" + raw + ");")
      continue
    }
    const expression = read(value, raw, models, externalModels, Boolean(spec?.trim))
    const trimSuffix = spec?.trim && value.type === "string" ? ".trim()" : ""
    const presence = raw + " != null"
    if (required) {
      lines.push("    final " + key + " = (" + expression + ")" + trimSuffix + ";")
    } else if (trimSuffix) {
      lines.push("    final " + key + " = " + presence + " ? (" + expression + ").trim() : null;")
    } else {
      lines.push("    final " + key + " = " + presence + " ? " + expression + " : null;")
    }
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
  if (override?.validate) lines.push(...override.validate.map((line) => "    " + line))
  lines.push(
    "    return " + name + "(" + fields.map(({ key }) => key + ": " + key).join(", ") + ");",
    "  }",
    "",
  )
  lines.push("  Map<String, Object?> toJson() => {")
  for (const { key, value, required, spec } of fields) {
    if (spec?.emptyListParser) {
      lines.push(
        "    if (" + key + ".isNotEmpty) " + quote(key) + ": " + encode(value, key, models) + ",",
      )
      continue
    }
    if (spec?.defaultTrueBool) {
      lines.push("    " + quote(key) + ": ?_" + key + ",")
      continue
    }
    lines.push(
      "    " +
        quote(key) +
        ": " +
        (required ? "" : "?") +
        encode(value, key, models, !required) +
        ",",
    )
  }
  return [...lines, "  };", "}", ""]
}

function model(
  name: string,
  schema: Schema,
  models: Record<string, Schema>,
  externalModels: Record<string, string>,
  override?: ModelOverride,
): string[] {
  if (schema.enum) {
    return [
      "enum " + name + " {",
      ...schema.enum.map((value, index, entries) => {
        const item = value.replace(/[.-]([a-z])/g, (_, character: string) =>
          character.toUpperCase(),
        )
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
      "typedef " + name + " = List<" + dartType(item, externalModels) + ">;",
      name + " decode" + name + "(Object? json) => List.unmodifiable(",
      "  (json as List<dynamic>).map((entry) => " +
        read(item, "entry", models, externalModels) +
        "),",
      ");",
      "",
    ]
  }
  if (schema.type === "object") return objectModel(name, schema, models, externalModels, override)
  throw new Error("不支持的手机模型 " + name)
}

interface ContractFamily {
  methods: Record<string, string>
  schemas: Record<string, Schema>
  fileName: string
  methodsName: string
  imports?: string[]
  preamble?: string[]
  constants?: string[]
  externalModels?: Record<string, string>
  overrides?: Record<string, ModelOverride>
}

async function generate(family: ContractFamily): Promise<void> {
  const {
    methods,
    schemas,
    fileName,
    methodsName,
    imports = [],
    preamble = [],
    constants = [],
    externalModels = {},
    overrides = {},
  } = family
  const lines = [
    "// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。",
    ...imports,
    "",
    ...preamble,
    ...(preamble.length ? [""] : []),
    "abstract final class " + methodsName + " {",
    ...Object.entries(methods).map(
      ([name, method]) => "  static const " + name + " = " + quote(method) + ";",
    ),
    "}",
    "",
    ...constants,
    "",
  ]
  for (const [name, schema] of Object.entries(schemas)) {
    if (name in externalModels) continue
    lines.push(...model(name, schema, schemas, externalModels, overrides[name]))
  }
  const draft = join(scratch, fileName)
  const file = new URL(fileName, clientLib)
  await writeFile(draft, lines.join("\n"))
  execFileSync("dart", ["format", draft], { stdio: "pipe" })
  const generated = await readFile(draft, "utf8")
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== generated)
      throw new Error(fileName + " 与 contracts 不一致")
  } else {
    await writeFile(file, generated)
  }
}

const textOrAttachmentsOverride: ModelOverride = {
  fields: {
    text: { defaultValue: "''" },
    effort: { trim: true },
    attachmentIds: { nullableParser: "parseMobileAttachmentIds" },
  },
  validate: [
    "final hasText = RegExp('\\\\S').hasMatch(text);",
    "final hasAttachments = attachmentIds != null && attachmentIds.isNotEmpty;",
    "if (!hasText && !hasAttachments) {",
    "  throw const FormatException('Invalid text');",
    "}",
  ],
}

try {
  const sidebar = await vite.ssrLoadModule("/packages/contracts/src/mobile-sidebar.ts")
  const reminders = await vite.ssrLoadModule("/packages/contracts/src/mobile-reminders.ts")
  const timeline = await vite.ssrLoadModule("/packages/contracts/src/mobile-timeline.ts")
  const changes = await vite.ssrLoadModule("/packages/contracts/src/mobile-run-changes.ts")
  const commands = await vite.ssrLoadModule("/packages/contracts/src/mobile-commands.ts")
  const requests = await vite.ssrLoadModule("/packages/contracts/src/mobile-requests.ts")
  const drafts = await vite.ssrLoadModule("/packages/contracts/src/mobile-drafts.ts")
  const queue = await vite.ssrLoadModule("/packages/contracts/src/queued-messages.ts")
  await generate({
    methods: sidebar.mobileSidebarMethods,
    schemas: sidebar.mobileSidebarJsonSchemas(),
    fileName: "sidebar_models.dart",
    methodsName: "MobileSidebarMethods",
    constants: ["const mobileSidebarPageSize = " + sidebar.mobileSidebarPageSize + ";"],
  })
  await generate({
    methods: reminders.mobileReminderMethods,
    schemas: reminders.mobileReminderJsonSchemas(),
    fileName: "reminder_models.dart",
    methodsName: "MobileReminderMethods",
  })
  await generate({
    methods: timeline.mobileTimelineMethods,
    schemas: timeline.mobileTimelineJsonSchemas(),
    fileName: "timeline_models.dart",
    methodsName: "MobileTimelineMethods",
    imports: ["import 'composer_models.dart';", "import 'src/attachments.dart';"],
    constants: [
      "const timelineTextPreviewLength = " + timeline.timelineTextPreviewLength + ";",
      "const timelineToolPreviewLength = " + timeline.timelineToolPreviewLength + ";",
    ],
    externalModels: {
      ImageAttachment: "MobileAttachmentRef",
      MobileThreadComposerState: "MobileThreadComposerState",
    },
    overrides: {
      MobileTimelineEvent: {
        fields: { attachments: { emptyListParser: "parseMobileAttachmentRefs" } },
      },
    },
  })
  await generate({
    methods: commands.mobileCommandMethods,
    schemas: commands.mobileCommandJsonSchemas(),
    fileName: "command_models.dart",
    methodsName: "MobileCommandMethods",
    imports: ["import 'composer_models.dart';", "import 'src/attachments.dart';"],
    constants: ["const mobileCommandTextLimit = " + commands.mobileCommandTextLimit + ";"],
    externalModels: { MobileThreadReference: "MobileThreadReference" },
    overrides: { MobileStartRunParams: textOrAttachmentsOverride },
  })
  await generate({
    methods: changes.mobileRunChangesMethods,
    schemas: changes.mobileRunChangesJsonSchemas(),
    fileName: "run_change_models.dart",
    methodsName: "MobileRunChangesMethods",
  })
  await generate({
    methods: requests.mobileRequestMethods,
    schemas: requests.mobileRequestJsonSchemas(),
    fileName: "request_models.dart",
    methodsName: "MobileRequestMethods",
    constants: ["const mobileRequestAnswerBytes = " + requests.mobileRequestAnswerBytes + ";"],
  })
  await generate({
    methods: drafts.mobileDraftMethods,
    schemas: drafts.mobileDraftJsonSchemas(),
    fileName: "draft_models.dart",
    methodsName: "MobileDraftMethods",
    imports: ["import 'composer_models.dart';", "import 'src/attachments.dart';"],
    externalModels: { MobileThreadReference: "MobileThreadReference" },
    overrides: {
      MobileDraftCreateParams: textOrAttachmentsOverride,
      MobileDraftInstance: { fields: { supportsImages: { defaultTrueBool: true } } },
      MobileDraftModel: { fields: { efforts: { trim: true } } },
    },
  })
  await generate({
    methods: queue.queueMethods,
    schemas: queue.mobileQueueJsonSchemas(),
    fileName: "queue_models.dart",
    methodsName: "QueueMethods",
    imports: ["import 'src/attachments.dart';"],
    preamble: ["typedef MobileQueuedMessage = QueuedMessage;"],
    externalModels: { ImageAttachment: "MobileAttachmentRef" },
    overrides: {
      QueuedMessage: {
        fields: { attachments: { emptyListParser: "parseMobileAttachmentRefs" } },
      },
      QueueReceipt: {
        fields: { attachments: { emptyListParser: "parseMobileAttachmentRefs" } },
      },
    },
  })
} finally {
  await vite.close()
  await rm(scratch, { recursive: true, force: true })
}
