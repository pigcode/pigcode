import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'mobile_sheet.dart';
import 'mobile_surfaces.dart';
import 'theme_colors.dart';

enum SidebarGrouping { project, time, status }

enum SidebarSort { recent, status, title }

enum SidebarCategory { attention, error, unread, working, done }

const sidebarCategoryLabels = {
  SidebarCategory.attention: '需要处理',
  SidebarCategory.error: '出错',
  SidebarCategory.unread: '未读',
  SidebarCategory.working: '进行中',
  SidebarCategory.done: '已完成',
};

typedef SidebarArrangement = ({
  SidebarGrouping grouping,
  SidebarSort sort,
  Set<SidebarCategory> filters,
  bool archived,
});

const defaultSidebarArrangement = (
  grouping: SidebarGrouping.project,
  sort: SidebarSort.recent,
  filters: {...SidebarCategory.values},
  archived: false,
);

Future<bool?> showSidebarOptions(
  BuildContext context, {
  required SidebarArrangement current,
  required ValueChanged<SidebarArrangement> onChanged,
  required bool canMarkAllRead,
}) {
  var arrangement = current;
  return showMobileSheet<bool>(
    context,
    title: '分组和筛选',
    content: (sheet) => StatefulBuilder(
      builder: (context, setState) {
        void change({
          SidebarGrouping? grouping,
          SidebarSort? sort,
          Set<SidebarCategory>? filters,
          bool? archived,
        }) {
          setState(() {
            arrangement = (
              grouping: grouping ?? arrangement.grouping,
              sort: sort ?? arrangement.sort,
              filters: filters ?? arrangement.filters,
              archived: archived ?? arrangement.archived,
            );
          });
          onChanged(arrangement);
        }

        final theme = Theme.of(context);
        final colors = theme.brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        final touch = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
        final tracking = theme.platform == TargetPlatform.iOS ? -.24 : -.039;
        final textScaler = MediaQuery.textScalerOf(context);
        final textHeight = textScaler.scale(14) * 1.45;
        final segmentHeight = math.max(36.0, textHeight + 12);
        final segmentTouchHeight = math.max(touch, segmentHeight);
        final segmentInset = (segmentTouchHeight - segmentHeight) / 2;
        final pillHeight = math.max(34.0, textHeight + 12);
        final pillTouchHeight = math.max(touch, pillHeight);
        final pillInset = (pillTouchHeight - pillHeight) / 2;
        final pillSpacing = math.max(0.0, 8 - 2 * pillInset);
        final actionTouchHeight = math.max(46.0, touch);
        final actionInset = (actionTouchHeight - 46) / 2;
        // 控件间的留白可容纳更大的触区，分组、排序和首行筛选保持原型位置。
        final actionSpacing =
            16 -
            (pillSpacing + 2 * pillInset - 8) -
            2 * (actionTouchHeight - 46);
        Widget heading(String label) => SizedBox(
          height: textScaler.scale(13) * 1.45,
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              label,
              maxLines: 1,
              style: theme.textTheme.bodySmall?.copyWith(
                fontSize: 13,
                height: 1.45,
                color: colors.muted,
                letterSpacing: tracking,
                leadingDistribution: TextLeadingDistribution.even,
                locale: const Locale('zh', 'CN'),
              ),
            ),
          ),
        );
        return SliverToBoxAdapter(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              heading('分组'),
              SizedBox(height: 8 - segmentInset),
              _segments(
                context,
                height: segmentHeight,
                touchHeight: segmentTouchHeight,
                selected: arrangement.grouping,
                options: const [
                  (SidebarGrouping.project, '项目'),
                  (SidebarGrouping.time, '更新时间'),
                  (SidebarGrouping.status, '状态'),
                ],
                onChange: (value) => change(grouping: value),
              ),
              SizedBox(height: 16 - segmentInset),
              heading('排序'),
              SizedBox(height: 8 - segmentInset),
              _segments(
                context,
                height: segmentHeight,
                touchHeight: segmentTouchHeight,
                selected: arrangement.sort,
                options: const [
                  (SidebarSort.recent, '更新时间'),
                  (SidebarSort.status, '状态'),
                  (SidebarSort.title, '按名称'),
                ],
                onChange: (value) => change(sort: value),
              ),
              SizedBox(height: 16 - segmentInset),
              heading('筛选'),
              SizedBox(height: 8 - pillInset),
              Wrap(
                spacing: 8,
                runSpacing: pillSpacing,
                children: [
                  for (final category in SidebarCategory.values)
                    _filterPill(
                      context,
                      label: sidebarCategoryLabels[category]!,
                      active: arrangement.filters.contains(category),
                      height: pillHeight,
                      touchHeight: pillTouchHeight,
                      onTap: arrangement.archived
                          ? null
                          : () {
                              final next = {...arrangement.filters};
                              if (!next.remove(category)) next.add(category);
                              change(
                                filters: next.isEmpty
                                    ? defaultSidebarArrangement.filters
                                    : next,
                              );
                            },
                    ),
                ],
              ),
              SizedBox(height: 8 - pillInset),
              _archiveToggle(
                context,
                value: arrangement.archived,
                inset: actionInset,
                onChanged: (value) => change(archived: value),
              ),
              SizedBox(height: actionSpacing),
              Opacity(
                opacity: canMarkAllRead ? 1 : .45,
                child: Stack(
                  fit: StackFit.passthrough,
                  children: [
                    Positioned.fill(
                      top: actionInset * 2,
                      child: DecoratedBox(
                        decoration: mobileRaisedSurface(
                          theme.brightness,
                          fill: colors.surfaceRaised,
                        ),
                      ),
                    ),
                    TextButton(
                      style: TextButton.styleFrom(
                        minimumSize: Size(0, actionTouchHeight),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        padding: EdgeInsets.fromLTRB(
                          18,
                          actionInset * 2,
                          18,
                          0,
                        ),
                        foregroundColor: colors.foreground,
                        disabledForegroundColor: colors.foreground,
                        textStyle: theme.textTheme.titleMedium?.copyWith(
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                          height: 1.45,
                          letterSpacing: tracking,
                          leadingDistribution: TextLeadingDistribution.even,
                          locale: const Locale('zh', 'CN'),
                        ),
                      ),
                      onPressed: canMarkAllRead
                          ? () => Navigator.pop(sheet, true)
                          : null,
                      child: const Text('全部标为已读'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    ),
  );
}

Widget _segments<T>(
  BuildContext context, {
  required T selected,
  required List<(T, String)> options,
  required ValueChanged<T> onChange,
  required double height,
  required double touchHeight,
}) {
  final theme = Theme.of(context);
  final colors = theme.brightness == Brightness.dark
      ? pigcodeDark
      : pigcodeLight;
  final inset = (touchHeight - height) / 2;
  return SizedBox(
    height: touchHeight,
    child: Stack(
      children: [
        Positioned.fill(
          top: inset,
          bottom: inset,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: colors.field,
              borderRadius: BorderRadius.circular(10),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Material(
            type: MaterialType.transparency,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final (value, label) in options)
                  Expanded(
                    child: Semantics(
                      selected: selected == value,
                      inMutuallyExclusiveGroup: true,
                      child: InkWell(
                        onTap: () => onChange(value),
                        borderRadius: BorderRadius.circular(8),
                        child: Center(
                          child: SizedBox(
                            width: double.infinity,
                            height: height - 4,
                            child: DecoratedBox(
                              decoration: selected == value
                                  ? mobileRaisedSurface(
                                      theme.brightness,
                                      radius: BorderRadius.circular(8),
                                      fill: colors.surfaceRaised,
                                    )
                                  : const BoxDecoration(),
                              child: Center(
                                child: Text(
                                  label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    fontSize: 14,
                                    height: 1.45,
                                    color: selected == value
                                        ? colors.foreground
                                        : colors.secondaryText,
                                    fontWeight: selected == value
                                        ? FontWeight.w500
                                        : FontWeight.w400,
                                    letterSpacing:
                                        theme.platform == TargetPlatform.iOS
                                        ? -.24
                                        : -.039,
                                    leadingDistribution:
                                        TextLeadingDistribution.even,
                                    locale: const Locale('zh', 'CN'),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

Widget _filterPill(
  BuildContext context, {
  required String label,
  required bool active,
  required double height,
  required double touchHeight,
  required VoidCallback? onTap,
}) {
  final theme = Theme.of(context);
  final colors = theme.brightness == Brightness.dark
      ? pigcodeDark
      : pigcodeLight;
  return Semantics(
    selected: active,
    button: true,
    enabled: onTap != null,
    child: Opacity(
      opacity: onTap == null ? .45 : 1,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(height / 2),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: touchHeight,
            minWidth: touchHeight,
          ),
          child: Center(
            widthFactor: 1,
            child: Container(
              height: height,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                color: active ? colors.selectedOnSurface : Colors.transparent,
                borderRadius: BorderRadius.circular(height / 2),
                border: Border.all(
                  color: active ? colors.strongBorder : colors.border,
                ),
              ),
              child: Center(
                widthFactor: 1,
                child: Text(
                  label,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontSize: 14,
                    height: 1.45,
                    color: active ? colors.foreground : colors.secondaryText,
                    letterSpacing: theme.platform == TargetPlatform.iOS
                        ? -.24
                        : -.039,
                    leadingDistribution: TextLeadingDistribution.even,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

Widget _archiveToggle(
  BuildContext context, {
  required bool value,
  required double inset,
  required ValueChanged<bool> onChanged,
}) {
  final theme = Theme.of(context);
  final colors = theme.brightness == Brightness.dark
      ? pigcodeDark
      : pigcodeLight;
  const radius = BorderRadius.all(Radius.circular(14));
  var drag = 0.0;
  return Semantics(
    toggled: value,
    child: Material(
      type: MaterialType.transparency,
      child: InkWell(
        borderRadius: radius,
        onTap: () => onChanged(!value),
        child: GestureDetector(
          excludeFromSemantics: true,
          onHorizontalDragStart: (_) => drag = 0,
          onHorizontalDragUpdate: (details) =>
              drag += details.primaryDelta ?? 0,
          onHorizontalDragEnd: (_) {
            if (drag.abs() >= 8) {
              onChanged(
                (drag > 0) == (Directionality.of(context) == TextDirection.ltr),
              );
            }
          },
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: 46 + 2 * inset),
            child: Padding(
              padding: EdgeInsets.symmetric(vertical: inset),
              child: Ink(
                decoration: BoxDecoration(
                  color: colors.panel,
                  borderRadius: radius,
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 8,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '只看已归档',
                        style: TextStyle(color: colors.muted),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Container(
                      width: 32,
                      height: 20,
                      padding: const EdgeInsets.all(2),
                      decoration: BoxDecoration(
                        color: value ? colors.switchOn : colors.switchTrack,
                        borderRadius: BorderRadius.circular(10),
                        border: value
                            ? null
                            : Border.all(color: colors.border, width: .5),
                      ),
                      child: AnimatedAlign(
                        alignment: value
                            ? AlignmentDirectional.centerEnd
                            : AlignmentDirectional.centerStart,
                        duration: MediaQuery.disableAnimationsOf(context)
                            ? Duration.zero
                            : const Duration(milliseconds: 150),
                        curve: const Cubic(.2, .7, .2, 1),
                        child: SizedBox.square(
                          dimension: 16,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: colors.switchThumb,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
