# iPhone APNs 提醒

使用付费签名时，iOS 从 APNs 取得设备令牌，经 Noise 加密连接向已配对电脑报告令牌、环境、手机提醒开关和通知授权。Host 按设备授权保存加密后的令牌，落盘后确认。桌面「手机连接」显示登记状态和最后同步时间。配对多台电脑时，每台在手机与它连接时接收最新令牌。关掉「手机提醒」会取消当前 iPhone 的 APNs 注册，并在连接的电脑上同步开关状态。 [Apple 注册文档](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns) · [Apple 取消注册文档](https://developer.apple.com/documentation/uikit/uiapplication/unregisterforremotenotifications())

Host 从现有提醒事件选出仍授权、已登记且允许通知的设备。每条 `relay.push` 只提交一个登记。服务器为配置清单中的电脑开放推送，在 Host 准入回执里发随机 X25519 公钥。Host 用电脑已有的 X25519 身份与中继公钥计算共享密钥，用 HMAC-SHA256 对 `pigcode-relay-apns-v1`、中继公钥和电脑公钥的拼接作证明。中继核对证明和电脑公钥指纹后才调用 APNs。普通配对继续使用现有中继协议。

APNs 发送凭据留在 Go 后端。每个环境使用对应的密钥和入口，通知只带通用文案与电脑、会话和事件的定位引用。APNs 报告令牌失效时，Host 核对登记 ID 后移除对应令牌，等手机再次向 iOS 取得登记结果后再恢复投递。服务临时不可用时保留登记。提醒即时投递，后续事件从 Host 最新状态生成。 [APNs HTTP/2 请求](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) · [APNs 返回码](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)

## 本地验收

安装前端依赖后，在聚合仓库执行。

```sh
(cd frontend && pnpm install --frozen-lockfile)
(cd frontend/apps/mobile && flutter pub get --enforce-lockfile)
frontend_dir="$(pwd)/frontend"
(cd backend && go test -race ./...)
(cd backend && PIGCODE_PUSH_FRONTEND_DIR="$frontend_dir" go test -run '^TestHostPushOverGoWSS$' -count=1 -v)
```

回环使用两个通过 Noise 配对的 Dart 客户端，检查正式和开发环境的设备分别收到提醒，更新令牌后只发送到新令牌，APNs 失效回执清除对应登记，撤销设备和关闭手机提醒后停止向该设备发送。通知展现和点按跳转可复用[模拟器验收](mobile-reminders.md#模拟器验收)。

## 验收记录

- 2026-11-23，本机 HTTP/2 测试验证了 APNs 签名、两个环境、通用文案、失效与临时错误。Go WSS 回环连续三次通过，覆盖设备授权、轮换、撤销、Host 重启和迟到的失效回执。
- 产品版本 `0.1.0-beta.5`，手机构建 `13`。iOS 模拟器、iOS 未签名设备包和 Android 模拟器 APK 均构建通过。Flutter 原生通知通道及桌面登记状态通过回归测试。

## TestFlight 真机验收

1. 为 Apple Developer 项目中的 `com.pigcode.mobile` 启用 Push Notifications，用正式环境的 APNs Key ID、Team ID 和服务器上的 `.p8` 配置 Go 后端。开发签名使用开发环境配置。 [APNs 发送认证](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
2. 归档 Runner 时传入两个 Xcode build settings，`PIGCODE_APNS_ENTITLEMENTS=Runner/PushNotifications.entitlements` 和 `PIGCODE_APNS_ENVIRONMENT=production`。使用开发 provisioning profile 时，环境填 `development`。用 `codesign -d --entitlements :- <Runner.app>` 核对签名包的 `aps-environment` 后再上传 TestFlight。常规模拟器和免费签名构建沿用默认的空配置。 [签名环境](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment)
3. 从 TestFlight 安装，允许系统通知，配对并连接电脑。在桌面「手机连接」核对该设备显示「APNs 已登记」。锁屏后让电脑的 Agent 发起提问或审批，核对系统提示只显示 Pigcode 和通用状态。点按回到实际会话。
4. 再测试完成或失败、关闭手机提醒、桌面撤销设备。保存 TestFlight 构建号、iOS 版本、后端提交、验证时间和送达及跳转结果。
