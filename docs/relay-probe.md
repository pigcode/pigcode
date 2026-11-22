# 中继探测协议 v1

桌面「设置 → 手机连接」可填写中继地址与访问令牌。点击「测试并保存」时，Host 建立一次独立的 WSS 连接。探测通过后才保存新配置，探测连接与后续的电脑登记分开。复测同一地址可使用已保存的令牌。填写新地址时要一并输入该中继的令牌。

## 控制消息

默认端点为 `/ws/v1/connect`。填写站点根地址时，Host 会补上这个路径。

Host 在 WebSocket 上发一条 JSON 文本帧，类型为 `relay.probe`，包含协议 `version` 和访问 `token`。中继以 `relay.probe.result` 文本帧返回协议版本和结果。当前结果为 `ok`、`token-rejected` 或 `incompatible`。中继结束这条短连接。完整示例见[探测夹具](../packages/contracts/fixtures/relay-probe-v1.json)，由 Go 中继同步并用于协议测试。夹具中的令牌仅用于测试。

## 本机验收

在 `pigcode/backend` 运行 `go test ./...`。也可在本机用专用的测试证书启动中继，下面的证书仅由指定测试进程信任：

```sh
trial_dir=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
  -subj /CN=localhost -keyout "$trial_dir/relay.key" -out "$trial_dir/relay.crt"
PIGCODE_RELAY_TOKEN=local-relay-test go run ./cmd/pigcode-relay \
  -addr 127.0.0.1:18765 -tls-cert "$trial_dir/relay.crt" -tls-key "$trial_dir/relay.key"
```

在另一个终端进入 `pigcode/pigcode`，将下列证书路径换成上一步的路径。Host RPC 和桌面端到端测试共用同一个 Go 进程：

```sh
export NODE_EXTRA_CA_CERTS=/路径/到/relay.crt
export PIGCODE_RELAY_TEST_URL=wss://127.0.0.1:18765/ws/v1/connect
export PIGCODE_RELAY_TEST_TOKEN=local-relay-test
pnpm exec vitest run apps/host/src/rpc/relay-settings.test.ts
pnpm --dir apps/desktop exec playwright test e2e/relay-settings.spec.ts
```

桌面测试要使用可用的系统凭据存储。它验证正确令牌能保存，错误令牌会被拒绝，重开设置页时令牌字段只显示配置状态。

## 云端验收

将 Go 中继部署到约定的测试站点，由 1Panel 的 HTTPS 站点代理 WebSocket。桌面填该站点的 `wss://` 地址和服务端配置的令牌，点「测试并保存」。成功时显示连接已验证。随后用错误令牌重试，确认失败提示和已保存的配置。记录前端和后端提交、桌面构建版本和验证结果。
