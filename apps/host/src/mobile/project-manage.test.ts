import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileFeatures,
  mobileProjectMethods,
  type MobileProjectAddResult,
  type MobileProjectBrowseDirsResult,
  type MobileProjectCreateDirResult,
  type MobileProjectManageListResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PairedDevices } from "./paired-devices"
import { MobileProjectManage } from "./project-manage"
import { MobileRequestError } from "./request-error"
import { MobileSidebarRpc } from "./sidebar-rpc"

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function createHostFixture() {
  const dataDir = makeTempDir("pigcode-pm-data-")
  const homeDir = makeTempDir("pigcode-pm-home-")
  const outsideDir = makeTempDir("pigcode-pm-outside-")

  // Populate fake home directory with normal repos, hidden dirs, sensitive dirs, and an escape symlink.
  mkdirSync(join(homeDir, "Documents", "workspace", "alpha", ".git"), { recursive: true })
  mkdirSync(join(homeDir, "Documents", "workspace", "beta"), { recursive: true })
  mkdirSync(join(homeDir, ".ssh"), { recursive: true })
  mkdirSync(join(homeDir, ".aws"), { recursive: true })
  mkdirSync(join(homeDir, "Library", "Keychains"), { recursive: true })
  mkdirSync(join(homeDir, "Library", "Application Support", "Pigcode"), { recursive: true })
  writeFileSync(join(homeDir, "Documents", "plain.txt"), "hello\n")
  symlinkSync(outsideDir, join(homeDir, "Documents", "escape-link"))

  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, { path: join(dataDir, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)

  const manager = new MobileProjectManage(ctx, () => {}, homeDir)
  return { ctx, homeDir, outsideDir, manager }
}

function callManager<T>(manager: MobileProjectManage, method: string, params: unknown = {}): T {
  return manager.dispatch({ jsonrpc: "2.0", id: randomUUID(), method, params }) as T
}

describe("MobileProjectManage", () => {
  it("browses home directory safely, hides dotfiles and sensitive dirs, and marks Git repos", async () => {
    const { ctx, manager } = await createHostFixture()
    try {
      const root = callManager<MobileProjectBrowseDirsResult>(
        manager,
        mobileProjectMethods.browseDirs,
        {},
      )
      expect(root.currentRelPath).toBe("")
      expect(root.displayPath).toBe("~")
      expect(root.parentRelPath).toBeNull()
      expect(root.entries.map((e) => e.name)).toEqual(["Documents", "Library"])
      expect(root.entries.some((e) => e.name.startsWith("."))).toBe(false)

      // Sensitive subdirectories under Library are filtered out.
      const lib = callManager<MobileProjectBrowseDirsResult>(
        manager,
        mobileProjectMethods.browseDirs,
        { relPath: "Library" },
      )
      expect(lib.entries.some((e) => e.name === "Keychains")).toBe(false)

      // Symlink escaping homeDir and regular files are excluded from Documents.
      const docs = callManager<MobileProjectBrowseDirsResult>(
        manager,
        mobileProjectMethods.browseDirs,
        { relPath: "Documents" },
      )
      expect(docs.entries.map((e) => e.name)).toEqual(["workspace"])
      expect(docs.entries[0]?.hasChildren).toBe(true)

      const ws = callManager<MobileProjectBrowseDirsResult>(
        manager,
        mobileProjectMethods.browseDirs,
        { relPath: "Documents/workspace" },
      )
      expect(ws.parentRelPath).toBe("Documents")
      expect(ws.entries).toEqual([
        {
          name: "alpha",
          relPath: "Documents/workspace/alpha",
          isGitRepo: true,
          alreadyAddedProjectId: null,
          hasChildren: false,
        },
        {
          name: "beta",
          relPath: "Documents/workspace/beta",
          isGitRepo: false,
          alreadyAddedProjectId: null,
          hasChildren: false,
        },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("rejects traversal, dotfiles, sensitive paths, home root add, and symlink escapes", async () => {
    const { ctx, manager } = await createHostFixture()
    try {
      for (const bad of [
        "../etc",
        "/etc",
        ".ssh",
        ".aws",
        "Documents/escape-link",
        "Library/Keychains",
        "Library/Application Support/Pigcode",
      ]) {
        expect(() =>
          callManager(manager, mobileProjectMethods.browseDirs, { relPath: bad }),
        ).toThrow(MobileRequestError)
      }

      // Escaped symlink specifically throws PROJECT_PATH_FORBIDDEN
      try {
        callManager(manager, mobileProjectMethods.add, { relPath: "Documents/escape-link" })
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(MobileRequestError)
        expect((error as MobileRequestError).code).toBe("PROJECT_PATH_FORBIDDEN")
      }

      // Plain file throws PROJECT_NOT_DIRECTORY
      try {
        callManager(manager, mobileProjectMethods.add, { relPath: "Documents/plain.txt" })
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(MobileRequestError)
        expect((error as MobileRequestError).code).toBe("PROJECT_NOT_DIRECTORY")
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("supports add, list with shortcuts, rename, and soft remove", async () => {
    const { ctx, manager } = await createHostFixture()
    try {
      const added = callManager<MobileProjectAddResult>(manager, mobileProjectMethods.add, {
        relPath: "Documents/workspace/alpha",
        name: "Alpha Repo",
      })
      expect(added.project.name).toBe("Alpha Repo")
      expect(added.project.displayPath).toBe("~/Documents/workspace/alpha")
      expect(added.project.threadCount).toBe(0)

      // Existing project parent appears in browseDirs shortcuts and alreadyAddedProjectId is set.
      const ws = callManager<MobileProjectBrowseDirsResult>(
        manager,
        mobileProjectMethods.browseDirs,
        { relPath: "Documents/workspace" },
      )
      expect(ws.shortcuts.some((s) => s.relPath === "Documents/workspace")).toBe(true)
      expect(ws.entries.find((e) => e.name === "alpha")?.alreadyAddedProjectId).toBe(
        added.project.id,
      )

      // List returns managed project without exposing system absolute path.
      const listed = callManager<MobileProjectManageListResult>(
        manager,
        mobileProjectMethods.list,
        {},
      )
      expect(listed.projects).toHaveLength(1)
      expect(listed.projects[0]?.displayPath).toBe("~/Documents/workspace/alpha")

      // Rename updates display name.
      const renamed = callManager<MobileProjectAddResult>(manager, mobileProjectMethods.rename, {
        projectId: added.project.id,
        name: "Alpha Renamed",
      })
      expect(renamed.project.name).toBe("Alpha Renamed")

      // Remove soft-removes project from active list.
      const removed = callManager<{ removed: true; projectId: string }>(
        manager,
        mobileProjectMethods.remove,
        { projectId: added.project.id },
      )
      expect(removed).toEqual({ removed: true, projectId: added.project.id })
      expect(
        callManager<MobileProjectManageListResult>(manager, mobileProjectMethods.list, {}).projects,
      ).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("supports createDir safely and rejects duplicates, traversal, and sensitive parents", async () => {
    const { ctx, manager } = await createHostFixture()
    try {
      const created = callManager<MobileProjectCreateDirResult>(
        manager,
        mobileProjectMethods.createDir,
        { parentRelPath: "Documents/workspace", name: "  gamma-app  " },
      )
      expect(created.entry).toEqual({
        name: "gamma-app",
        relPath: "Documents/workspace/gamma-app",
        isGitRepo: false,
        alreadyAddedProjectId: null,
        hasChildren: false,
      })

      // Newly created folder can immediately be added as a project.
      const added = callManager<MobileProjectAddResult>(manager, mobileProjectMethods.add, {
        relPath: created.entry.relPath,
      })
      expect(added.project.name).toBe("gamma-app")
      expect(added.project.displayPath).toBe("~/Documents/workspace/gamma-app")

      // Duplicate folder throws PROJECT_DIR_EXISTS.
      try {
        callManager(manager, mobileProjectMethods.createDir, {
          parentRelPath: "Documents/workspace",
          name: "gamma-app",
        })
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(MobileRequestError)
        expect((error as MobileRequestError).code).toBe("PROJECT_DIR_EXISTS")
      }

      // Invalid names & sensitive folders (e.g. Library/Keychains) are rejected.
      expect(() =>
        callManager(manager, mobileProjectMethods.createDir, {
          parentRelPath: "Library",
          name: "Keychains",
        }),
      ).toThrow(MobileRequestError)
      expect(() =>
        callManager(manager, mobileProjectMethods.createDir, {
          parentRelPath: "Documents",
          name: ".hidden",
        }),
      ).toThrow(MobileRequestError)
      expect(() =>
        callManager(manager, mobileProjectMethods.createDir, {
          parentRelPath: "Documents",
          name: "a/b",
        }),
      ).toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("gates mobile.project.* behind projects.manage feature in MobileSidebarRpc", async () => {
    const { ctx } = await createHostFixture()
    try {
      const devices = new PairedDevices(ctx.settings)
      const deviceKey = Buffer.alloc(32, 7).toString("base64url")
      devices.save({
        publicKey: deviceKey,
        name: "iPhone",
        platform: "ios",
        lastConnectedAt: Date.now(),
      })
      const wire = new MemoryTransport()
      const feed = new ThreadFeed(ctx)
      const rpc = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
        computerKey: Buffer.alloc(32, 1),
        computerName: "TestMac",
        deviceKey,
        features: mobileFeatures.filter((f) => f !== "projects.manage"),
        relayRevision: () => undefined,
      })
      rpc.start()

      wire.client.send({
        jsonrpc: "2.0",
        id: "r1",
        method: mobileProjectMethods.list,
        params: {},
      })
      const reply = await wire.client.next()
      expect(reply).toEqual(
        expect.objectContaining({
          id: "r1",
          error: expect.objectContaining({ code: "METHOD_NOT_AVAILABLE" }),
        }),
      )
      rpc.stop()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
