## Pigcode plugin guide

Write a Pigcode plugin in this project following the rules below, then tell me how to add and install it in Pigcode.

### 1. Pin down what to build

If the request isn't specific enough, ask me first: what the plugin does, and where it shows up (a panel in the left sidebar, a tab in the right panel, a settings page, a command in the command palette and the input's `/`, an MCP tool for the agent, or how a tool call looks in the timeline).

### 2. Layout

- Put the plugin in `plugins/<slug>/`, where slug uses lowercase letters, digits and hyphens. The marketplace catalog goes in `plugins/.pigcode-plugin/marketplace.json`.
- Write plain JavaScript (ES modules, `.js`): no TypeScript, no JSX, no build step and no third-party dependencies. Pigcode loads these files as they are.

```text
plugins/
├── .pigcode-plugin/marketplace.json
└── <slug>/
    ├── package.json
    ├── host.js      # Host entry: MCP tools, services (optional)
    └── client.js    # UI entry: panels, tabs, settings pages, commands (optional)
```

### 3. package.json

```json
{
  "name": "pigcode-<slug>",
  "version": "0.1.0",
  "description": "One-line summary",
  "type": "module",
  "license": "MIT",
  "pigcode": {
    "apiVersion": 1,
    "kind": "capability",
    "displayName": "Display name",
    "host": "./host.js",
    "client": "./client.js",
    "inject": ["mcp"],
    "permissions": []
  }
}
```

- `kind`: use `ui` for UI only (only `client`), and `capability` when there's a Host entry. Connecting a new agent CLI (`agent`) is more involved and out of scope here.
- At least one of `host` and `client` is required, and the files they point to must exist. `name` is lowercase; it's the plugin's package name.
- `inject` lists the services the Host entry uses: `mcp` for MCP tools, `sessions` to read thread events.

### 4. Host entry (host.js)

Runs in Pigcode's Host process and can use Node built-ins (`node:fs` and so on). To give the agent an MCP tool:

```js
export const name = "pigcode-<slug>"
export const inject = ["mcp"]

export function apply(ctx) {
  ctx.effect(() =>
    ctx.mcp.registerTool(
      "pigcode-<slug>",
      {
        name: "<slug>_count_words",
        description: "What the tool does and when the model should use it",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      async (input, { threadId }) => ({
        words: String(input.text).split(/\s+/).filter(Boolean).length,
      }),
    ),
  )
}
```

- Wrap the registration in `ctx.effect` so the tool goes away when the plugin is disabled. Tool results must be JSON-serializable.
- Also available: `ctx.provide(name, value)` registers a service (list the same name in the manifest's `provides`); `ctx.sessions.read(threadId, 0)` reads thread events read-only (add `sessions` to `inject`).

### 5. UI entry (client.js)

Runs in the window. Pigcode provides `react` and `@pigcode/ui-primitives`; import them by package name and don't bundle your own React. Without JSX, use `createElement`:

```js
import { createElement as h, useState } from "react"
import {
  Button,
  ListRow,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"

function Panel() {
  const { locale } = useLocale()
  const [count, setCount] = useState(0)
  const label = locale.startsWith("en") ? `Clicked ${count}` : `点了 ${count} 次`
  return h(Button, { variant: "primary", onClick: () => setCount(count + 1) }, label)
}

function Settings() {
  const [on, setOn] = useState(false)
  return h(
    SettingSection,
    { title: "Display name" },
    h(
      SettingRow,
      { title: "Switch" },
      h(Switch, { checked: on, onCheckedChange: setOn, "aria-label": "Switch" }),
    ),
  )
}

export function apply(ctx) {
  const disposers = [
    ctx.panels.register({ id: "<slug>-panel", title: "Display name", Component: Panel }),
    ctx.surfaces.register({
      id: "<slug>-view",
      title: "Display name",
      description: "One line shown in the launcher",
      Component: Panel,
    }),
    ctx.settingsPages.register({
      id: "<slug>-settings",
      title: "Display name",
      Component: Settings,
    }),
    ctx.commands.register({ id: "<slug>-run", title: "Command name", slash: "<slug>", run() {} }),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
```

- Extension points: `panels` (a block in the left sidebar), `surfaces` (a tab in the right panel), `settingsPages` (a page in Settings), `commands` (command palette ⌘K and the input's `/`), `toolRenderers` (how a tool call looks in the timeline: `{ id, tools: ["tool name"], Component }`, and the component gets `{ tool }`).
- Register only what you need; each `id` is unique within its extension point; register synchronously inside `apply` and return one function that removes them all.
- Build the UI from ui-primitives components (Button, ListRow, SettingSection, SettingRow, Switch, Badge, EmptyState and so on) without hard-coded colors or sizes; pick Chinese or English text from `useLocale().locale`.

### 6. Marketplace catalog

`plugins/.pigcode-plugin/marketplace.json`:

```json
{
  "name": "dev-<project>",
  "displayName": "<project> plugins",
  "plugins": [
    {
      "name": "pigcode-<slug>",
      "source": "./<slug>",
      "displayName": "Display name",
      "description": "One-line summary",
      "version": "0.1.0"
    }
  ]
}
```

- The marketplace `name` uses only lowercase letters, digits, `.`, `_` and `-` (turn the project folder name into lowercase with hyphens).
- Each entry's `name` matches the plugin's package.json `name`, and its `version` stays in sync with package.json.
- If the file already exists, only add or change the matching entry and keep the other entries and fields.

### 7. Checks

- If Node is available, run `node --check` on every .js file; make sure all JSON parses, the entry files exist, and no TODOs are left.
- Don't touch Pigcode's install folder or config files, and don't install the plugin for me.

### 8. When you're done, tell me

- The absolute paths of the plugin folder and of `plugins/`, the package name and the version.
- To install: in Pigcode's sidebar open "Plugins" → "Add" → "Add a marketplace", enter the absolute path of `plugins/` and tick the risk confirmation; then find the plugin under "Marketplace" and click "Install".
- To change it later: bump `version` in package.json and in the catalog, refresh this marketplace under "Marketplace sources", then click the plugin's "Update".
- Until I've installed and tried it, say that this step is still up to me.
