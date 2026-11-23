# 手机自用首版验收

## 模拟器安装到回复

从前端仓库根目录执行。先安装 Node 依赖与固定版本的 Flutter，进入 `apps/mobile` 执行 `flutter pub get --enforce-lockfile`。按本机 Go 回环配置启动测试中继，并设置 `PIGCODE_RELAY_TEST_URL`、`PIGCODE_RELAY_TEST_TOKEN`、`PIGCODE_RELAY_TEST_CA` 和 `NODE_EXTRA_CA_CERTS`。Android 转发使用该 URL 的端口。 [本机 Go WSS 配置](./mobile-pairing.md#本机-go-回环)

集成测试只接受已运行的模拟器。每次生成带独立应用标识的临时 Flutter 工程，使用 Pigcode 界面、临时 Host、预置配对和测试存储。测试安装并打开 App，连接测试电脑、打开会话，发送消息并在时间线核对回复。连接和运行使用真实的 Go WSS、Noise 与 Host。 [Flutter 集成测试](https://docs.flutter.dev/testing/integration-tests)

```sh
ios_simulator_id='填入 flutter devices 显示的 iOS 模拟器 ID'
PIGCODE_MOBILE_BUILD_NUMBER=15 PIGCODE_SIMULATOR_SMOKE_DEVICE="$ios_simulator_id" \
  pnpm exec vitest run apps/host/src/rpc/mobile-simulator-smoke.test.ts

relay_port=$(node -p 'new URL(process.env.PIGCODE_RELAY_TEST_URL).port || "443"')
adb -s emulator-5554 reverse "tcp:$relay_port" "tcp:$relay_port"
PIGCODE_MOBILE_BUILD_NUMBER=15 PIGCODE_SIMULATOR_SMOKE_DEVICE=emulator-5554 \
  pnpm exec vitest run apps/host/src/rpc/mobile-simulator-smoke.test.ts
adb -s emulator-5554 reverse --remove "tcp:$relay_port"
```

默认使用 fake Agent。用同一个入口可在模拟器接真实 Codex 或 Claude Code，前提是对应 CLI 已登录。运行会消耗账号额度。

```sh
PIGCODE_REAL_CODEX=1 node scripts/real-smoke.ts codex
PIGCODE_REAL_CLAUDE=1 node scripts/real-smoke.ts claude

PIGCODE_MOBILE_BUILD_NUMBER=15 PIGCODE_REAL_CODEX=1 PIGCODE_SIMULATOR_SMOKE_AGENT=codex \
  PIGCODE_SIMULATOR_SMOKE_DEVICE="$ios_simulator_id" \
  pnpm exec vitest run apps/host/src/rpc/mobile-simulator-smoke.test.ts
```

将 `PIGCODE_REAL_CODEX`、`codex` 换成 `PIGCODE_REAL_CLAUDE`、`claude` 可核对手机经 Host 调用真实 Claude Code。 [已有 CLI 冒烟](../scripts/real-smoke.ts)

## 通知与桌面回归

使用 iOS 和 Android 夹具，将 `PIGCODE_MOBILE_BUILD_NUMBER` 设为本次验收的构建号。点按系统通知后核对目标电脑、会话和离线历史。实际 APNs 送达随付费签名验收。 [模拟通知步骤](./mobile-reminders.md#模拟器验收) · [TestFlight 步骤](./mobile-apns.md#testflight-真机验收)

桌面回归从前端仓库运行，保留本机 Go WSS 配置。安装包回归使用同一提交的打包产物。 [桌面打包说明](./release.md)

```sh
pnpm --dir apps/desktop exec playwright test e2e/m0-b.spec.ts \
  e2e/mobile-pairing.spec.ts e2e/mobile-device-management.spec.ts \
  e2e/relay-settings.spec.ts e2e/sidebar-filters.spec.ts \
  e2e/context-menus.spec.ts e2e/m10-questions.spec.ts

PIGCODE_PACKAGED_APP=/路径/到/Pigcode.app/Contents/MacOS/Pigcode \
  PIGCODE_PACKAGED_EXPECTED=1 PIGCODE_UPDATE_CHECK=0 \
  pnpm --dir apps/desktop exec playwright test e2e/packaged.spec.ts
```

## 手机截图回归

侧栏、时间线、审批、提问、离线历史、离线侧栏和全屏 diff 各有 iOS 与 Android 的浅色、深色基线，共 28 张。测试使用实际 Flutter 界面组件和固定会话数据，视口为 390×844 逻辑像素，系统边距按测试平台设置。脚本下载并校验固定的 Noto Sans SC，等宽文字使用锁定的 `gpt_markdown` 所带的 JetBrains Mono，图标使用固定 Flutter SDK 的 Material Icons。 [验收方案 #100](https://github.com/pigcode/monorepo/issues/100#issuecomment-7075972281) · [DSH Go 截图设置](https://github.com/ccch1mneyyy/dsh-Go/blob/36f232df1deba9be9730f068b8db80f2a5cbbda7/app/test/shell/golden_harness.dart)

在使用固定 Flutter 版本的 macOS 15 ARM64 环境中，从前端仓库根目录运行。

```sh
cd apps/mobile
flutter pub get --enforce-lockfile
./scripts/test-visual.sh
```

Mobile CI 在同一类 runner 上逐像素比对。失败时可下载 `mobile-visual-diffs`，其中含基线、实际截图和两种差异图，保留 7 天。预期界面有改动时运行 `./scripts/test-visual.sh --update-goldens`，或手动运行 Mobile CI 并勾选「生成手机截图候选基线」。候选 PNG 可从 `mobile-visual-baselines` 下载，审核后提交到 `apps/mobile/app/visual/baselines/`。 [Flutter 截图比较器](https://api.flutter.dev/flutter/flutter_test/LocalFileComparator-class.html) · [Mobile CI 配置](../.github/workflows/mobile.yml)

## iPhone 真机验收

1. 用同一 Apple Team 和 `com.pigcode.mobile` 签名覆盖安装。打开 App，核对以前配对的电脑仍在列表并能连接。 [构建和配对](./mobile-pairing.md#iphone-经现有云端中继复验)
2. 用已有大陆 Go 中继连接电脑。Wi‑Fi 与蜂窝网络各跑一次发送、回复和审批或提问。切网、切后台再回来，并在电脑合盖睡眠和恢复后核对连接提示、历史补齐与能否继续操作。记录 iOS、网络、构建和中继提交。 [云中继试验背景](https://github.com/pigcode/monorepo/issues/103)
3. 在同一设备以 profile 模式回放固定长会话。记录夹具、首屏时长、帧耗时分位数、峰值内存和首屏数据量。上翻加载历史时确认当前文字位置保留，输出过程中回到底部后确认继续跟随。真机数据用于性能基线。 [Flutter 真机性能测量](https://docs.flutter.dev/perf/ui-performance) · [会话回放验收](./mobile-timeline.md)

## 2026-11-23 本机验收记录

手机产品版本 `0.1.0-beta.5`，系统包版本 `0.1.0`，构建号 `15`。本机 Go 中继使用 `pigcode/backend` 的 `d2135a1`。

| 项目 | 结果 |
| --- | --- |
| 安装到回复 | iPhone 17 Pro（iOS 26.0）和 Android 16 模拟器的 fake Agent 冒烟通过。iOS 另经 Host 调用真实 Codex 并显示 `OK`。 |
| 系统模拟通知 | 两端均显示「等你处理」。点按后定位到「乙机通知会话」，并显示离线缓存「乙机目标历史」。 |
| 手机回归 | Flutter 分析通过，App 48 项、传输包 2 项、客户端包 5 项测试通过。 |
| 桌面回归 | 8 项 Playwright 定向回归通过。macOS ARM64 ad-hoc 签名包的 2 项冒烟通过。 |
| 本机真实 CLI | Codex `0.171.0` 的 3 项冒烟通过。Claude Code `2.1.330` 的回复用例因本机 OAuth 会话过期而阻塞。 |

真机阶段待记录 iPhone 签名覆盖后的配对留存、大陆云中继下的蜂窝与睡眠恢复、长会话 profile 数据。正式 APNs 送达随 TestFlight 验收。 [首版验收 #127](https://github.com/pigcode/monorepo/issues/127) · [TestFlight #126](https://github.com/pigcode/monorepo/issues/126)
