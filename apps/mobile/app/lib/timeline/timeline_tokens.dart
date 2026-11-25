import 'package:flutter/material.dart';

/// 桌面会话时间线的尺寸、排版、圆角、阴影和动效 token。
/// 所有数值对应 `packages/ui-primitives/src/styles/{tokens,timeline,tool-row,tool-cards,markdown,code-block,approvals,file-summary}.css`。
/// 组件内不再写裸数值，只允许按移动端规范放宽外层宽度与触区。
abstract final class TimelineType {
  /// 会话正文、工具行、工作折叠头（`--cv-fs`: 15px / line-height 1.6 = 24px）。
  static const double content = 15;
  static const double contentHeight = 24 / 15;

  /// Markdown 标题字号（`--cv-fs-xl` 19、`--cv-fs-lg` 17、`--cv-fs` 15，行高 1.5）。
  static const double heading1 = 19;
  static const double heading2 = 17;
  static const double heading3 = 15;
  static const double headingHeight = 1.5;

  /// 工具行增删计数（`.diff-count`: `calc(var(--cv-fs) - 1px)` = 14px，行高 1）。
  static const double diffCount = 14;
  static const double diffCountHeight = 1.0;

  /// 次级说明、卡片标签、回复时间、loading 耗时（`--cv-fs-sm`: 13px）。
  static const double meta = 13;
  static const double metaHeight = 18 / 13;
  static const double noticeHeight = 1.5;

  /// 计数、标记、小号说明（`--fs-sm`: 12px）。
  static const double small = 12;
  static const double smallHeight = 16 / 12;

  /// 用户气泡下方操作栏与时间戳（`--fs-2xs`: 11px / 14px）。
  static const double micro = 11;
  static const double microHeight = 14 / 11;

  /// 代码、命令、内联 diff（`--cv-fs-code`: 12px，`--code-line-h`: 20px）。
  static const double code = 12;
  static const double codeLineHeight = 20;

  /// 代码块正文行高（`.code-block-body`: `line-height: 1.6`）。
  static const double codeBlockHeight = 1.6;

  /// 表格内行内代码行高。
  static const double inlineCodeHeight = 1.3;

  static const List<String> monoFallback = ['PingFang SC', 'Noto Sans SC'];
  static const List<FontFeature> tabular = [FontFeature.tabularFigures()];

  static TextStyle contentStyle(
    Color color, {
    FontWeight? weight,
    double? height,
  }) => TextStyle(
    fontSize: content,
    height: height ?? contentHeight,
    fontWeight: weight ?? FontWeight.w400,
    color: color,
  );

  static TextStyle headingStyle(double size, FontWeight weight) => TextStyle(
    fontSize: size,
    height: headingHeight,
    fontWeight: weight,
    letterSpacing: 0,
  );

  static TextStyle diffCountStyle(Color color) => TextStyle(
    fontFamily: 'monospace',
    fontFamilyFallback: monoFallback,
    fontSize: diffCount,
    height: diffCountHeight,
    color: color,
    fontFeatures: tabular,
  );

  static TextStyle metaStyle(
    Color color, {
    FontWeight? weight,
    double? height,
  }) => TextStyle(
    fontSize: meta,
    height: height ?? metaHeight,
    fontWeight: weight ?? FontWeight.w400,
    color: color,
  );

  static TextStyle metaMonoStyle(Color color) => TextStyle(
    fontFamily: 'monospace',
    fontFamilyFallback: monoFallback,
    fontSize: meta,
    height: metaHeight,
    color: color,
    fontFeatures: tabular,
  );

  static TextStyle smallStyle(Color color, {FontWeight? weight}) => TextStyle(
    fontSize: small,
    height: smallHeight,
    fontWeight: weight ?? FontWeight.w400,
    color: color,
  );

  static TextStyle microStyle(Color color) => TextStyle(
    fontSize: micro,
    height: microHeight,
    fontWeight: FontWeight.w400,
    color: color,
    fontFeatures: tabular,
  );

  static TextStyle codeStyle(Color color, {double height = codeLineHeight}) =>
      TextStyle(
        fontFamily: 'monospace',
        fontFamilyFallback: monoFallback,
        fontSize: code,
        height: height / code,
        color: color,
      );

  static TextStyle codeBlockStyle(Color color) => TextStyle(
    fontFamily: 'monospace',
    fontFamilyFallback: monoFallback,
    fontSize: code,
    height: codeBlockHeight,
    color: color,
  );
}

abstract final class TimelineSpace {
  /// 桌面 `--space-1` .. `--space-9`。
  static const double x1 = 2;
  static const double x2 = 4;
  static const double x3 = 6;
  static const double x4 = 8;
  static const double x5 = 10;
  static const double x6 = 12;
  static const double x7 = 16;
  static const double x8 = 20;
  static const double x9 = 24;

  /// 桌面 `.turn` 上内边距 56；手机每轮外层留白（gutter 16 + pad 16 = 32）。
  static const double turnTop = 56;
  static const double turnGutter = 32;
  static const double userBottomGap = 48;
  static const EdgeInsets turn = EdgeInsets.fromLTRB(x7, 0, x7, x8);
  static const EdgeInsets firstTurn = EdgeInsets.fromLTRB(x7, turnTop, x7, x8);

  /// 用户气泡内衬（`.msg-user`: `var(--space-4) var(--space-6)` = 8 / 12）。
  static const EdgeInsets bubble = EdgeInsets.symmetric(
    horizontal: x6,
    vertical: x4,
  );

  /// 卡片内衬（`.perm`: `16px`）。
  static const EdgeInsets card = EdgeInsets.all(x7);

  /// 轮内块之间 20，工作项之间 16，行内字段之间 8。
  static const double blockGap = x8;
  static const double workGap = x7;
  static const double fieldGap = x4;

  /// 子列表左导线缩进与内边距（`.summary-group-list`: `margin-left: 8; padding-left: 16`）。
  static const double guideIndent = x4;
  static const double guidePadding = x7;

  /// 独立思考正文缩进（`.reasoning-body`: `margin-left: 8; padding-left: 14`，顶部 12）。
  static const double reasoningBodyPadding = 14;
  static const double reasoningBodyTop = x6;

  /// 用户气泡宽度上限（`--cv-bubble`: 560）与折叠高度（`COLLAPSED_HEIGHT`: 120）。
  static const double bubbleMaxWidth = 560;
  static const double userCollapse = 120;
  static const double userCollapseTolerance = 1;
  static const double userFadeStop = 0.7;

  /// 计划卡收起时的渐隐起点（`.plan-card-body[data-clamped]`: 30% -> 100%）。
  static const double planFadeStop = 0.3;

  /// 提问选项输入框垂直内衬。
  static const double inputVertical = 11;
}

abstract final class TimelineRadius {
  static const double xs = 4;
  static const double small = 6;
  static const double block = 8;
  static const double panel = 12;
  static const double card = 12;
  static const double sheet = 22;
  static const double full = 999;
}

abstract final class TimelineBorder {
  /// `--hair`: 0.5px，常规 1px，引用左线 2px，内联 diff 色条 3px。
  static const double hair = 0.5;
  static const double regular = 1;
  static const double quote = 2;
  static const double diffBar = 3;
}

abstract final class TimelineIcon {
  /// `--check-icon`: 10、`--icon-btn`: 12、`--icon-sm`: 12、`--icon-md`/`--icon-cv-sm`: 14、
  /// `--icon-cv`: 15、`--icon-lg`: 16。
  static const double check = 10;
  static const double btn = 12;
  static const double badge = 12;
  static const double meta = 14;
  static const double row = 15;
  static const double control = 16;
  static const double alert = 20;

  /// 3×3 点阵整体边长 10、每点直径 2（`--dot-matrix-size` / `--dot-matrix-dot`）。
  static const double dotMatrix = 10;
  static const double dotMatrixDot = 2;
}

abstract final class TimelineControl {
  /// `--control-xs` 20 / `--control-sm` 24 / `--control-md` 28 / `--control-lg` 32 / `--bar-h` 40。
  static const double xs = 20;
  static const double sm = 24;
  static const double md = 28;
  static const double lg = 32;
  static const double bar = 40;
  static const double check = 14;
  static const double touch = 44;
  static const double touchAndroid = 48;
}

abstract final class TimelineMotion {
  /// `--t-fast` 100ms / `--t-med` 150ms / `--t-slow` 200ms / `--t-slower` 300ms / `--ease`。
  static const Duration fast = Duration(milliseconds: 100);
  static const Duration med = Duration(milliseconds: 150);
  static const Duration slow = Duration(milliseconds: 200);
  static const Duration slower = Duration(milliseconds: 300);

  /// 扫光 4s（`gradient-flow 4s linear infinite`），点阵 1.4s，复制态 1.5s，计时 1s。
  static const Duration shimmer = Duration(seconds: 4);
  static const Duration dotMatrix = Duration(milliseconds: 1400);
  static const Duration copyReset = Duration(milliseconds: 1500);
  static const Duration tick = Duration(seconds: 1);

  static const Curve ease = Cubic(0.2, 0.7, 0.2, 1);
}

abstract final class TimelineShadow {
  /// `--cv-shadow-sm`: `0 1px 2px rgb(0 0 0 / 0.05)`。
  static const List<BoxShadow> sm = [
    BoxShadow(color: Color(0x0D000000), blurRadius: 2, offset: Offset(0, 1)),
  ];

  /// `--cv-shadow-card`: `0 1px 2px rgb(0 0 0 / 0.04)`。
  static const List<BoxShadow> card = [
    BoxShadow(color: Color(0x0A000000), blurRadius: 2, offset: Offset(0, 1)),
  ];

  /// `--cv-shadow-md`: light `0.1` / dark `0.3`。
  static List<BoxShadow> md(Brightness brightness) {
    final color = brightness == Brightness.dark
        ? const Color(0x4D000000)
        : const Color(0x1A000000);
    return [
      BoxShadow(
        color: color,
        blurRadius: 6,
        spreadRadius: -1,
        offset: const Offset(0, 4),
      ),
      BoxShadow(
        color: color,
        blurRadius: 4,
        spreadRadius: -2,
        offset: const Offset(0, 2),
      ),
    ];
  }
}

abstract final class TimelineSummary {
  /// `SHOWN_FILES` = 3。
  static const int shownFiles = 3;

  /// `.summary-group-body`: `max-height: calc(16lh + 15 * 8px)` = 16 * 24 + 15 * 8 = 504。
  static const int maxLines = 16;
  static const double itemGap = TimelineSpace.x4;
  static const double maxBodyHeight =
      maxLines * (TimelineType.content * TimelineType.contentHeight) +
      (maxLines - 1) * itemGap;

  /// `.summary-group-body[data-edges]` 上下淡出 24px。
  static const double fadeEdge = TimelineSpace.x9;

  /// `useFollowBottom` 吸附底部的容差 2px。
  static const double followThreshold = 2;

  /// `.work-chev` 默认透明度 0.7。
  static const double workChevronOpacity = 0.7;
}

abstract final class TimelineToolCard {
  /// 桌面 `.tool-card`：padding 12/16、gap 12、r12、1px 边、`--cv-panel` 底。
  static const EdgeInsets padding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x7,
    vertical: TimelineSpace.x6,
  );
  static const double gap = TimelineSpace.x6;
  static const double radius = TimelineRadius.panel;

  /// 命令行、输出按 20 的行高排版（3/10 行折叠、5 行输出跟随）。
  static const double line = TimelineType.codeLineHeight;
  static const int commandLines = 3;
  static const int commandExpandedLines = 10;
  static const int outputLines = 5;
  static const double promptWidth = TimelineSpace.x4;
  static const double outputFollowThreshold = TimelineSpace.x2;

  /// 内联 diff（`.inline-diff`）：240 限高、48 行号栏、20 标记栏、14% 底色。
  static const double inlineDiffMaxHeight = 240;
  static const double inlineDiffGutterWidth = 48;
  static const double inlineDiffMarkerWidth = 20;
  static const double inlineDiffTintAlpha = 0.14;

  /// 思考（240）、计划收起（256）、审批命令（200）、审批计划（320）、工具详情（240）。
  static const double reasoningMaxHeight = 240;
  static const double reasoningFollowThreshold = TimelineSpace.x4;
  static const double reasoningPeekFade = TimelineSpace.x9;
  static const double planCollapsedHeight = 256;
  static const double approvalDetailMaxHeight = 200;
  static const double approvalPlanMaxHeight = 320;
  static const double sectionMaxHeight = 240;

  /// `.turn-error`: `color-mix(in srgb, var(--cv-removed) 10%, transparent)`。
  static const double errorTintAlpha = 0.10;

  /// `.file-summary-row`: `color-mix(in oklab, var(--bg) 50%, transparent)`。
  static const double changeRowBlendAlpha = 0.50;

  /// 审批禁用态透明度。
  static const double disabledOpacity = 0.45;
}

abstract final class TimelineMarkdown {
  /// `.md-h`: margin 24 0 16；列表 12 外边距、6 项间距、ul 缩进 20；
  /// 引用 16 外边距、12 左内衬、2px 左线；分隔线 20 外边距；图片 16 外边距、360 限高。
  static const double blockMargin = TimelineSpace.x7;
  static const double headingTop = TimelineSpace.x9;
  static const double headingBottom = TimelineSpace.x7;
  static const double listMargin = TimelineSpace.x6;
  static const double listGap = TimelineSpace.x3;
  static const double listIndent = TimelineSpace.x8;
  static const double quoteMargin = TimelineSpace.x7;
  static const double quotePadding = TimelineSpace.x6;
  static const double quoteBarWidth = TimelineBorder.quote;
  static const double hrMargin = TimelineSpace.x8;
  static const double imageMaxHeight = 360;
  static const double checkboxTopOffset = 5;

  /// `.md-table th/td`: min-width 64、max-width 28rem (448)。
  static const double tableCellMinWidth = 64;
  static const double tableCellMaxWidth = 448;

  /// `.code-block-head`: `padding: 8px 8px 0 12px`；`.code-block-body`: `padding: 4px 12px 12px`。
  static const EdgeInsetsDirectional codeHeadPadding =
      EdgeInsetsDirectional.fromSTEB(
        TimelineSpace.x6,
        TimelineSpace.x4,
        TimelineSpace.x4,
        0,
      );
  static const EdgeInsets codeBodyPadding = EdgeInsets.fromLTRB(
    TimelineSpace.x6,
    TimelineSpace.x2,
    TimelineSpace.x6,
    TimelineSpace.x6,
  );

  /// `.md code`: `margin: 0 2px; padding: 2px 6px`。
  static const EdgeInsets inlineCodeMargin = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x1,
  );
  static const EdgeInsets inlineCodePadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x3,
    vertical: TimelineSpace.x1,
  );

  /// 行内代码左右占位（padding 6 + margin 2 = 8），避免绘制底色压到邻近字符。
  static const double inlineCodeOuterGap = TimelineSpace.x4;

  /// 无序列表圆点直径（0.3 × 15 = 4.5）与首行垂直对齐偏移。
  static const double listBulletSize = 4.5;
  static const double listBulletTopOffset = 9.5;
  static const double rowIconTopOffset = 4.5;
  static const double rowChevronTopOffset = 6;

  /// `.msg-ai`: `letter-spacing: 0.025em`。
  static const double letterSpacingFactor = 0.025;
}

/// 桌面 `formatDuration` 的中文格式：向上/四舍五入至少 1 秒，最多展示两个单位（如「1 分 5 秒」）。
String formatTimelineDuration(Duration duration) {
  var remaining = (duration.inMilliseconds / 1000).round().clamp(1, 9999999);
  final parts = <String>[];
  for (final (size, unit) in const [
    (86400, '天'),
    (3600, '时'),
    (60, '分'),
    (1, '秒'),
  ]) {
    final value = remaining ~/ size;
    remaining %= size;
    if (value > 0) parts.add('$value $unit');
    if (parts.length == 2) break;
  }
  return parts.join(' ');
}

/// 手机端的点按高度：iOS 44，Android 48。
double timelineTouchHeight(BuildContext context) =>
    Theme.of(context).platform == TargetPlatform.android
    ? TimelineControl.touchAndroid
    : TimelineControl.touch;
