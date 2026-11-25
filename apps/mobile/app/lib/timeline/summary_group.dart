import 'package:flutter/material.dart';

import '../theme_colors.dart';
import '../timeline_work.dart';
import 'shimmer_text.dart';
import 'timeline_tokens.dart';

IconData timelineSummaryIcon(TimelineToolKind? kind) => switch (kind) {
  TimelineToolKind.read ||
  TimelineToolKind.search ||
  TimelineToolKind.fetch => Icons.search,
  TimelineToolKind.edit => Icons.edit_outlined,
  TimelineToolKind.command => Icons.terminal,
  TimelineToolKind.browser => Icons.language,
  TimelineToolKind.mcp => Icons.hub_outlined,
  TimelineToolKind.skill => Icons.auto_awesome_outlined,
  TimelineToolKind.task => Icons.task_alt_outlined,
  TimelineToolKind.plan => Icons.checklist_rounded,
  TimelineToolKind.ask => Icons.help_outline,
  TimelineToolKind.other || null => Icons.psychology_outlined,
};

/// 连续摘要组的完整组件（桌面 `.summary-group`）：头部统计行 + 展开后的限高导线列表。
class TimelineSummaryGroup extends StatelessWidget {
  const TimelineSummaryGroup({
    super.key,
    required this.label,
    this.singleFileLabel,
    required this.icon,
    required this.files,
    required this.expanded,
    required this.toggleable,
    this.shimmer = false,
    this.onToggle,
    this.children = const [],
  });

  final String label;
  final String? singleFileLabel;
  final TimelineToolKind? icon;
  final List<String> files;
  final bool expanded;
  final bool toggleable;
  final bool shimmer;
  final VoidCallback? onToggle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        TimelineSummaryGroupRow(
          label: label,
          singleFileLabel: singleFileLabel,
          icon: icon,
          files: files,
          expanded: expanded,
          toggleable: toggleable,
          shimmer: shimmer,
          onToggle: onToggle,
        ),
        if (expanded && children.isNotEmpty)
          TimelineSummaryGroupBody(children: children),
      ],
    );
  }
}

/// 连续摘要组的头部行（桌面 `.summary-group-head`）：
/// 收起且只改文件时在统计后面列出最多 3 个文件名 + `+N`（单文件写「已修改 文件名」）；
/// 展开后只显示统计文案，箭头旋转 90°。
class TimelineSummaryGroupRow extends StatelessWidget {
  const TimelineSummaryGroupRow({
    super.key,
    required this.label,
    this.singleFileLabel,
    required this.icon,
    required this.files,
    required this.expanded,
    required this.toggleable,
    this.shimmer = false,
    this.onToggle,
  });

  final String label;
  final String? singleFileLabel;
  final TimelineToolKind? icon;
  final List<String> files;
  final bool expanded;
  final bool toggleable;
  final bool shimmer;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final showFiles = !expanded && files.isNotEmpty;
    final headLabel = showFiles && singleFileLabel != null
        ? singleFileLabel!
        : label;
    final statsStyle = TimelineType.contentStyle(colors.timelineSubtle);
    final labelWidget = shimmer
        ? TimelineShimmerText(text: headLabel, style: statsStyle)
        : Text(headLabel, style: statsStyle);
    final shownFiles = showFiles
        ? files.take(TimelineSummary.shownFiles).toList()
        : const <String>[];
    final extraFiles = showFiles ? files.length - shownFiles.length : 0;

    final row = Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(
            top: TimelineMarkdown.rowIconTopOffset,
          ),
          child: SizedBox(
            width: TimelineIcon.row,
            height: TimelineIcon.row,
            child: Center(
              child: Icon(
                timelineSummaryIcon(icon),
                size: TimelineIcon.row,
                color: colors.timelineSubtle,
              ),
            ),
          ),
        ),
        const SizedBox(width: TimelineSpace.fieldGap),
        Flexible(
          child: showFiles
              ? Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: TimelineSpace.fieldGap,
                  runSpacing: TimelineSpace.x1,
                  children: [
                    labelWidget,
                    for (final path in shownFiles) _FileChip(path: path),
                    if (extraFiles > 0)
                      Text('+$extraFiles', style: statsStyle),
                  ],
                )
              : shimmer
              ? TimelineShimmerText(
                  text: headLabel,
                  style: statsStyle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                )
              : Text(
                  headLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: statsStyle,
                ),
        ),
        if (toggleable) ...[
          const SizedBox(width: TimelineSpace.fieldGap),
          Padding(
            padding: const EdgeInsets.only(
              top: TimelineMarkdown.rowChevronTopOffset,
            ),
            child: AnimatedRotation(
              turns: expanded ? 0.25 : 0,
              duration: MediaQuery.disableAnimationsOf(context)
                  ? Duration.zero
                  : TimelineMotion.slow,
              curve: TimelineMotion.ease,
              child: Icon(
                Icons.chevron_right,
                size: TimelineIcon.badge,
                color: colors.timelineFaint,
              ),
            ),
          ),
        ],
      ],
    );

    final hit = timelineTouchHeight(context);
    final sized = ConstrainedBox(
      constraints: BoxConstraints(minHeight: hit),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        heightFactor: 1,
        child: row,
      ),
    );
    if (!toggleable) return sized;
    return Semantics(
      button: true,
      expanded: expanded,
      label: label,
      child: InkWell(
        onTap: onToggle,
        borderRadius: BorderRadius.circular(TimelineRadius.xs),
        child: sized,
      ),
    );
  }
}

/// 展开后的摘要组内容区（桌面 `.summary-group-body` + `.summary-group-list`）：
/// 最多 16 行高（504px），超出在内部滚动并自动跟随最新项；有隐藏内容时边缘 24px 淡出；
/// 左侧 8px 缩进处画 1px `--cv-border` 导线，文字在导线右侧 16px（总共 24px，对齐组头图标后）。
class TimelineSummaryGroupBody extends StatefulWidget {
  const TimelineSummaryGroupBody({super.key, required this.children});

  final List<Widget> children;

  @override
  State<TimelineSummaryGroupBody> createState() =>
      _TimelineSummaryGroupBodyState();
}

enum _ScrollEdges { none, top, bottom, both }

class _TimelineSummaryGroupBodyState extends State<TimelineSummaryGroupBody> {
  final _scroll = ScrollController();
  final _viewportKey = GlobalKey();
  bool _following = true;
  bool _autoJumping = false;
  _ScrollEdges _edges = _ScrollEdges.none;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _syncScroll();
  }

  @override
  void didUpdateWidget(TimelineSummaryGroupBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.children.length != widget.children.length) {
      _syncScroll();
    }
  }

  void _syncScroll() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      if (_following) {
        _autoJumping = true;
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
        _autoJumping = false;
      }
      _measureEdges();
    });
  }

  void _onScroll() {
    if (_autoJumping || !_scroll.hasClients) return;
    final position = _scroll.position;
    _following =
        position.maxScrollExtent - position.pixels <=
        TimelineSummary.followThreshold;
    _measureEdges();
  }

  void _measureEdges() {
    if (!mounted || !_scroll.hasClients) return;
    final position = _scroll.position;
    final top = position.pixels > 0;
    final bottom = position.maxScrollExtent - position.pixels > 1;
    final next = top && bottom
        ? _ScrollEdges.both
        : top
        ? _ScrollEdges.top
        : bottom
        ? _ScrollEdges.bottom
        : _ScrollEdges.none;
    if (next != _edges) setState(() => _edges = next);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final list = Padding(
      padding: const EdgeInsetsDirectional.only(
        start: TimelineSpace.guideIndent,
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: BorderDirectional(
            start: BorderSide(
              color: colors.timelineBorder,
              width: TimelineBorder.regular,
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsetsDirectional.only(
            start: TimelineSpace.guidePadding,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final (index, child) in widget.children.indexed) ...[
                if (index > 0) const SizedBox(height: TimelineSummary.itemGap),
                child,
              ],
            ],
          ),
        ),
      ),
    );

    final scrollable = KeyedSubtree(
      key: _viewportKey,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxHeight: TimelineSummary.maxBodyHeight,
        ),
        child: NotificationListener<ScrollMetricsNotification>(
          onNotification: (_) {
            _measureEdges();
            return false;
          },
          child: SingleChildScrollView(controller: _scroll, child: list),
        ),
      ),
    );

    return Padding(
      padding: const EdgeInsets.only(top: TimelineSpace.x4),
      child: _edges == _ScrollEdges.none
          ? scrollable
          : ShaderMask(
              blendMode: BlendMode.dstIn,
              shaderCallback: (bounds) {
                final height = bounds.height;
                if (height <= 0) {
                  return const LinearGradient(
                    colors: [Colors.white, Colors.white],
                  ).createShader(bounds);
                }
                final edge = (TimelineSummary.fadeEdge / height).clamp(
                  0.0,
                  0.45,
                );
                return switch (_edges) {
                  _ScrollEdges.top => LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: const [Colors.transparent, Colors.white],
                    stops: [0, edge],
                  ).createShader(bounds),
                  _ScrollEdges.bottom => LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: const [Colors.white, Colors.transparent],
                    stops: [1 - edge, 1],
                  ).createShader(bounds),
                  _ScrollEdges.both => LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: const [
                      Colors.transparent,
                      Colors.white,
                      Colors.white,
                      Colors.transparent,
                    ],
                    stops: [0, edge, 1 - edge, 1],
                  ).createShader(bounds),
                  _ScrollEdges.none => const LinearGradient(
                    colors: [Colors.white, Colors.white],
                  ).createShader(bounds),
                };
              },
              child: scrollable,
            ),
    );
  }
}

/// 桌面 `.file-chip`：正文色 15/24、15px 文件图标、gap 6px，只写文件名。
class _FileChip extends StatelessWidget {
  const _FileChip({required this.path});

  final String path;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final normalized = path.replaceAll('\\', '/');
    final name = normalized.split('/').last;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          Icons.insert_drive_file_outlined,
          size: TimelineIcon.row,
          color: colors.timelineSubtle,
        ),
        const SizedBox(width: TimelineSpace.x3),
        Text(name, style: TimelineType.contentStyle(colors.foreground)),
      ],
    );
  }
}
