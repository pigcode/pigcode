# 处理提醒与通知定位

Host 从实时会话事件识别审批、提问、完成和失败。审批和提问等 800 毫秒，确认请求仍待处理后按请求 ID 提醒。完成和失败按 run ID 提醒，并核对该轮结果仍未读。两个重复事件在同一个提醒目标上合并。手动停止继续用会话里的状态更新。 [通知决策 #98](https://github.com/pigcode/monorepo/issues/98) · [DSH Go 的 800 毫秒延迟](https://github.com/ccch1mneyyy/dsh-Go/blob/62b6a35d89eed3691be5cf941fa3e00bbc7df903/app/lib/state/notify_state.dart#L215-L238)

通知使用通用文案。手机的 `pigcode` 载荷包含 `version`、`eventId`、`computerId`、`threadId` 和 `kind`，其中 `computerId` 是已配对电脑公钥的完整 SHA-256 摘要。点击后定位到相应电脑和会话。离线时可读该电脑的缓存，重连后以 Host 的侧栏和时间线为准。审批和提问在会话内处理。

- 桌面在「设置 → 通用」切换「桌面提醒」。窗口失焦或隐藏时可发系统通知，点按后唤起窗口并打开对应会话。
- 手机在「电脑 → 通知设置」管理「手机提醒」和系统授权。连接时报告开关和授权状态，桌面在「设置 → 手机连接」按设备显示推送登记状态和最后同步时间。 [iPhone APNs 登记与验收](mobile-apns.md)

## 模拟器验收

在 `apps/mobile` 执行。测试入口使用两个虚拟电脑和独立临时缓存。目标为「乙机通知会话」，区别于默认的最近会话。

```sh
PIGCODE_MOBILE_BUILD_NUMBER=12 ./scripts/flutter-app.sh build ios --simulator --debug \
  --target test/fixtures/reminder_app.dart
xcrun simctl install booted app/build/ios/iphonesimulator/Runner.app
xcrun simctl launch booted com.pigcode.mobile
```

在 iOS 模拟器的「通知设置」允许系统授权，回到主屏后运行下面的命令。点按 Pigcode 系统提醒，确认启动到「乙机通知会话」，同时显示离线提示和「乙机目标历史」。 [Apple 模拟器推送文档](https://developer.apple.com/documentation/xcode-release-notes/xcode-11_4-release-notes)

```sh
xcrun simctl terminate booted com.pigcode.mobile
xcrun simctl push booted com.pigcode.mobile app/test/fixtures/reminder.apns
```

Android 通过 Debug 构建的接收器发布系统通知。在模拟器的通知抽屉点按「等你处理」，核对与 iOS 相同的会话和离线历史。 [Android 系统通知文档](https://developer.android.com/develop/ui/compose/notifications/create-notification)

```sh
PIGCODE_MOBILE_BUILD_NUMBER=12 ./scripts/flutter-app.sh build apk --debug \
  --target test/fixtures/reminder_app.dart
adb install -r app/build/app/outputs/flutter-apk/app-debug.apk
adb shell pm grant com.pigcode.mobile android.permission.POST_NOTIFICATIONS
adb shell am start -W -n com.pigcode.mobile/.MainActivity
adb shell input keyevent KEYCODE_HOME
adb shell am kill com.pigcode.mobile
payload=$(node -p 'JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).pigcode)' app/test/fixtures/reminder.apns)
adb shell "am broadcast -n com.pigcode.mobile/.DebugReminderReceiver --es com.pigcode.mobile.REMINDER '$payload'"
```

## Host 与桌面验收

在前端仓库根目录运行。

```sh
pnpm exec vitest run apps/host/src/rpc/host-reminders.test.ts \
  apps/desktop/src/main/desktop-reminders.test.ts
```

在桌面构建里，让一个会话发起审批或提问，或等待运行结束，再切换到其他应用或隐藏 Pigcode。在系统里点按提醒，核对打开的会话。macOS 的系统通知要求应用经过代码签名，Windows 使用 NSIS 安装后生成的开始菜单快捷方式。 [Electron 平台要求](https://www.electronjs.org/docs/latest/tutorial/notifications#platform-considerations)

按[两个 Go 中继的验收](mobile-pairing.md#两个-go-中继的验收)运行 `mobile-device-management.test.ts`，检查手机报告的设置只更新自己的设备记录，Host 重启后保留原同步时间。

## 验收记录

2026-11-23，手机界面显示产品版本 `0.1.0-beta.5`，系统包版本 `0.1.0`，构建号 `12`。

- iPhone 17 Pro（iOS 26.0）显示系统横幅。点按后冷启动打开「乙机通知会话」，并显示「乙机目标历史」。
- Android 16（ARM64 模拟器）在通知抽屉显示「等你处理」。点按后打开「乙机通知会话」，并显示「乙机目标历史」。
- macOS 15.6.1（ARM64）用 ad-hoc 签名的 `0.1.0-beta.5` 桌面包验收。窗口隐藏时收到系统通知的展示回调，触发通知点击回调后打开了发起提问的会话。
- 两个本机 Go WSS 中继的回环测试通过。手机设置只同步到自身设备记录，Host 重启后保留最后同步时间。
