# 手机扫码配对 v1

在桌面进入「设置 → 手机连接」，测试并保存中继，点「配对手机」。在手机端点「扫码配对电脑」，核对两端显示的数字，然后在电脑点允许。二维码的有效期为三分钟，配对完成、过期或取消后都需要重新生成。手机在「电脑」页切换已配对电脑，切换时先结束当前连接。

## 更新中继和撤销配对

1. 在桌面输入新中继地址与令牌并点「测试并保存」。测试通过后 Host 切到新中继。仍用原配置的设备会标为「待更新中继」。
2. 点「生成更新二维码」，在已经配对的手机扫描。该手机使用原设备密钥，验证二维码中的电脑公钥与本机保存的公钥一致。核对双方显示的数字后，在桌面点「核对一致，更新中继」。手机在连接验证通过后保存新配置，再用加密回执清除桌面的待更新标记。手机已有新配置但回执未送达时，下次连接会再发一次。
3. 在桌面「已配对设备」选择撤销。核对对话框里的设备名和编号再确认。设备编号也显示在手机「电脑」页。该设备的所有连接会断开，重连需要再次配对。撤销最后一部设备时，Host 关闭常驻中继，仍可用已保存的中继配置生成新二维码。

手机端可以移除本机保存的电脑。曾被撤销的手机可先移除该电脑，再扫描新二维码，从桌面重新授权。

## 协议

两端主动连接配置的 `wss://` 地址。Host 发 `relay.host`，手机发 `relay.phone`，带协议版本、访问令牌和电脑 ID。电脑 ID 为电脑 X25519 公钥的完整 SHA-256 十六进制摘要。中继返回 `relay.result`，用 JSON `relay.open` 和 `relay.close` 控制 Host 一侧的会话。手机发出的二进制帧原样转发，Host 一侧的二进制帧在前四字节用大端无符号整数标记会话。单条 Noise 密文上限为 65,535 字节。配置探测继续使用独立的 `relay.probe` 交换。 [中继消息夹具](../packages/contracts/fixtures/relay-route-v1.json)

二维码使用 `pigcode.pair` JSON，包含版本、中继地址、访问令牌、电脑公钥、显示名称、到期时间和 32 字节随机秘密。公钥和秘密使用无填充的 base64url。Noise 套件为 `Noise_IK_25519_ChaChaPoly_SHA256`，prologue 为 UTF-8 `pigcode-mobile-v1`。手机以固定的电脑公钥发起握手，用首条握手的加密载荷提交设备名称、平台和配对秘密，或提交 `device.connect` 请求恢复已授权身份。 更新中继时，手机在首条加密载荷中发送 `device.updateRelay` 与本次二维码的一次性秘密。Host 核对设备公钥仍在本机配对清单，再开始桌面核对。 [Noise 规范](https://noiseprotocol.org/noise.html#interactive-handshake-patterns-fundamental) · [共享 Noise 向量](../packages/contracts/fixtures/noise-ik-v1.json)

新设备完成握手后发送加密的 `device.confirm`。Host 返回 `device.check`，两端以 `SHA-256(UTF8("pigcode-pairing-check-v1") || 握手哈希)` 的前四字节取大端整数，对一百万取余并补足六位。Host 在桌面确认本次请求后持久化设备公钥并发送 `device.approved`。随后用加密的 `mobile.hello` 和 `mobile.welcome` 协商版本与能力。不兼容时返回 `mobile.incompatible`。本切片的能力 `connection.status` 提供 `mobile.status`，项目和会话操作由后续工单开放。

## 构建

在 `apps/mobile` 使用 `.flutter-version` 指定的 Flutter 和随附 Dart SDK。iOS 使用本机 Xcode，Android 使用本机 SDK。开发构建从桌面包读取产品版本，可用 `PIGCODE_MOBILE_BUILD_NUMBER` 设置本次构建号。

```sh
flutter pub get
dart analyze
(cd packages/pigcode_transport && dart test)
./scripts/flutter-app.sh build ios --simulator --debug
./scripts/flutter-app.sh build apk --debug
```

模拟器包位于 `app/build/ios/iphonesimulator/Runner.app`，Android APK 位于 `app/build/app/outputs/flutter-apk/app-debug.apk`。

## 本机 Go 回环

使用本机 CA 签发测试站点证书，TS 和 Dart 验收进程都加载这份 CA。以下命令在 `pigcode/backend` 执行。

```sh
trial_dir=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
  -subj '/CN=Pigcode Local Relay Test CA' \
  -addext basicConstraints=critical,CA:TRUE \
  -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$trial_dir/ca.key" -out "$trial_dir/ca.crt"
openssl req -newkey rsa:2048 -nodes -sha256 -subj /CN=localhost \
  -keyout "$trial_dir/relay.key" -out "$trial_dir/relay.csr"
cat > "$trial_dir/leaf.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
subjectAltName=DNS:localhost,IP:127.0.0.1
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -sha256 -days 2 -in "$trial_dir/relay.csr" \
  -CA "$trial_dir/ca.crt" -CAkey "$trial_dir/ca.key" -CAcreateserial \
  -extfile "$trial_dir/leaf.ext" -out "$trial_dir/relay.crt"
PIGCODE_RELAY_TOKEN=pairing-113-local go run ./cmd/pigcode-relay \
  -tls-cert "$trial_dir/relay.crt" -tls-key "$trial_dir/relay.key"
```

另开终端进入 `pigcode/pigcode`，将 `ca.crt` 的路径换成上一步的文件。

```sh
export NODE_EXTRA_CA_CERTS=/路径/到/ca.crt
export PIGCODE_RELAY_TEST_CA="$NODE_EXTRA_CA_CERTS"
export PIGCODE_RELAY_TEST_URL=wss://127.0.0.1:18765/ws/v1/connect
export PIGCODE_RELAY_TEST_TOKEN=pairing-113-local
pnpm exec vitest run apps/host/src/mobile apps/host/src/rpc/mobile-pairing.test.ts
pnpm --dir apps/desktop exec playwright test e2e/mobile-pairing.spec.ts
```

Host RPC 回环会启动纯 Dart 客户端，经真实 Go 中继比较两端核对码，验证桌面允许前的 RPC、一次性二维码、连接恢复与版本门槛。设置 `PIGCODE_RELAY_TEST_IDLE_SECONDS=55` 可验证连接空闲超过两个心跳周期后仍可请求状态。另设 `PIGCODE_RELAY_TEST_CERT` 和 `PIGCODE_RELAY_TEST_KEY` 指向上述测试站点证书及私钥，可验证升级请求拒绝重定向。使用 1Panel 的公开可信证书时，测试进程采用系统信任链，使用本机保存的站点地址和令牌。

## 两个 Go 中继的验收

保留上面的本机中继，再在另一终端启动第二个 Go 中继。证书继续使用上一步生成的站点证书。

```sh
PIGCODE_RELAY_TOKEN=pairing-114-next go run ./cmd/pigcode-relay \
  -addr 127.0.0.1:18766 \
  -tls-cert /路径/到/relay.crt -tls-key /路径/到/relay.key
```

在 `pigcode/pigcode` 中保留本机回环使用的 CA 和第一个中继的环境变量，再运行下面的命令。

```sh
export PIGCODE_RELAY_NEXT_TEST_URL=wss://127.0.0.1:18766/ws/v1/connect
export PIGCODE_RELAY_NEXT_TEST_TOKEN=pairing-114-next
pnpm exec vitest run apps/host/src/rpc/mobile-device-management.test.ts
pnpm --dir apps/desktop exec playwright test e2e/mobile-device-management.spec.ts
```

测试会验证二维码中的电脑公钥不变、更新失败时手机保留旧配置、两部手机逐台迁移、撤销后 Host 重启仍拒绝该设备，以及撤销最后一部设备后的中继关闭和重新配对。

电脑状态订阅、心跳和重连验收见[手机恢复会话](mobile-recovery.md)。

## iPhone 经现有云端中继复验

1. 用自己的 Apple Personal Team 给 `apps/mobile/app/ios/Runner.xcworkspace` 的 Runner 签名。应用 ID 固定为 `com.pigcode.mobile`，相同 Team 下可覆盖安装。
2. 从 `apps/mobile` 执行 `./scripts/flutter-app.sh run -d <设备 ID>`。打开手机 App，允许相机权限。切到蜂窝网络。
3. 在电脑配置现有 1Panel 测试站点，测试并保存，生成配对二维码。手机扫描后核对六位数字，然后在电脑确认。手机在「电脑」页显示已连接，桌面设备清单显示该手机。取消或等待过期后再次扫码应要求生成新二维码。
4. 用相同 Team 和应用 ID 覆盖安装，打开手机 App 并点按已配对电脑。设备应继续通过身份验证。记录手机系统、桌面和手机构建号，以及连接结果。
