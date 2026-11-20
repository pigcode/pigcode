import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { secretReferenceSchema, type AgentSettingsValues } from "@pigcode/contracts"
import { findExecutable, launchTarget } from "@pigcode/plugin-sdk/node"

const run = promisify(execFile)
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const slot = (value: unknown): string | undefined =>
  object(value) && typeof value.privateSlot === "string" && uuid.test(value.privateSlot)
    ? value.privateSlot
    : undefined

function slotsIn(value: unknown, result = new Set<string>()) {
  const id = slot(value)
  if (id) result.add(id)
  else if (Array.isArray(value) || object(value))
    for (const item of Object.values(value)) slotsIn(item, result)
  return result
}
function mask(value: unknown): unknown {
  if (slot(value)) return { configured: true }
  if (Array.isArray(value)) return value.map(mask)
  if (object(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item)]))
  return value
}
export function publicValues(values: AgentSettingsValues): AgentSettingsValues {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, mask(value)]))
}
export const hasOnePassword = () => Boolean(findExecutable("op"))

/** 配置只存不透明的引用；凭据按版本写入私有目录，复制实例时可复用同一版本。 */
export class AgentSecrets {
  private readonly lookups = new Map<string, Promise<string>>()
  private readonly memory = new Map<string, string>()
  private readonly directory: string | undefined
  constructor(
    dataDir: string | undefined,
    private readonly snapshot: () => unknown,
  ) {
    this.directory = dataDir ? join(dataDir, ".secrets") : undefined
  }
  private put(value: string, created: Set<string>) {
    const id = randomUUID()
    if (this.directory) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (!lstatSync(this.directory).isDirectory())
        throw new Error("Invalid Agent credential directory")
      if (process.platform !== "win32") chmodSync(this.directory, 0o700)
      const fd = openSync(join(this.directory, id), "wx", 0o600)
      created.add(id)
      try {
        writeFileSync(fd, value)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      this.memory.set(id, value)
      created.add(id)
    }
    return { privateSlot: id }
  }
  collect(candidates: Set<string>) {
    if (!candidates.size) return
    const live = slotsIn(this.snapshot())
    for (const id of candidates)
      if (!live.has(id)) {
        if (this.directory) {
          if (lstatSync(this.directory, { throwIfNoEntry: false })?.isDirectory())
            rmSync(join(this.directory, id), { force: true })
        } else this.memory.delete(id)
      }
  }
  remove(values: AgentSettingsValues) {
    this.collect(slotsIn(values))
  }

  write<T>(
    values: AgentSettingsValues,
    previous: AgentSettingsValues,
    commit: (sealed: AgentSettingsValues) => T,
  ): T {
    const candidates = slotsIn(previous)
    const seal = (value: unknown, prior: unknown, sensitive: boolean): unknown => {
      if (object(value) && "privateSlot" in value) throw new Error("Invalid credential input")
      if (object(value) && value.configured === true) {
        if (!slot(prior)) throw new Error("This credential is no longer configured")
        return prior
      }
      if (object(value) && "reference" in value) return secretReferenceSchema.parse(value)
      if (object(value) && typeof value.secret === "string")
        return value.secret ? this.put(value.secret, candidates) : ""
      if (sensitive && typeof value === "string" && value) return this.put(value, candidates)
      return value
    }
    try {
      const sealed = Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          const prior = previous[key]
          if (!Array.isArray(value))
            return [key, seal(value, prior, key === "apiKey" || key === "serverPassword")]
          const oldRows = new Map(
            (Array.isArray(prior) ? prior : []).flatMap((row) =>
              object(row) && typeof row.name === "string" ? [[row.name, row.value] as const] : [],
            ),
          )
          return [
            key,
            value.map((row) => {
              if (!object(row) || typeof row.name !== "string" || !("value" in row)) return row
              if (row.sensitive !== true && object(row.value))
                throw new Error("Protected environment values must be marked sensitive")
              return {
                ...row,
                value: seal(row.value, oldRows.get(row.name), row.sensitive === true),
              }
            }),
          ]
        }),
      )
      return commit(sealed)
    } finally {
      this.collect(candidates)
    }
  }

  async resolve(values: AgentSettingsValues): Promise<AgentSettingsValues> {
    const external = this.lookups
    const read = async (value: unknown): Promise<unknown> => {
      const id = slot(value)
      if (id) {
        if (this.directory) {
          let fd: number | undefined
          try {
            if (!lstatSync(this.directory).isDirectory()) throw new Error()
            fd = openSync(
              join(this.directory, id),
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            )
            if (!fstatSync(fd).isFile()) throw new Error()
            return readFileSync(fd, "utf8")
          } catch {
            throw new Error("The stored Agent credential is unavailable")
          } finally {
            if (fd !== undefined) closeSync(fd)
          }
        }
        const secret = this.memory.get(id)
        if (secret === undefined) throw new Error("The stored Agent credential is unavailable")
        return secret
      }
      if (object(value) && "reference" in value) {
        const { reference } = secretReferenceSchema.parse(value)
        let pending = external.get(reference)
        if (!pending) {
          const program = findExecutable("op")
          if (!program) throw new Error("Install the 1Password CLI to use this secret reference")
          const target = launchTarget(program, ["read", "--no-newline", reference])
          if (target.shell) throw new Error("An executable 1Password CLI is required")
          pending = run(target.command, target.args, {
            timeout: 15_000,
            maxBuffer: 256 * 1024,
            windowsHide: true,
          })
            .then(({ stdout }) => stdout)
            .catch(() => {
              throw new Error("Could not read the Agent credential from 1Password")
            })
            .finally(() => external.delete(reference))
          external.set(reference, pending)
        }
        return pending
      }
      return value
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(values).map(async ([key, value]) => {
          if (!Array.isArray(value)) return [key, await read(value)]
          const mapped = await Promise.all(
            value.map(async (row) =>
              object(row) && "value" in row ? { ...row, value: await read(row.value) } : row,
            ),
          )
          return [key, mapped]
        }),
      ),
    )
  }
}
