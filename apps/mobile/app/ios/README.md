# iOS ShareExtension 与签名配置说明

## 默认构建（iOS 模拟器 / 付费 Apple Developer 账号）

默认配置位于 `Flutter/ShareExtension.xcconfig`：

- `PIGCODE_APP_GROUP = group.com.pigcode.mobile`（主 App `com.pigcode.mobile` 与 `com.pigcode.mobile.ShareExtension` 共享同一 App Group）
- `PIGCODE_RUNNER_ENTITLEMENTS = Runner/Runner.entitlements`
- `PIGCODE_SHARE_EXTENSION_ENTITLEMENTS = ShareExtension/ShareExtension.entitlements`
- `PIGCODE_DISABLE_SHARE_EXTENSION = 0`

直接执行 `flutter build ios --simulator --no-codesign` 或使用付费 Apple Developer 账号签名打包时，主 App 会自动编译并嵌入 `PlugIns/ShareExtension.appex`。若同时启用 APNs 推送，可继续传入 `PIGCODE_APNS_ENTITLEMENTS=Runner/PushNotifications.entitlements`（已包含 `aps-environment` 与 `com.apple.security.application-groups`）。

## 免费个人 Apple ID 真机调试

免费个人 Apple ID 不支持 App Group 能力签名。如需临时在真机上安装调试主 App，可在本地创建 `ios/Flutter/LocalSigning.xcconfig`（已加入 `.gitignore`，不会入库）并写入：

```xcconfig
PIGCODE_RUNNER_ENTITLEMENTS =
PIGCODE_SHARE_EXTENSION_ENTITLEMENTS =
PIGCODE_DISABLE_SHARE_EXTENSION = 1
```

重新构建即可跳过 App Group entitlement 与 `ShareExtension.appex` 嵌入。
