import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';

/// 手机端输入框的间距、圆角、描边、控件尺寸、排版与表面样式 token。
/// 视觉基线对齐桌面端 `packages/ui-primitives/src/styles/{composer-input,chips,tokens}.css`，
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

  /// 选择器文字宽度上限：顶部项目条 260（桌面 `.draft-project`），底栏胶囊 200。
  static const double headerChipMaxWidth = 260;
  static const double toolbarChipMaxWidth = 200;

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

  /// 底栏控件用胶囊圆角（`--r-full`），顶部项目条用小圆角（`--r-sm`）。
  static const double chip = TimelineRadius.full;
  static const double headerChip = TimelineRadius.small;
}

abstract final class ComposerBorder {
  /// 抬起卡片 1px 细边；浅灰外框 0.5px `--hair` 细边。
  static const double card = TimelineBorder.regular;
  static const double frame = TimelineBorder.hair;
}

abstract final class ComposerControl {
  /// 圆形发送/停止按钮视觉直径（32px）与图标尺寸（箭头 16px、方块 12px）。
  static const double actionDiameter = TimelineControl.lg;
  static const double sendIcon = TimelineIcon.control;
  static const double stopIcon = TimelineIcon.btn;

  /// 选择器胶囊视觉高度与图标尺寸。
  static const double chipVisualHeight = TimelineControl.md;
  static const double chipIcon = TimelineIcon.meta;
  static const double chipCaret = TimelineIcon.btn;
  static const double chipTextPadding = TimelineSpace.x4;

  /// 多行输入行数范围。
  static const int minLines = 1;
  static const int maxLines = 5;

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

  /// 新会话问候标题字样与显示高度阈值。
  static const double heroFontSize = 26;
  static const double heroHeight = 1.45;
  static const double heroMinViewportHeight = 320;
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

  static ({
    Color background,
    Color field,
    Color surfaceRaised,
    Color surfaceSunken,
    Color foreground,
    Color secondaryText,
    Color divider,
    Color border,
    Color strongBorder,
    Color selected,
    Color selectedOnSurface,
    Color muted,
    Color faint,
    Color attention,
    Color attentionTint,
  })
  palette(Brightness brightness) {
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    return (
      background: colors.background,
      field: colors.field,
      surfaceRaised: colors.surfaceRaised,
      surfaceSunken: colors.surfaceSunken,
      foreground: colors.foreground,
      secondaryText: colors.secondaryText,
      divider: colors.divider,
      border: colors.border,
      strongBorder: colors.strongBorder,
      selected: colors.selected,
      selectedOnSurface: colors.selectedOnSurface,
      muted: colors.muted,
      faint: colors.faint,
      attention: colors.attention,
      attentionTint: colors.attentionTint,
    );
  }

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
}
