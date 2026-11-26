import 'package:flutter/material.dart';

import 'mobile_glass.dart';
import 'theme_colors.dart';
import 'workspace_icon.dart';

Future<T?> showMobileSheet<T>(
  BuildContext context, {
  required String title,
  required WidgetBuilder content,
}) {
  final theme = Theme.of(context);
  final palette = theme.brightness == Brightness.dark
      ? pigcodeDark
      : pigcodeLight;
  final touch = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
  final showHandle =
      MediaQuery.sizeOf(context).height -
          MediaQuery.paddingOf(context).vertical -
          MediaQuery.viewInsetsOf(context).bottom >=
      200;
  // 握柄和正文留白为关闭按钮补足平台触区，标题与内容的位置保持对齐。
  final overhang = showHandle ? (touch - 42) / 2 : 0.0;
  const radius = BorderRadius.vertical(top: Radius.circular(22));
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    showDragHandle: false,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: palette.scrim,
    barrierLabel: '关闭',
    elevation: 0,
    clipBehavior: Clip.none,
    constraints: BoxConstraints(
      maxHeight: MediaQuery.sizeOf(context).height * .88,
    ),
    sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
        ? AnimationStyle.noAnimation
        : const AnimationStyle(
            duration: Duration(milliseconds: 260),
            reverseDuration: Duration(milliseconds: 200),
          ),
    builder: (sheet) => MobileGlassSheetSurface(
      borderRadius: radius,
      child: SafeArea(
        top: false,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final header = Padding(
              padding: const EdgeInsetsDirectional.only(start: 20, end: 10),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontSize: 17,
                          fontWeight: FontWeight.w500,
                          height: 1.45,
                          letterSpacing: theme.platform == TargetPlatform.iOS
                              ? -.24
                              : 0,
                          leadingDistribution: TextLeadingDistribution.even,
                          locale: const Locale('zh', 'CN'),
                        ),
                      ),
                    ),
                  ),
                  MobileSheetCloseButton(
                    touchDimension: touch,
                    onPressed: () => Navigator.pop(sheet),
                  ),
                ],
              ),
            );
            final scrollHeader = constraints.maxHeight < 180;
            return Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (showHandle)
                  Padding(
                    padding: EdgeInsets.only(top: 8, bottom: 4 - overhang),
                    child: SizedBox(
                      width: 36,
                      height: 5,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: palette.strongBorder,
                          borderRadius: BorderRadius.circular(3),
                        ),
                      ),
                    ),
                  ),
                if (!scrollHeader) header,
                Flexible(
                  child: CustomScrollView(
                    shrinkWrap: true,
                    slivers: [
                      if (scrollHeader) SliverToBoxAdapter(child: header),
                      SliverPadding(
                        padding: EdgeInsets.fromLTRB(20, 6 - overhang, 20, 20),
                        sliver: content(sheet),
                      ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}

class MobileSheetAction extends StatelessWidget {
  const MobileSheetAction({
    super.key,
    required this.label,
    required this.onTap,
    this.glyph,
    this.icon,
    this.destructive = false,
    this.dividerAbove = false,
  });

  final String label;
  final VoidCallback onTap;
  final WorkspaceGlyph? glyph;
  final IconData? icon;
  final bool destructive;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final palette = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final iconColor = destructive ? palette.error : palette.secondaryText;
    final labelColor = destructive ? palette.error : null;
    return Semantics(
      button: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 54),
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: dividerAbove
                  ? Border(top: BorderSide(color: palette.divider))
                  : null,
            ),
            child: Padding(
              padding: EdgeInsets.only(top: dividerAbove ? 1 : 0),
              child: Row(
                spacing: 14,
                children: [
                  if (glyph case final glyph?)
                    IconTheme(
                      data: IconThemeData(color: iconColor),
                      child: WorkspaceIcon(glyph),
                    )
                  else if (icon case final iconData?)
                    Icon(iconData, size: 20, color: iconColor),
                  Expanded(
                    child: Text(
                      label,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontSize: 16,
                        height: 1.45,
                        color: labelColor,
                        letterSpacing: theme.platform == TargetPlatform.iOS
                            ? -.24
                            : 0,
                        leadingDistribution: TextLeadingDistribution.even,
                        locale: const Locale('zh', 'CN'),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
