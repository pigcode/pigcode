# Pigcode 官方插件目录

桌面端从官方市场读取「公开」和「社区」目录。打开插件市场时会在后台刷新，联网失败时可继续浏览上次缓存和随应用提供的首发目录。安装会下载对应版本的 `.tgz`，校验 SHA‑256 和包名、版本，然后按普通插件加载。

| 目录 | 插件             | 使用入口                                         |
| ---- | ---------------- | ------------------------------------------------ |
| 公开 | 项目概览         | 右侧工作台的「项目概览」                         |
| 公开 | 文本统计         | 右侧工作台的「文本统计」或 MCP 工具 `text_stats` |
| 社区 | Prettier 格式化  | 右侧工作台的「Prettier 格式化」                  |
| 社区 | YAML ↔ JSON 转换 | 右侧工作台的「YAML ↔ JSON 转换」                 |

社区首发条目是 Pigcode 做的开源工具适配。每个条目在清单中注明上游作者和主页，安装包带上游许可证。

## 上架和更新

在 `plugins/` 添加插件包，在 `package.json` 的 `marketplace` 中填写发布者、用途分类和展示文案。发布新版时修改插件自己的 `version`。打包使用仓库已锁定的依赖。

```sh
pnpm install --frozen-lockfile
pnpm marketplace:build <plugin-catalog-分支的工作树路径>
```

构建会生成 `marketplace.json` 和 `packages/` 中按版本命名的制品。上传目录和新制品到前端仓库的 `plugin-catalog` 分支。保留已发布版本的制品，供缓存目录中的条目继续安装。已有同版本制品时，构建会检查内容是否一致。

前端仓库的 `marketplace/marketplace.json` 是随应用提供的目录快照。更新快照时，从已发布的 `plugin-catalog` 分支复制同名文件，保证快照中的制品地址和校验值已在线可用。

```sh
pnpm --dir apps/desktop exec playwright test e2e/official-plugin-market.spec.ts
PIGCODE_REAL_MARKETPLACE=1 pnpm --dir apps/desktop exec playwright test e2e/official-plugin-market.spec.ts
```

第一条命令验证版本发布和更新。第二条从公开分发地址安装并实际使用首批插件。
