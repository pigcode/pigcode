# 技术验证：Flutter 长会话时间线

[pigcode/monorepo#104](https://github.com/pigcode/monorepo/issues/104) 的一次性原型，只留在 `prototype/mobile-timeline` 分支上，不合进 main。

回放一段真实的长会话，看 Flutter 写的时间线在 iPhone 上能不能接受：冷启动、内存、流式更新时的掉帧，加载历史和流式输出会不会移动正在看的内容，以及键盘和中文输入法。

## 准备回放数据

回放数据从 Claude Code 的会话记录转出来，含真实对话内容，`assets/session.json` 已在 `.gitignore` 里，不要提交：

```bash
dart run tool/convert_claude.dart ~/.claude/projects/<项目>/<会话>.jsonl
```

## 在模拟器上跑

iOS 26 的模拟器要用 Xcode 26 构建：

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
flutter run -d <模拟器 ID> --dart-define=SELFTEST=true
```

加上 `SELFTEST=true` 时，启动后自动跑一遍自检，结果打在日志里，前缀是 `[selftest]`：加载更早时视口有没有动、贴底跟随、在新内容里上翻后继续流式时视口有没有动、回放和全部展开时的帧耗时和内存。

模拟器上只能跑 debug 包，帧耗时和内存比真机的 profile 包差很多，只能当上限看。真实数字要在 iPhone 上用 `flutter run --profile` 量。

## 界面上能做的

- 顶上：搜索框（试拼音没确认就切焦点）、回放或暂停最长的一轮、回放速度、加载更早、全部展开、自检。
- 右上角：事件数、行数、内存、帧数、卡顿帧数和最长一帧。
- 底下：输入框（试键盘弹出、拖动收起和中文输入）。

时间线是居中锚定的 `CustomScrollView`（参照 DSH Go）：中心线以上是打开时已有的历史，往上长；中心线以下是之后新来的行，流式增长只发生在这一段。
