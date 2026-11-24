import 'package:flutter/material.dart';

/// 桌面会话时间线的尺寸和排版，按 DESIGN.md 与 tokens.css 折算到手机逻辑像素。
/// 组件结构照桌面，外边距和触区按手机规范适配。
abstract final class TimelineType {
  /// 会话正文、工具行、工作折叠头。
  static const double content = 15;
  static const double contentHeight = 24 / 15;

  /// 次级说明、卡片标签、时间。
  static const double meta = 13;
  static const double metaHeight = 18 / 13;

  /// 计数、标记、最小号说明。
  static const double small = 12;
  static const double smallHeight = 16 / 12;

  /// 代码、命令、diff。
  static const double code = 12;
  static const double codeLineHeight = 20;

  static TextStyle contentStyle(Color color, {FontWeight? weight}) => TextStyle(
    fontSize: content,
    height: contentHeight,
    fontWeight: weight ?? FontWeight.w400,
    color: color,
  );

  static TextStyle metaStyle(Color color, {FontWeight? weight}) => TextStyle(
    fontSize: meta,
    height: metaHeight,
    fontWeight: weight ?? FontWeight.w400,
    color: color,
  );

  static TextStyle smallStyle(Color color, {FontWeight? weight}) => TextStyle(
    fontSize: small,
    height: smallHeight,
    fontWeight: weight ?? FontWeight.w400,
    color: color,
  );

  static TextStyle codeStyle(Color color, {double height = codeLineHeight}) =>
      TextStyle(
        fontFamily: 'monospace',
        fontSize: code,
        height: height / code,
        color: color,
      );
}

abstract final class TimelineSpace {
  static const double x1 = 2;
  static const double x2 = 4;
  static const double x3 = 6;
  static const double x4 = 8;
  static const double x5 = 10;
  static const double x6 = 12;
  static const double x7 = 16;
  static const double x8 = 20;
  static const double x9 = 24;

  /// 每轮外缘；首轮用户消息之前留 56。
  static const EdgeInsets turn = EdgeInsets.fromLTRB(x7, 0, x7, x8);
  static const EdgeInsets firstTurn = EdgeInsets.fromLTRB(x7, 56, x7, x8);

  /// 用户气泡内衬。
  static const EdgeInsets bubble = EdgeInsets.symmetric(
    horizontal: x6,
    vertical: x4,
  );

  /// 卡片内衬。
  static const EdgeInsets card = EdgeInsets.all(x7);

  /// 轮内块之间 20，工作项之间 16，行内字段之间 8。
  static const double blockGap = x8;
  static const double workGap = x7;
  static const double fieldGap = x4;

  /// 用户气泡最长 120 后折叠。
  static const double userCollapse = 120;
}

abstract final class TimelineRadius {
  static const double small = 6;
  static const double block = 8;
  static const double panel = 12;
  static const double card = 12;
  static const double sheet = 22;
  static const double full = 999;
}

abstract final class TimelineIcon {
  /// 工具行、折叠头的图标槽。
  static const double row = 15;
  static const double meta = 14;
  static const double control = 16;
  static const double badge = 12;
}

abstract final class TimelineControl {
  static const double sm = 24;
  static const double md = 28;
  static const double lg = 32;
  static const double touch = 44;
  static const double touchAndroid = 48;
}

/// 手机端的点按高度：iOS 44，Android 48。
double timelineTouchHeight(BuildContext context) =>
    Theme.of(context).platform == TargetPlatform.android
    ? TimelineControl.touchAndroid
    : TimelineControl.touch;
