import 'package:flutter/material.dart';

import '../computers_hub.dart' show PigcodeColors;
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';

/// 管理页顶栏标题：主标题 + 可选当前所属电脑名称副标。
class ManageAppBarTitle extends StatelessWidget {
  const ManageAppBarTitle({super.key, required this.title, this.computerName});

  final String title;
  final String? computerName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final sub = computerName?.trim();
    if (sub == null || sub.isEmpty) {
      return Text(title);
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 16.5,
            fontWeight: FontWeight.w600,
            color: colors.foreground,
            height: 1.2,
          ),
        ),
        Text(
          sub,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w400,
            color: colors.muted,
            height: 1.25,
          ),
        ),
      ],
    );
  }
}

/// 分组区块头：保持 4px 间距体系，左侧标题 + 可选右侧轻量动作。
class ManageSectionHeader extends StatelessWidget {
  const ManageSectionHeader({super.key, required this.title, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: TimelineType.metaStyle(
                colors.muted,
                weight: FontWeight.w500,
              ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// 管理页统一白/深色圆角卡片容器（16px 圆角 + 细描边）。
class ManageSurfaceCard extends StatelessWidget {
  const ManageSurfaceCard({
    super.key,
    required this.children,
    this.padding,
    this.borderRadius = 16,
  });

  final List<Widget> children;
  final EdgeInsetsGeometry? padding;
  final double borderRadius;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final column = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    );
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(borderRadius),
        side: BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: padding != null
          ? Padding(padding: padding!, child: column)
          : column,
    );
  }
}

/// 填充式圆角文本输入框：彻底替代下划线 `UnderlineInputBorder`。
class ManageFilledTextField extends StatelessWidget {
  const ManageFilledTextField({
    super.key,
    this.fieldKey,
    this.controller,
    this.label,
    this.hintText,
    this.helperText,
    this.errorText,
    this.maxLines = 1,
    this.minLines,
    this.keyboardType,
    this.textInputAction,
    this.obscureText = false,
    this.enabled = true,
    this.readOnly = false,
    this.autofocus = false,
    this.style,
    this.prefixIcon,
    this.suffix,
    this.onChanged,
    this.onSubmitted,
    this.contentPadding = const EdgeInsets.symmetric(
      horizontal: 12,
      vertical: 11,
    ),
  });

  final Key? fieldKey;
  final TextEditingController? controller;
  final String? label;
  final String? hintText;
  final String? helperText;
  final String? errorText;
  final int? maxLines;
  final int? minLines;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final bool obscureText;
  final bool enabled;
  final bool readOnly;
  final bool autofocus;
  final TextStyle? style;
  final Widget? prefixIcon;
  final Widget? suffix;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final EdgeInsetsGeometry contentPadding;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final hasError = errorText != null && errorText!.trim().isNotEmpty;
    final fieldStyle =
        style ??
        TimelineType.contentStyle(colors.foreground).copyWith(height: 1.4);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null && label!.trim().isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 6),
            child: Text(
              label!,
              style: TimelineType.metaStyle(
                colors.secondaryText,
                weight: FontWeight.w500,
              ),
            ),
          ),
        ],
        Container(
          decoration: BoxDecoration(
            color: colors.field,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: hasError ? colors.error : colors.border),
          ),
          child: Row(
            crossAxisAlignment: maxLines == 1
                ? CrossAxisAlignment.center
                : CrossAxisAlignment.start,
            children: [
              if (prefixIcon != null)
                Padding(
                  padding: const EdgeInsets.only(left: 12),
                  child: IconTheme(
                    data: IconThemeData(size: 18, color: colors.muted),
                    child: prefixIcon!,
                  ),
                ),
              Expanded(
                child: TextField(
                  key: fieldKey,
                  controller: controller,
                  enabled: enabled,
                  readOnly: readOnly,
                  autofocus: autofocus,
                  obscureText: obscureText,
                  maxLines: maxLines,
                  minLines: minLines,
                  keyboardType: keyboardType,
                  textInputAction: textInputAction,
                  style: fieldStyle,
                  onChanged: onChanged,
                  onSubmitted: onSubmitted,
                  decoration: InputDecoration(
                    hintText: hintText,
                    hintStyle: TimelineType.contentStyle(
                      colors.muted,
                    ).copyWith(height: 1.4),
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    disabledBorder: InputBorder.none,
                    isDense: true,
                    contentPadding: contentPadding,
                  ),
                ),
              ),
              if (suffix != null)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: suffix!,
                ),
            ],
          ),
        ),
        if (hasError) ...[
          const SizedBox(height: 5),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            child: Text(
              errorText!,
              style: TimelineType.smallStyle(colors.error),
            ),
          ),
        ] else if (helperText != null && helperText!.trim().isNotEmpty) ...[
          const SizedBox(height: 5),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            child: Text(
              helperText!,
              style: TimelineType.smallStyle(colors.muted),
            ),
          ),
        ],
      ],
    );
  }
}

/// 设置卡内的点击选择行：左侧标题 + 可选副标，右侧当前值 + 箭头。
class ManagePickerRow extends StatelessWidget {
  const ManagePickerRow({
    super.key,
    required this.title,
    required this.value,
    this.subtitle,
    this.leading,
    this.placeholder = false,
    this.enabled = true,
    this.showChevron = true,
    this.valueColor,
    this.onTap,
  });

  final String title;
  final String value;
  final String? subtitle;
  final Widget? leading;
  final bool placeholder;
  final bool enabled;
  final bool showChevron;
  final Color? valueColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final resolvedValueColor =
        valueColor ?? (placeholder ? colors.muted : colors.secondaryText);

    return InkWell(
      onTap: enabled ? onTap : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: LayoutBuilder(
            builder: (context, constraints) => Row(
              children: [
                if (leading != null) ...[leading!, const SizedBox(width: 10)],
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: TimelineType.contentStyle(
                          enabled ? colors.foreground : colors.muted,
                          weight: FontWeight.w500,
                        ),
                      ),
                      if (subtitle != null && subtitle!.trim().isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          style: TimelineType.smallStyle(colors.muted),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: constraints.maxWidth * 0.62,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Flexible(
                        child: Text(
                          value,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.end,
                          style: TimelineType.metaStyle(resolvedValueColor),
                        ),
                      ),
                      if (showChevron) ...[
                        const SizedBox(width: 4),
                        Icon(
                          Icons.chevron_right,
                          size: 18,
                          color: colors.faint,
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 卡片内统一的布尔开关行。
class ManageSwitchRow extends StatelessWidget {
  const ManageSwitchRow({
    super.key,
    this.switchKey,
    required this.title,
    required this.value,
    required this.onChanged,
    this.subtitle,
  });

  final Key? switchKey;
  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final enabled = onChanged != null;
    return InkWell(
      onTap: enabled ? () => onChanged!(!value) : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TimelineType.contentStyle(
                        enabled ? colors.foreground : colors.muted,
                        weight: FontWeight.w500,
                      ),
                    ),
                    if (subtitle != null && subtitle!.trim().isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitle!,
                        style: TimelineType.smallStyle(colors.muted),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Switch.adaptive(
                key: switchKey,
                value: value,
                onChanged: onChanged,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ManageSelectOption<T> {
  const ManageSelectOption({
    required this.value,
    required this.label,
    this.subtitle,
    this.leading,
    this.optionKey,
    this.enabled = true,
  });

  final T value;
  final String label;
  final String? subtitle;
  final Widget? leading;
  final Key? optionKey;
  final bool enabled;
}

/// 基于 `showMobileSheet` 的统一单选底部表单，替代桌面感下拉框。
abstract final class ManageSelectSheet {
  static Future<T?> show<T>(
    BuildContext context, {
    required String title,
    required List<ManageSelectOption<T>> options,
    T? selected,
    bool showChevron = false,
  }) => showMobileSheet<T>(
    context,
    title: title,
    content: (sheet) => SliverList.separated(
      itemCount: options.length,
      separatorBuilder: (_, _) => Divider(
        height: 1,
        color:
            (Theme.of(sheet).brightness == Brightness.dark
                    ? pigcodeDark
                    : pigcodeLight)
                .divider,
      ),
      itemBuilder: (context, index) {
        final opt = options[index];
        final colors = Theme.of(context).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        final isSelected = opt.value == selected;
        return InkWell(
          key: opt.optionKey,
          borderRadius: BorderRadius.circular(12),
          onTap: opt.enabled ? () => Navigator.of(sheet).pop(opt.value) : null,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 12),
              child: Row(
                children: [
                  if (opt.leading != null) ...[
                    opt.leading!,
                    const SizedBox(width: 12),
                  ],
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          opt.label,
                          style: TimelineType.contentStyle(
                            opt.enabled ? colors.foreground : colors.muted,
                            weight: isSelected
                                ? FontWeight.w600
                                : FontWeight.w400,
                          ),
                        ),
                        if (opt.subtitle != null &&
                            opt.subtitle!.trim().isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            opt.subtitle!,
                            style: TimelineType.smallStyle(colors.muted),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (isSelected)
                    Icon(
                      Icons.check_rounded,
                      size: 18,
                      color: colors.foreground,
                    )
                  else if (showChevron)
                    Icon(Icons.chevron_right, size: 18, color: colors.faint),
                ],
              ),
            ),
          ),
        );
      },
    ),
  );
}

/// 等宽胶囊矩阵（例如 3×2 频率选择器）。
class ManageSegmentedGrid<T> extends StatelessWidget {
  const ManageSegmentedGrid({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelected,
    this.columns = 3,
    this.itemKeyBuilder,
  });

  final List<({T value, String label})> options;
  final T selected;
  final ValueChanged<T> onSelected;
  final int columns;
  final Key? Function(T value)? itemKeyBuilder;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final rows = <Widget>[];
    for (var start = 0; start < options.length; start += columns) {
      final slice = options.skip(start).take(columns).toList(growable: false);
      if (rows.isNotEmpty) rows.add(const SizedBox(height: 8));
      rows.add(
        Row(
          children: [
            for (var i = 0; i < columns; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              if (i < slice.length)
                Expanded(
                  child: _SegmentGridTile(
                    tileKey: itemKeyBuilder?.call(slice[i].value),
                    label: slice[i].label,
                    selected: slice[i].value == selected,
                    colors: colors,
                    onTap: () => onSelected(slice[i].value),
                  ),
                )
              else
                const Expanded(child: SizedBox.shrink()),
            ],
          ],
        ),
      );
    }
    return Column(mainAxisSize: MainAxisSize.min, children: rows);
  }
}

class _SegmentGridTile extends StatelessWidget {
  const _SegmentGridTile({
    required this.tileKey,
    required this.label,
    required this.selected,
    required this.colors,
    required this.onTap,
  });

  final Key? tileKey;
  final String label;
  final bool selected;
  final PigcodeColors colors;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      key: tileKey,
      color: selected ? colors.primary : colors.field,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(11),
        side: BorderSide(color: selected ? colors.primary : colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 38),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TimelineType.metaStyle(
                  selected ? colors.onPrimary : colors.foreground,
                  weight: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 克制的危险操作行（如删除定时任务 / 删除自定义实例），替代大红边框按钮。
class ManageDestructiveRow extends StatelessWidget {
  const ManageDestructiveRow({
    super.key,
    this.buttonKey,
    required this.label,
    required this.onPressed,
    this.busy = false,
  });

  final Key? buttonKey;
  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final active = onPressed != null && !busy;
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: buttonKey,
        onTap: active ? onPressed : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Center(
            child: busy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                  )
                : Text(
                    label,
                    style: TimelineType.contentStyle(
                      active ? colors.error : colors.muted,
                      weight: FontWeight.w500,
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}

/// 小巧克制的胶囊状态标签。
class ManageStatusTag extends StatelessWidget {
  const ManageStatusTag({
    super.key,
    required this.label,
    required this.background,
    required this.foreground,
    this.icon,
  });

  final String label;
  final Color background;
  final Color foreground;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(TimelineRadius.full),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 11, color: foreground),
            const SizedBox(width: 3),
          ],
          Text(
            label,
            style: TimelineType.microStyle(
              foreground,
            ).copyWith(fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}
