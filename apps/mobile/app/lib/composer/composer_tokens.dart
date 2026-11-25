import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';

/// 手机端输入框的间距、圆角、描边、控件尺寸、排版与表面样式 token。
/// 视觉基线对齐桌面端 `packages/ui-primitives/src/styles/{composer-input,composer,composer-plan,chips,indicators,tokens}.css`，
/// 触区复用 `timelineTouchHeight(context)`，保证 iOS >= 44px、Android >= 48px。
abstract final class ComposerSpace {
  /// 输入框卡片外层留白（12 / 6 / 12 / 8）。
  static const EdgeInsets shell = EdgeInsets.fromLTRB(
    TimelineSpace.x6,
    TimelineSpace.x3,
    TimelineSpace.x6,
    TimelineSpace.x4,
  );

  /// 抬起卡片基础内边距（对齐桌面 `.composer` 的 `--space-4` = 8px）。
  static const double cardInset = TimelineSpace.x4;

  /// 正文输入区在卡片内的内边距（无顶部提示条时）。
  static const EdgeInsets inputPadding = EdgeInsets.fromLTRB(
    TimelineSpace.x7,
    TimelineSpace.x6,
    TimelineSpace.x7,
    TimelineSpace.x2,
  );

  /// 存在顶部状态/提示条时，缩小正文上方内边距避免卡片过高。
  static const EdgeInsets inputPaddingWithBanners = EdgeInsets.fromLTRB(
    TimelineSpace.x7,
    TimelineSpace.x3,
    TimelineSpace.x7,
    TimelineSpace.x2,
  );

  /// 卡片顶部状态/提示条容器内边距与条间间隔。
  static const EdgeInsets bannerPadding = EdgeInsets.fromLTRB(
    TimelineSpace.x7,
    TimelineSpace.x4,
    TimelineSpace.x7,
    0,
  );
  static const double bannerGap = TimelineSpace.x2;

  /// 浅灰外框顶部条的水平内边距（对齐桌面 `.composer-frame-bar` 的 `--space-3`）。
  static const EdgeInsets frameBarPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x3,
  );

  /// 底栏控件间距与动作按钮前间隔（对齐桌面 `--space-1` / `--space-2`）。
  static const double toolbarGap = TimelineSpace.x1;
  static const double toolbarActionGap = TimelineSpace.x2;

  /// 选择器胶囊内衬与图文间距（对齐桌面 `.chip-btn`）。
  static const double chipHeaderHorizontal = TimelineSpace.x4;
  static const double chipToolbarHorizontal = TimelineSpace.x3;
  static const double chipGap = TimelineSpace.x2;
  static const double modelChipGap = TimelineSpace.x3;
  static const double modelChipBadgePadding = TimelineSpace.x1;

  /// 选择器文字宽度上限：顶部项目条 260（桌面 `.draft-project`），底栏胶囊 200。
  static const double headerChipMaxWidth = 260;
  static const double toolbarChipMaxWidth = 200;
  static const double modelChipMaxWidth = 208;

  /// 模型底部弹层通用内边距与间距。
  static const EdgeInsets sheetHandlePadding = EdgeInsets.only(
    top: TimelineSpace.x4,
    bottom: TimelineSpace.x2,
  );
  static const EdgeInsetsDirectional sheetHeaderPadding =
      EdgeInsetsDirectional.fromSTEB(
        TimelineSpace.x7,
        0,
        TimelineSpace.x2,
        0,
      );
  static const EdgeInsets railPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x6,
    vertical: TimelineSpace.x2,
  );
  static const double railGap = TimelineSpace.x2;
  static const EdgeInsets railTabPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x5,
    vertical: TimelineSpace.x3,
  );
  static const double railTabGap = TimelineSpace.x3;
  static const EdgeInsets railSeparatorMargin = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x2,
  );
  static const EdgeInsets searchPadding = EdgeInsets.fromLTRB(
    TimelineSpace.x6,
    TimelineSpace.x3,
    TimelineSpace.x6,
    TimelineSpace.x3,
  );
  static const EdgeInsets searchFieldPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x5,
    vertical: TimelineSpace.x3,
  );
  static const double searchGap = TimelineSpace.x4;
  static const EdgeInsets listPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x4,
    vertical: TimelineSpace.x2,
  );
  static const EdgeInsetsDirectional modelRowPadding =
      EdgeInsetsDirectional.fromSTEB(
        TimelineSpace.x5,
        TimelineSpace.x3,
        TimelineSpace.x2,
        TimelineSpace.x3,
      );
  static const double modelRowGap = TimelineSpace.x2;
  static const double modelRowTitleGap = TimelineSpace.x2;
  static const EdgeInsets emptyStatePadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x8,
    vertical: TimelineSpace.x9,
  );
  static const double emptyStateGap = TimelineSpace.x4;
  static const EdgeInsets lockedBannerPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x7,
    vertical: TimelineSpace.x4,
  );
  static const double lockedBannerGap = TimelineSpace.x4;
  static const EdgeInsets footerPadding = EdgeInsets.fromLTRB(
    TimelineSpace.x6,
    TimelineSpace.x3,
    TimelineSpace.x6,
    TimelineSpace.x4,
  );
  static const double footerRowGap = TimelineSpace.x2;
  static const double footerControlGap = TimelineSpace.x2;
  static const double effortRowGap = TimelineSpace.x4;
  static const EdgeInsets planTogglePadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x4,
  );
  static const EdgeInsets permissionButtonPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x4,
  );
  static const EdgeInsets permissionRowPadding = EdgeInsets.symmetric(
    vertical: TimelineSpace.x4,
  );
  static const double permissionRowGap = TimelineSpace.x5;
  static const double permissionTextGap = TimelineSpace.x1;

  /// 上下文占用详情弹层间距。
  static const double contextDetailGap = TimelineSpace.x5;
  static const double contextDetailRowGap = TimelineSpace.x3;
  static const EdgeInsets contextCardPadding = EdgeInsets.all(TimelineSpace.x6);

  /// 确认弹窗间距。
  static const double dialogGap = TimelineSpace.x5;
  static const double dialogActionGap = TimelineSpace.x4;

  /// 实时联想面板的外边距、内边距、分组标题、条目与标签内边距。
  static const EdgeInsets suggestionPanelMargin = EdgeInsets.fromLTRB(
    TimelineSpace.x6,
    TimelineSpace.x2,
    TimelineSpace.x6,
    TimelineSpace.x1,
  );
  static const EdgeInsets suggestionPanelPadding = EdgeInsets.all(
    TimelineSpace.x3,
  );
  static const EdgeInsetsDirectional suggestionHeaderPadding =
      EdgeInsetsDirectional.fromSTEB(
        TimelineSpace.x4,
        0,
        TimelineSpace.x1,
        0,
      );
  static const double suggestionHeaderGap = TimelineSpace.x3;
  static const EdgeInsets suggestionGroupPadding = EdgeInsets.fromLTRB(
    TimelineSpace.x4,
    TimelineSpace.x3,
    TimelineSpace.x4,
    TimelineSpace.x2,
  );
  static const EdgeInsets suggestionRowPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x4,
    vertical: TimelineSpace.x3,
  );
  static const double suggestionRowGap = TimelineSpace.x4;
  static const double suggestionTitleGap = TimelineSpace.x3;
  static const double suggestionSubtitleGap = TimelineSpace.x1;
  static const EdgeInsets suggestionTagPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x2,
    vertical: TimelineSpace.x1,
  );
  static const EdgeInsets suggestionEmptyPadding = EdgeInsets.symmetric(
    horizontal: TimelineSpace.x6,
    vertical: TimelineSpace.x7,
  );

  /// `+` 插入菜单项间距。
  static const double attachOptionGap = TimelineSpace.x5;
  static const EdgeInsets attachOptionPadding = EdgeInsets.symmetric(
    vertical: TimelineSpace.x4,
  );

  /// 底栏外衬：抵消圆形动作按钮透明触区留白，使视觉边缘贴齐 `cardInset`（8px）。
  static EdgeInsetsDirectional toolbarPadding(
    BuildContext context, {
    required bool hasLeading,
  }) {
    final edge = math.max(
      0.0,
      cardInset - ComposerControl.actionOverhang(context),
    );
    return EdgeInsetsDirectional.fromSTEB(
      hasLeading ? edge : cardInset,
      0,
      edge,
      edge,
    );
  }
}

abstract final class ComposerRadius {
  /// 桌面 `--r-composer`: 20px。
  static const double card = 20;
  static const double frame = card;

  /// 弹层顶部圆角（对齐 `mobile_sheet.dart` / `TimelineRadius.sheet`）。
  static const double sheet = TimelineRadius.sheet;
  static const double sheetHandle = 3;

  /// 底栏控件用胶囊圆角（`--r-full`），顶部项目条用小圆角（`--r-sm`）。
  static const double chip = TimelineRadius.full;
  static const double headerChip = TimelineRadius.small;
  static const double chipBadge = TimelineRadius.xs;
  static const double block = TimelineRadius.block;
  static const double panel = TimelineRadius.panel;
  static const double full = TimelineRadius.full;

  /// 实时联想面板外框（对齐桌面 `.menu-popup`: `--r-xl` 14px）、条目与角标圆角。
  static const double suggestionPanel = 14;
  static const double suggestionRow = TimelineRadius.block;
  static const double suggestionTag = TimelineRadius.small;

  /// Agent 缩写头像圆角占比（对齐桌面 `.entity-avatar`: 28%）。
  static const double avatarRatio = 0.28;
}

abstract final class ComposerBorder {
  /// 抬起卡片 1px 细边；浅灰外框与内部分隔线 0.5px `--hair` 细边。
  static const double card = TimelineBorder.regular;
  static const double frame = TimelineBorder.hair;
  static const double hairline = TimelineBorder.hair;
  static const double regular = TimelineBorder.regular;
  static const double indicator = 1.5;
  static const double meterStroke = 2;
  static const double effortDefaultRing = 1.5;
}

abstract final class ComposerControl {
  /// 圆形发送/停止按钮视觉直径（32px）与图标尺寸（箭头 16px、方块 12px）。
  static const double actionDiameter = TimelineControl.lg;
  static const double sendIcon = TimelineIcon.control;
  static const double stopIcon = TimelineIcon.btn;

  /// 工具栏左下角 `+` 圆形插入按钮（视觉圆 32px，触区 >= 44/48px）。
  static const double attachDiameter = TimelineControl.lg;
  static const double attachIcon = TimelineIcon.control;
  static const double attachOptionIcon = TimelineIcon.alert;
  static const double attachOptionMinHeight = 54;

  /// 实时联想面板尺寸约束（窄屏与键盘弹出时不溢出、不遮挡输入区）。
  static const double suggestionMaxHeight = 256;
  static const double suggestionMinHeight = 112;
  static const double suggestionMaxHeightFactor = 0.34;
  static const double suggestionIcon = TimelineIcon.meta;
  static const double suggestionCloseIcon = TimelineIcon.control;
  static const double suggestionSpinnerSize = TimelineIcon.meta;
  static const double suggestionSpinnerStroke = 1.5;

  /// 选择器胶囊视觉高度与图标尺寸。
  static const double chipVisualHeight = TimelineControl.md;
  static const double chipIcon = TimelineIcon.meta;
  static const double chipCaret = TimelineIcon.btn;
  static const double chipTextPadding = TimelineSpace.x4;
  static const double modelChipSwitchIcon = TimelineIcon.badge;
  static const double modelChipModeIcon = TimelineIcon.badge;

  /// Agent 图标尺寸（对齐桌面 `--agent-icon-*`）。
  static const double agentIconSm = TimelineIcon.meta;
  static const double agentIconMd = TimelineIcon.control;
  static const double agentIconLg = TimelineIcon.alert;
  static const double agentAccentDot = 7;
  static const double agentAccentOffset = -1;
  static const double agentBadgeSize = 11;
  static const double agentBadgeOffset = -3;
  static const double agentBadgePadding = TimelineSpace.x1;
  static const double agentBadgeFontSize = 7;
  static const double agentAvatarFontRatio = 0.42;

  /// 上下文占用圆环（对齐桌面 `context-meter.tsx`: viewBox 16、r=6、stroke=2）。
  static const double contextMeterCanvas = TimelineIcon.control;
  static const double contextMeterRadius = 6;
  static const double contextProgressBarHeight = 6;

  /// 模型底部弹层尺寸。
  static const double sheetHandleWidth = 36;
  static const double sheetHandleHeight = 5;
  static const double sheetCloseIcon = 21;
  static const double pickerMaxHeightFactor = 0.85;
  static const double pickerMinListHeight = 140;
  static const double pickerRailHeight = 36;
  static const double pickerRailSepWidth = 1;
  static const double pickerRailSepHeight = 20;
  static const double pickerCurrentDot = 7;
  static const double pickerSearchIcon = TimelineIcon.control;
  static const double pickerRowMinHeight = 52;
  static const double pickerRowFastIcon = 12;
  static const double pickerRowCheckIcon = TimelineIcon.meta;
  static const double pickerRowStarIcon = TimelineIcon.control;
  static const double pickerLockIcon = TimelineIcon.meta;
  static const double pickerSpinnerSize = 18;
  static const double pickerSpinnerStroke = 2;

  /// 底部运行参数栏控件尺寸。
  static const double switchVisualSize = TimelineControl.lg;
  static const double switchIcon = TimelineIcon.control;
  static const double effortTrackHeight = 14;
  static const double effortThumbDiameter = 18;
  static const double effortDotDiameter = 4;
  static const double effortDefaultRingDiameter = 6;
  static const double effortValueMinWidth = 36;
  static const double planToggleVisualHeight = TimelineControl.lg;
  static const double planToggleIcon = TimelineIcon.meta;
  static const double permissionButtonVisualHeight = TimelineControl.lg;
  static const double permissionButtonIcon = TimelineIcon.meta;
  static const double permissionButtonMaxWidth = 148;
  static const double permissionRowMinHeight = 54;
  static const double permissionRowIcon = 18;

  /// 禁用态透明度（对齐桌面 `0.5`）。
  static const double disabledOpacity = 0.5;
  static const double lockedRowOpacity = 0.6;
  static const double effortOnDotOpacity = 0.6;

  /// 多行输入行数范围与贴合字高的光标基准高度（避免 1.6 倍行高把 iOS 光标拉得比文字高一截）。
  static const int minLines = 1;
  static const int maxLines = 5;
  static const double cursorHeight = 19;

  /// 圆形按钮透明触区每侧超出视觉圆的像素量。
  static double actionOverhang(BuildContext context) =>
      math.max(0.0, (timelineTouchHeight(context) - actionDiameter) / 2);

  /// 随系统字号缩放计算胶囊视觉高度，大字号时不裁切。
  static double chipHeight(BuildContext context) => math.max(
    chipVisualHeight,
    MediaQuery.textScalerOf(context).scale(TimelineType.meta) *
            TimelineType.metaHeight +
        chipTextPadding,
  );
}

abstract final class ComposerType {
  /// 输入框正文（对齐桌面 `.composer .tiptap`: `--fs-content` 15px / line-height 1.6）。
  static const TextStyle input = TextStyle(
    fontSize: TimelineType.content,
    height: TimelineType.contentHeight,
  );

  /// 选择器胶囊文字（对齐桌面 `.chip-btn`: `--fs-md` 13px / `--lh-md` 18px）。
  static TextStyle chip(Color color) => TimelineType.metaStyle(color);

  /// 综合模型胶囊里的模型名与思考深度/计划短标记。
  static TextStyle modelChipName(Color color) =>
      TimelineType.metaStyle(color, weight: FontWeight.w500);
  static TextStyle modelChipMeta(Color color) => TimelineType.smallStyle(color);

  /// 底部弹层标题。
  static TextStyle sheetTitle(Color color, TargetPlatform platform) =>
      TextStyle(
        fontSize: TimelineType.heading2,
        fontWeight: FontWeight.w500,
        height: 1.45,
        letterSpacing: platform == TargetPlatform.iOS ? -0.24 : 0,
        color: color,
        leadingDistribution: TextLeadingDistribution.even,
        locale: const Locale('zh', 'CN'),
      );

  /// 实例栏页签文字。
  static TextStyle railLabel(Color color, {bool selected = false}) =>
      TimelineType.metaStyle(
        color,
        weight: selected ? FontWeight.w500 : FontWeight.w400,
      );

  /// 模型搜索输入框文字。
  static TextStyle searchInput(Color color) => TextStyle(
    fontSize: TimelineType.content,
    height: TimelineType.metaHeight,
    color: color,
  );

  /// 模型列表主/副标题。
  static TextStyle modelRowTitle(Color color, {bool current = false}) =>
      TimelineType.contentStyle(
        color,
        weight: current ? FontWeight.w500 : FontWeight.w400,
        height: TimelineType.metaHeight,
      );
  static TextStyle modelRowSubtitle(Color color) =>
      TimelineType.smallStyle(color);

  /// 锁定提示与错误提示。
  static TextStyle notice(Color color) => TimelineType.smallStyle(color);

  /// 底栏参数标签与数值。
  static TextStyle footerLabel(Color color) => TimelineType.smallStyle(color);
  static TextStyle footerValue(Color color, {bool emphasized = false}) =>
      TimelineType.smallStyle(
        color,
        weight: emphasized ? FontWeight.w500 : FontWeight.w400,
      );

  /// 权限列表主/副标题。
  static TextStyle permissionTitle(Color color, {bool emphasized = false}) =>
      TimelineType.contentStyle(
        color,
        weight: emphasized ? FontWeight.w500 : FontWeight.w400,
        height: TimelineType.noticeHeight,
      );
  static TextStyle permissionDescription(Color color) =>
      TimelineType.smallStyle(color);

  /// 上下文占用详情排版。
  static TextStyle contextHeadline(Color color) => TextStyle(
    fontSize: TimelineType.heading3,
    height: TimelineType.headingHeight,
    fontWeight: FontWeight.w500,
    color: color,
    fontFeatures: TimelineType.tabular,
  );
  static TextStyle contextDetail(Color color) => TextStyle(
    fontSize: TimelineType.meta,
    height: TimelineType.noticeHeight,
    color: color,
    fontFeatures: TimelineType.tabular,
  );

  /// 新会话问候标题字样与显示高度阈值。
  static const double heroFontSize = 26;
  static const double heroHeight = 1.45;
  static const double heroMinViewportHeight = 320;

  /// 实时联想面板与 `+` 插入菜单排版。
  static TextStyle suggestionTitle(Color color) =>
      TimelineType.smallStyle(color, weight: FontWeight.w500);
  static TextStyle suggestionGroup(Color color) =>
      TimelineType.smallStyle(color);
  static TextStyle suggestionLabel(Color color) =>
      TimelineType.metaStyle(color, weight: FontWeight.w500);
  static TextStyle suggestionHint(Color color) => TextStyle(
    fontFamily: 'monospace',
    fontFamilyFallback: TimelineType.monoFallback,
    fontSize: TimelineType.micro,
    height: TimelineType.microHeight,
    color: color,
  );
  static TextStyle suggestionDetail(Color color) =>
      TimelineType.smallStyle(color);
  static TextStyle suggestionTag(Color color) => TimelineType.microStyle(color);
  static TextStyle attachOptionTitle(Color color, TargetPlatform platform) =>
      TextStyle(
        fontSize: TimelineType.content + 1,
        height: 1.45,
        letterSpacing: platform == TargetPlatform.iOS ? -0.24 : 0,
        color: color,
        leadingDistribution: TextLeadingDistribution.even,
        locale: const Locale('zh', 'CN'),
      );
  static TextStyle attachOptionMeta(Color color) =>
      TimelineType.metaMonoStyle(color);
}

abstract final class ComposerSurface {
  /// 桌面 `--shadow-composer`。
  static const List<BoxShadow> lightShadow = [
    BoxShadow(color: Color(0x0A18181B), offset: Offset(0, 1), blurRadius: 2),
    BoxShadow(color: Color(0x0D18181B), offset: Offset(0, 6), blurRadius: 20),
  ];
  static const List<BoxShadow> darkShadow = [
    BoxShadow(color: Color(0x4D000000), offset: Offset(0, 8), blurRadius: 24),
  ];
  static const List<BoxShadow> knobShadow = [
    BoxShadow(color: Color(0x0F000000), spreadRadius: 0.5),
    BoxShadow(color: Color(0x33000000), offset: Offset(0, 1), blurRadius: 3),
  ];

  /// 桌面 `--favorite` 与 `--brand-claude`。
  static const Color favorite = Color(0xFFE5A00D);
  static const Color brandClaude = Color(0xFFD97757);
  static const Color brandAntigravityBlue = Color(0xFF4285F4);
  static const Color brandAntigravityRed = Color(0xFFEA4335);
  static const Color brandAntigravityYellow = Color(0xFFFBBC05);
  static const Color brandAntigravityGreen = Color(0xFF34A853);

  static ({
    Color background,
    Color surface,
    Color popover,
    Color panel,
    Color field,
    Color surfaceRaised,
    Color surfaceSunken,
    Color switchTrack,
    Color switchThumb,
    Color foreground,
    Color secondaryText,
    Color onPrimary,
    Color divider,
    Color border,
    Color strongBorder,
    Color inputBackground,
    Color inputBorder,
    Color hover,
    Color selected,
    Color selectedOnSurface,
    Color muted,
    Color faint,
    Color attention,
    Color attentionTint,
    Color attentionMark,
    Color error,
    Color errorTint,
    Color onError,
    Color readyMark,
    Color running,
    Color scrim,
  })
  palette(Brightness brightness) {
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    return (
      background: colors.background,
      surface: colors.surface,
      popover: colors.popover,
      panel: colors.panel,
      field: colors.field,
      surfaceRaised: colors.surfaceRaised,
      surfaceSunken: colors.surfaceSunken,
      switchTrack: colors.switchTrack,
      switchThumb: colors.switchThumb,
      foreground: colors.foreground,
      secondaryText: colors.secondaryText,
      onPrimary: colors.onPrimary,
      divider: colors.divider,
      border: colors.border,
      strongBorder: colors.strongBorder,
      inputBackground: colors.inputBackground,
      inputBorder: colors.inputBorder,
      hover: colors.hover,
      selected: colors.selected,
      selectedOnSurface: colors.selectedOnSurface,
      muted: colors.muted,
      faint: colors.faint,
      attention: colors.attention,
      attentionTint: colors.attentionTint,
      attentionMark: colors.attentionMark,
      error: colors.error,
      errorTint: colors.errorTint,
      onError: colors.onError,
      readyMark: colors.readyMark,
      running: colors.running,
      scrim: colors.scrim,
    );
  }

  /// 强调色（用于思考深度滑块填充、Ultracode 激活态、当前模型勾选、非默认权限徽标）。
  static Color accent(Brightness brightness) => palette(brightness).running;

  static Color accentSoft(Brightness brightness) => accent(
    brightness,
  ).withValues(alpha: brightness == Brightness.dark ? 0.16 : 0.10);

  static Color accentSoftStrong(Brightness brightness) => accent(
    brightness,
  ).withValues(alpha: brightness == Brightness.dark ? 0.24 : 0.15);

  static Color accentText(Brightness brightness) => brightness == Brightness.dark
      ? const Color(0xFF8FB8F8)
      : const Color(0xFF1A62C6);

  /// 上下文占用圆环三档颜色：常规 muted、>=80% 偏高 attention、>=95% 满载 danger。
  static Color contextRingTrack(Brightness brightness) =>
      palette(brightness).strongBorder;
  static Color contextRingOk(Brightness brightness) =>
      palette(brightness).muted;
  static Color contextRingHigh(Brightness brightness) =>
      palette(brightness).attentionMark;
  static Color contextRingFull(Brightness brightness) =>
      palette(brightness).error;

  static Color cardFill(Brightness brightness, {bool offline = false}) {
    final colors = palette(brightness);
    return offline
        ? Color.alphaBlend(colors.surfaceSunken, colors.background)
        : colors.surfaceRaised;
  }

  static Color cardBorder(Brightness brightness, {bool focused = false}) {
    final colors = palette(brightness);
    return focused ? colors.strongBorder : colors.border;
  }

  static BoxDecoration card(
    Brightness brightness, {
    bool focused = false,
    bool offline = false,
  }) => BoxDecoration(
    color: cardFill(brightness, offline: offline),
    borderRadius: BorderRadius.circular(ComposerRadius.card),
    border: Border.all(
      color: cardBorder(brightness, focused: focused),
      width: ComposerBorder.card,
    ),
    boxShadow: brightness == Brightness.dark ? darkShadow : lightShadow,
  );

  static BoxDecoration frame(Brightness brightness) {
    final colors = palette(brightness);
    return BoxDecoration(
      color: colors.field,
      borderRadius: BorderRadius.circular(ComposerRadius.frame),
      border: Border.all(color: colors.divider, width: ComposerBorder.frame),
    );
  }

  static Color actionFill(
    Brightness brightness, {
    required bool enabled,
    bool offline = false,
  }) {
    final colors = palette(brightness);
    if (enabled) return colors.foreground;
    return offline
        ? Color.alphaBlend(colors.selected, cardFill(brightness, offline: true))
        : colors.selectedOnSurface;
  }

  static Color actionIcon(Brightness brightness, {required bool enabled}) {
    final colors = palette(brightness);
    return enabled ? colors.background : colors.faint;
  }

  /// 工具栏左下角 `+` 圆形插入按钮底色与图标色（对齐桌面 `.composer-attach` 灰色圆底）。
  static Color attachFill(
    Brightness brightness, {
    bool offline = false,
  }) {
    final colors = palette(brightness);
    return offline
        ? Color.alphaBlend(colors.selected, cardFill(brightness, offline: true))
        : colors.selectedOnSurface;
  }

  static Color attachIcon(
    Brightness brightness, {
    required bool enabled,
    bool active = false,
  }) {
    final colors = palette(brightness);
    if (!enabled) return colors.faint;
    return active ? colors.foreground : colors.muted;
  }

  /// 输入框中 `@文件`、`@会话`、`$` Skill 提及高亮颜色（保持同字号/字重/行高）。
  static Color mentionHighlight(Brightness brightness) =>
      accentText(brightness);

  /// 实时联想面板阴影与表面装饰。
  static List<BoxShadow> suggestionShadow(Brightness brightness) =>
      brightness == Brightness.dark ? darkShadow : lightShadow;

  static BoxDecoration suggestionPanel(Brightness brightness) {
    final colors = palette(brightness);
    return BoxDecoration(
      color: colors.popover,
      borderRadius: BorderRadius.circular(ComposerRadius.suggestionPanel),
      border: Border.all(
        color: colors.border,
        width: ComposerBorder.regular,
      ),
      boxShadow: suggestionShadow(brightness),
    );
  }

  static BoxDecoration suggestionTag(Brightness brightness) {
    final colors = palette(brightness);
    return BoxDecoration(
      borderRadius: BorderRadius.circular(ComposerRadius.suggestionTag),
      border: Border.all(
        color: colors.border,
        width: ComposerBorder.regular,
      ),
    );
  }
}
