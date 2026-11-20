import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it, expect } from "vitest"
import { AntigravityDriver } from "./driver"
import { writeAgyFixture } from "../../../apps/host/src/agents/fixtures/executable"
import { acpLaunch, instanceProfile } from "./launch"

it("configures API credentials without claiming verification until a model responds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-agy-credentials-"))
  const scope = {
    instanceId: "work",
    dataDir: join(root, "instance"),
    sharedDir: join(root, "shared"),
    invalidate() {},
  }
  const driver = new AntigravityDriver()
  try {
    const binaryPath = writeAgyFixture(root)
    const key = { binaryPath, authMethod: "gemini-api-key", apiKey: "fixture-key" }
    const launch = await acpLaunch(binaryPath, key, await instanceProfile(scope, key), root)
    expect(launch.env.GEMINI_API_KEY).toBe("fixture-key")
    expect(launch.env.GOOGLE_API_KEY).toBeUndefined()
    await expect(driver.listModels(key, scope)).resolves.toMatchObject([
      { id: "gemini-api-key-model" },
    ])
    await expect(driver.detect(key, scope)).resolves.toMatchObject({
      authenticated: null,
      credentialsConfigured: true,
      account: "Gemini API key",
    })
    await expect(driver.detect({ ...key, apiKey: "" }, scope)).resolves.toMatchObject({
      authenticated: false,
      error: expect.stringMatching(/key/i),
    })
    const enterprise = {
      binaryPath,
      authMethod: "oauth-business",
      gcpProject: "example",
      gcpLocation: "us-central1",
    }
    const managed = await acpLaunch(
      binaryPath,
      enterprise,
      await instanceProfile(scope, enterprise),
      root,
    )
    expect(
      JSON.parse(
        await readFile(join(managed.env.GEMINI_HOME!, "antigravity-acp", "settings.json"), "utf8"),
      ),
    ).toEqual({
      auth: { type: "oauth-business" },
      gcp: { project: "example", location: "us-central1" },
    })
    await expect(driver.detect({ ...enterprise, gcpLocation: "" }, scope)).resolves.toMatchObject({
      authenticated: false,
      error: expect.stringMatching(/location/i),
    })
    await expect(
      acpLaunch(
        binaryPath,
        { ...key, authMethod: "agent-platform" },
        await instanceProfile(scope),
        root,
      ),
    ).rejects.toThrow(/Application Default Credentials/)
    const vertex = {
      binaryPath,
      authMethod: "agent-platform",
      gcpProject: "example",
      gcpLocation: "us-central1",
      environment: [{ name: "GOOGLE_APPLICATION_CREDENTIALS", value: "fixture-adc.json" }],
    }
    const vertexLaunch = await acpLaunch(
      binaryPath,
      vertex,
      await instanceProfile(scope, vertex),
      root,
    )
    expect(vertexLaunch.env).toMatchObject({
      AGY_ADC_AUTH: "true",
      GOOGLE_APPLICATION_CREDENTIALS: "fixture-adc.json",
      GOOGLE_CLOUD_PROJECT: "example",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    })
    expect(vertexLaunch.authenticateMethod).toBe("agent-platform")
    expect(vertexLaunch.env.GOOGLE_API_KEY).toBeUndefined()
    expect(vertexLaunch.env.GEMINI_API_KEY).toBeUndefined()
    await expect(driver.listModels(vertex, scope)).resolves.toMatchObject([
      { id: "agent-platform-model" },
    ])
    const restart = new AntigravityDriver()
    try {
      await expect(restart.detect(key, scope)).resolves.toMatchObject({
        authenticated: null,
        credentialsConfigured: true,
      })
    } finally {
      await restart.close()
    }
    const use = async (settings: typeof key) => {
      const session = await driver.createSession({
        threadId: "credential-review",
        cwd: root,
        settings,
        instance: scope,
      })
      await driver.send(
        session,
        { text: "hello" },
        {
          signal: new AbortController().signal,
          emit() {},
          async requestApproval() {
            return "deny"
          },
        },
      )
    }
    const wrong = { ...key, apiKey: "invalid-fixture-key" }
    await expect(driver.listModels(wrong, scope)).resolves.toHaveLength(1)
    await expect(driver.detect(wrong, scope)).resolves.toMatchObject({ authenticated: null })
    await expect(use(wrong)).rejects.toThrow(/Google rejected/)
    await expect(driver.detect(wrong, scope)).resolves.toMatchObject({ authenticated: false })
    await use(key)
    await expect(driver.detect(key, scope)).resolves.toMatchObject({ authenticated: true })
  } finally {
    await driver.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === "win32")(
  "uses native Enterprise OAuth in an isolated standalone ACP profile",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-agy-enterprise-"))
    const scope = {
      instanceId: "enterprise",
      dataDir: join(root, "instance"),
      sharedDir: root,
      invalidate() {},
    }
    const driver = new AntigravityDriver()
    const native = writeAgyFixture(root)
    const binaryPath = join(root, "agy_acp_server.par")
    await writeFile(binaryPath, `#!/bin/sh\nexec "${native}" "$@"\n`)
    await chmod(binaryPath, 0o700)
    await writeFile(join(root, "localharness_external"), "fixture")
    const settings = {
      binaryPath,
      authMethod: "oauth-business",
      gcpProject: "example",
      gcpLocation: "us-central1",
    }
    const auth = (request: Parameters<typeof driver.accountSetup.auth>[0]) =>
      driver.accountSetup.auth(request, settings, scope)
    try {
      await expect(
        driver.detect({ ...settings, binaryPath: native }, scope),
      ).resolves.toMatchObject({
        authenticated: false,
        error: expect.stringContaining("standalone"),
      })
      const first = await auth({ action: "start" })
      await expect.poll(() => auth({ action: "status" })).toMatchObject({ phase: "waiting" })
      await auth({ action: "cancel", flowId: first.flowId! })
      await expect(driver.detect(settings, scope)).resolves.toMatchObject({ authenticated: false })

      const second = await auth({ action: "start" })
      await expect.poll(() => auth({ action: "status" })).toMatchObject({ phase: "waiting" })
      const { authorizationUrl } = await auth({ action: "status" })
      const redirect = new URL(new URL(authorizationUrl!).searchParams.get("redirect_uri")!)
      redirect.searchParams.set("state", "wrong-state")
      redirect.searchParams.set("code", "confirmed")
      await expect(
        auth({ action: "submit", flowId: second.flowId!, response: redirect.href }),
      ).rejects.toThrow()
      redirect.searchParams.set("state", "fixture-enterprise")
      await auth({ action: "submit", flowId: second.flowId!, response: redirect.href })
      await expect.poll(() => auth({ action: "status" })).toMatchObject({ phase: "connected" })
      await expect(driver.listModels(settings, scope)).resolves.toMatchObject([
        { id: "oauth-business-model" },
      ])
    } finally {
      await driver.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
