# 发版

一个版本怎么从 tag 变成 GitHub Release。决定见 pigcode/pigcode 的 ADR 0007（版本号）、0009（推 tag 发版、先出草稿）、0010（只用 GitHub Release）。

## 1. 改版本，推 tag

版本号只有一个来源：`apps/desktop/package.json` 的 `version`。

```sh
# 在 pigcode/pigcode 的 main 上
pnpm --dir apps/desktop version patch --no-git-tag-version   # 或 minor / major
git commit -am "chore: release 0.2.0"
git push
git tag v0.2.0
git push origin v0.2.0
```

预发布写成 `0.2.0-beta.1`，tag 是 `v0.2.0-beta.1`。tag 和版本号不一致时 workflow 会直接失败。

## 2. workflow 做什么

`.github/workflows/release.yml`，推 `v*` tag 时触发：

1. 检查 tag 和 `apps/desktop/package.json` 一致。
2. 三个平台各自：lint、类型检查、单元测试 → 打包 → 跑打包后的应用的冒烟测试（`pnpm --dir apps/desktop run test:packaged`，见 #69）。
   - macOS：arm64 和 x64 各一个 DMG，不签名、不公证。
   - Windows：x64 的 NSIS 安装包。
   - Linux：AppImage 和 deb。
   - 安装包里带 LICENSE、`THIRD_PARTY_NOTICES.txt`、Electron 和 Chromium 的声明。
3. 全部成功才建 **草稿** Release，附上安装包和 `latest*.yml`。草稿不对外可见，也不会被自动更新看到。

手动运行（`.github/workflows/release.yml` → Run workflow）同样打包、跑冒烟，但只留 Actions artifact，不建 Release，用来出内部测试包。

任何一个平台失败都不建草稿。

## 3. 发布前的人工冒烟

自动冒烟用的是 fake agent。真实 CLI、系统集成和「看起来对不对」还得人过一遍。发布草稿前在 macOS 上做这些，Windows 和 Linux 有机器时抽查：

- [ ] 从 **Finder / Dock** 启动安装后的应用（不是命令行），设置页能打开，没有「Host 无法启动」之类的报错。
- [ ] 用真实 Claude Code 和真实 Codex 各开一个会话，发一句会用到插件工具的话，确认工具被调用（#55、#53）。
- [ ] 装一个构建好的插件（例如 `examples/capability-clock` 的 `dist`），面板正常显示。
- [ ] 终端能开、能敲命令；关掉应用后终端里的进程不在了。
- [ ] 关窗口：macOS 和 Windows 上应用还在托盘里，点 Dock 或菜单栏图标能回窗口；Linux 上直接退出。
- [ ] 有任务在跑时退出，确认框出现，选「继续运行」任务继续。
- [ ] 设置页「检查更新」能连上 GitHub（仓库公开后）；发现新版本时提示能打开下载页。
- [ ] 第二个版本起：Windows 和 AppImage 能从上一个版本更新，用户数据还在（更新会在下载完成后、下次退出时安装，或点提示里的「重启并更新」）。这一条要在两个真实版本之间验证，所以最早在第二个版本发布时做（#71）。
- [ ] macOS 第一次打开要右键 →「打开」；Windows 会弹 SmartScreen —— 这是未签名的预期行为（ADR 0005）。

## 4. 发布、撤回、更新指针

发布：打开草稿 Release，改好说明（更新日志就是这段说明，应用里不显示全文，只链接到这里），点 Publish。预发布版本保持 prerelease 勾选，它不会进入自动更新。

撤回：把 Release 改回草稿或删掉。新用户和还没更新的用户就拿不到了；已经更新过的用户不能降级，尽快发一个更高的修复版本。

发版后在聚合仓库里更新 submodule 指针：

```sh
cd pigcode            # 聚合仓库
git -C frontend fetch && git add frontend
git commit -m "chore: bump frontend to 0.2.0"
```

## 5. 更新怎么工作

三种处理方式，判断逻辑在 `apps/desktop/src/main/update-mode.ts`：

| 平台 | 做法 |
|---|---|
| Windows、AppImage | electron-updater 后台下载，提示「重启并更新」，不点的话下次退出时安装 |
| macOS | 下载对应架构的 DMG，提示「打开安装包」；用户在挂载出来的窗口里把 Pigcode 拖进「应用程序」 |
| deb 等其余 | 只提示，点开下载页 |

macOS 走不了 electron-updater（包没签名，ADR 0005），但整条升级链路仍然在应用里走完：应用自己按 `process.arch` 从 Release 附件里挑 DMG、下载到 `userData/update-downloads/`，再交给系统打开。用户数据在 `~/Library/Application Support/Pigcode`，换掉 `.app` 不影响会话、设置和插件。下载过的包在下次启动时清掉。

下载或打开失败都会退回下载页，不会让用户卡在一条走不通的路上。这条链路由 `apps/desktop/e2e/packaged-update.spec.ts` 在打包产物上验证。

## 6. 现在还不能做的事

- 还没验证过真实两版本之间的自动更新：Windows 和 AppImage 需要一台能装安装包的机器（#71）。发现新版本的逻辑已经用真实 GitHub 数据验过，包括预发布通道。
- 发布前的人工冒烟还没做（见上面的清单）。
- macOS 的安装包没签名，electron-updater 不能更新它；改用「下载 DMG 让用户拖进应用程序」（ADR 0005）。
- Linux 的 deb 不做自动更新（要输入系统密码、每次全量下载），只提示。
