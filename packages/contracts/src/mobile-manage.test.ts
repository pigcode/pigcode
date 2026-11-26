import { describe, expect, it } from "vitest"
import {
  mobileAgentCreateInstanceParams,
  mobileAgentModelsParams,
  mobileAgentStatusSchema,
  mobileAgentUpdateInstanceParams,
  mobileFeatures,
  mobileProjectAddParams,
  mobileProjectBrowseDirsParams,
  mobileProjectRenameParams,
} from "./index"

describe("mobile management 5A contracts", () => {
  it("declares projects.manage and agents.manage within the mobile hello feature budget", () => {
    expect(mobileFeatures).toContain("projects.manage")
    expect(mobileFeatures).toContain("agents.manage")
    expect(mobileFeatures.length).toBeLessThanOrEqual(32)
  })

  it("enforces relative non-hidden home directory paths for project browsing and adding", () => {
    expect(mobileProjectBrowseDirsParams.safeParse({}).success).toBe(true)
    expect(mobileProjectBrowseDirsParams.safeParse({ relPath: "" }).success).toBe(true)
    expect(mobileProjectBrowseDirsParams.safeParse({ relPath: "Documents/workspace" }).success).toBe(
      true,
    )

    for (const bad of [
      "/etc",
      "~/Documents",
      "../secret",
      "Documents/../secret",
      ".ssh",
      "Documents/.git",
      "C:/Users",
      "Documents\\repo",
      "Documents/\0bad",
    ]) {
      expect(mobileProjectBrowseDirsParams.safeParse({ relPath: bad }).success, bad).toBe(false)
      expect(mobileProjectAddParams.safeParse({ relPath: bad }).success, bad).toBe(false)
    }

    // Cannot add home directory itself as a project.
    expect(mobileProjectAddParams.safeParse({ relPath: "" }).success).toBe(false)
    expect(
      mobileProjectAddParams.safeParse({ relPath: "Documents/repo", name: "  My Repo  " }),
    ).toMatchObject({
      success: true,
      data: { relPath: "Documents/repo", name: "My Repo" },
    })
    expect(mobileProjectRenameParams.safeParse({ projectId: "pr_1", name: "   " }).success).toBe(
      false,
    )
  })

  it("validates agent management params and strips absolute command from status schema", () => {
    expect(mobileAgentModelsParams.safeParse({}).success).toBe(false)
    expect(mobileAgentModelsParams.safeParse({ instanceId: "claude" }).success).toBe(true)

    expect(
      mobileAgentCreateInstanceParams.safeParse({
        agentId: "claude",
        label: "Work",
        instanceId: "claude-work",
        accentColor: "#3366FF",
        values: { apiKey: { secret: "sk-test" } },
      }),
    ).toMatchObject({
      success: true,
      data: { accentColor: "#3366ff" },
    })

    expect(
      mobileAgentCreateInstanceParams.safeParse({
        agentId: "claude",
        label: "Bad",
        instanceId: "123-bad",
      }).success,
    ).toBe(false)

    expect(
      mobileAgentUpdateInstanceParams.safeParse({
        instanceId: "claude-work",
        patch: { enabled: false, values: { apiKey: { configured: true } } },
      }).success,
    ).toBe(true)

    // command path must not be accepted in strict mobile status payload
    expect(
      mobileAgentStatusSchema.safeParse({
        installed: true,
        version: "1.0.0",
        authenticated: true,
        command: "/usr/local/bin/claude",
      }).success,
    ).toBe(false)
  })
})
