import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'composer_tokens.dart';

/// 手机端统一的输入框卡片，与桌面端 `expanded` 两排结构对齐：
/// - 传入 `header` 时用浅灰圆角外框（`composer-frame`）包裹顶部条与抬起卡片；
/// - 卡片内从上到下为：可选状态/错误提示条、全宽多行输入区、底部固定工具栏；
/// - 监听卡片内部焦点变化，聚焦时边框加深一档。
class MobileComposerCard extends StatefulWidget {
  const MobileComposerCard({
    super.key,
    required this.controller,
    required this.hintText,
    required this.actions,
    this.inputKey,
    this.focusNode,
    this.header,
    this.banners = const [],
    this.leading,
    this.trailing,
    this.offline = false,
    this.readOnly = false,
    this.onChanged,
    this.outerPadding = ComposerSpace.shell,
  });

  static const frameKey = ValueKey('mobile-composer-frame');
  static const cardKey = ValueKey('mobile-composer-card');

  final TextEditingController controller;
  final String hintText;
  final List<Widget> actions;
  final Key? inputKey;
  final FocusNode? focusNode;
  final Widget? header;
  final List<Widget> banners;
  final Widget? leading;
  final Widget? trailing;
  final bool offline;
  final bool readOnly;
  final ValueChanged<String>? onChanged;
  final EdgeInsetsGeometry outerPadding;

  @override
  State<MobileComposerCard> createState() => _MobileComposerCardState();
}

class _MobileComposerCardState extends State<MobileComposerCard> {
  bool _focused = false;

  void _handleFocusChange(bool focused) {
    if (_focused != focused) {
      setState(() => _focused = focused);
    }
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final hasBanners = widget.banners.isNotEmpty;

    final card = Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onFocusChange: _handleFocusChange,
      child: AnimatedContainer(
        key: MobileComposerCard.cardKey,
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : TimelineMotion.med,
        curve: TimelineMotion.ease,
        decoration: ComposerSurface.card(
          brightness,
          focused: _focused,
          offline: widget.offline,
        ),
        child: Material(
          type: MaterialType.transparency,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (hasBanners)
                Padding(
                  padding: ComposerSpace.bannerPadding,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    spacing: ComposerSpace.bannerGap,
                    children: widget.banners,
                  ),
                ),
              Padding(
                padding: hasBanners
                    ? ComposerSpace.inputPaddingWithBanners
                    : ComposerSpace.inputPadding,
                child: TextField(
                  key: widget.inputKey,
                  controller: widget.controller,
                  focusNode: widget.focusNode,
                  onChanged: widget.onChanged,
                  readOnly: widget.readOnly,
                  minLines: ComposerControl.minLines,
                  maxLines: ComposerControl.maxLines,
                  keyboardType: TextInputType.multiline,
                  textInputAction: TextInputAction.newline,
                  style: ComposerType.input,
                  decoration: InputDecoration(
                    hintText: widget.hintText,
                    hintStyle: ComposerType.input.copyWith(color: colors.faint),
                    isDense: true,
                    contentPadding: EdgeInsets.zero,
                    border: InputBorder.none,
                  ),
                ),
              ),
              Padding(
                padding: ComposerSpace.toolbarPadding(
                  context,
                  hasLeading: widget.leading != null,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    ?widget.leading,
                    if (widget.trailing case final trailing?)
                      Expanded(
                        child: Align(
                          alignment: AlignmentDirectional.centerEnd,
                          child: SingleChildScrollView(
                            scrollDirection: Axis.horizontal,
                            child: trailing,
                          ),
                        ),
                      )
                    else
                      const Spacer(),
                    if (widget.actions.isNotEmpty) ...[
                      const SizedBox(width: ComposerSpace.toolbarActionGap),
                      for (var i = 0; i < widget.actions.length; i++) ...[
                        if (i > 0)
                          const SizedBox(width: ComposerSpace.toolbarGap),
                        widget.actions[i],
                      ],
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );

    final content = widget.header == null
        ? card
        : DecoratedBox(
            key: MobileComposerCard.frameKey,
            decoration: ComposerSurface.frame(brightness),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Material(
                  type: MaterialType.transparency,
                  child: Padding(
                    padding: ComposerSpace.frameBarPadding,
                    child: Row(children: [Flexible(child: widget.header!)]),
                  ),
                ),
                card,
              ],
            ),
          );

    return Padding(padding: widget.outerPadding, child: content);
  }
}

/// 圆形发送/停止动作按钮：启用态前景色底+背景色图标，禁用态灰底+浅色图标，
/// 触区严格满足平台最小点按尺寸（iOS >= 44px、Android >= 48px）。
class MobileComposerActionButton extends StatelessWidget {
  const MobileComposerActionButton({
    super.key,
    required this.tooltip,
    required this.glyph,
    required this.onPressed,
    this.offline = false,
  });

  final String tooltip;
  final WorkspaceGlyph glyph;
  final VoidCallback? onPressed;
  final bool offline;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final enabled = onPressed != null;
    final iconSize = glyph == WorkspaceGlyph.stop
        ? ComposerControl.stopIcon
        : ComposerControl.sendIcon;

    return SizedBox.square(
      dimension: timelineTouchHeight(context),
      child: IconButton(
        onPressed: onPressed,
        tooltip: tooltip,
        padding: EdgeInsets.zero,
        icon: DecoratedBox(
          decoration: BoxDecoration(
            color: ComposerSurface.actionFill(
              brightness,
              enabled: enabled,
              offline: offline,
            ),
            shape: BoxShape.circle,
          ),
          child: SizedBox.square(
            dimension: ComposerControl.actionDiameter,
            child: Center(
              child: IconTheme(
                data: IconThemeData(
                  color: ComposerSurface.actionIcon(
                    brightness,
                    enabled: enabled,
                  ),
                ),
                child: WorkspaceIcon(glyph, size: iconSize),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum MobileComposerChipVariant { header, toolbar }

/// 输入框顶部项目条与底栏共用的紧凑选择器按钮（无边框透明底，保持 >= 44/48px 触区）。
class MobileComposerChip extends StatelessWidget {
  const MobileComposerChip({
    super.key,
    required this.label,
    required this.tooltip,
    this.icon,
    this.onTap,
    this.variant = MobileComposerChipVariant.toolbar,
    this.warning = false,
  });

  final WorkspaceGlyph? icon;
  final String label;
  final String tooltip;
  final VoidCallback? onTap;
  final MobileComposerChipVariant variant;
  final bool warning;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final isHeader = variant == MobileComposerChipVariant.header;
    final visualHeight = ComposerControl.chipHeight(context);
    final touchHeight = math.max(visualHeight, timelineTouchHeight(context));
    final enabled = onTap != null;
    final foreground = !enabled
        ? colors.faint
        : warning
        ? colors.attention
        : colors.secondaryText;
    final iconColor = !enabled
        ? colors.faint
        : warning
        ? colors.attention
        : colors.muted;
    final caretColor = warning && enabled ? colors.attention : colors.faint;
    final radius = BorderRadius.circular(
      isHeader ? ComposerRadius.headerChip : ComposerRadius.chip,
    );

    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        enabled: enabled,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minWidth: touchHeight,
              minHeight: touchHeight,
            ),
            child: Align(
              widthFactor: 1,
              child: Container(
                height: visualHeight,
                constraints: BoxConstraints(
                  maxWidth: isHeader
                      ? ComposerSpace.headerChipMaxWidth
                      : ComposerSpace.toolbarChipMaxWidth,
                ),
                padding: EdgeInsets.symmetric(
                  horizontal: isHeader
                      ? ComposerSpace.chipHeaderHorizontal
                      : ComposerSpace.chipToolbarHorizontal,
                ),
                decoration: BoxDecoration(
                  color: warning && enabled
                      ? colors.attentionTint
                      : Colors.transparent,
                  borderRadius: radius,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (icon case final icon?) ...[
                      IconTheme(
                        data: IconThemeData(color: iconColor),
                        child: WorkspaceIcon(
                          icon,
                          size: ComposerControl.chipIcon,
                        ),
                      ),
                      const SizedBox(width: ComposerSpace.chipGap),
                    ],
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ComposerType.chip(foreground),
                      ),
                    ),
                    const SizedBox(width: ComposerSpace.chipGap),
                    IconTheme(
                      data: IconThemeData(color: caretColor),
                      child: const WorkspaceIcon(
                        WorkspaceGlyph.chevronDown,
                        size: ComposerControl.chipCaret,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
