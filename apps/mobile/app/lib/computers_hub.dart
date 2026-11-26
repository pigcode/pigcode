import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'app_theme.dart';
import 'mobile_glass.dart';
import 'mobile_sheet.dart';
import 'mobile_status_dot.dart';
import 'multi_computer_summary.dart';
import 'theme_colors.dart';
import 'workspace_icon.dart';

/// 迭代 6 跨电脑汇总 + 我的电脑总览主页。
class ComputersHub extends StatefulWidget {
  const ComputersHub({
    super.key,
    required this.coordinator,
    required this.loadingComputers,
    required this.computersError,
    required this.onRetryComputers,
    required this.selectedComputerKey,
    required this.activeConnectionLabel,
    required this.working,
    required this.updatingRelay,
    required this.verificationCode,
    required this.feedback,
    required this.onBackToWorkspace,
    required this.onOpenReminderSettings,
    required this.onRefreshAll,
    required this.onRefreshComputer,
    required this.onSelectComputer,
    required this.onOpenInboxItem,
    required this.onForgetComputer,
    required this.onScanPair,
    this.onDismissFeedback,
  });

  static const listViewKey = ValueKey('computers-hub-list');
  static const refreshButtonKey = ValueKey('computers-hub-refresh');
  static const scanButtonKey = ValueKey('computers-hub-scan');
  static const filterAllKey = ValueKey('computers-hub-filter-all');
  static const filterAttentionKey = ValueKey('computers-hub-filter-attention');
  static const filterErrorKey = ValueKey('computers-hub-filter-error');
  static const filterUnreadKey = ValueKey('computers-hub-filter-unread');
  static const inboxSectionKey = ValueKey('computers-hub-inbox');

  final MultiComputerCoordinator coordinator;
  final bool loadingComputers;
  final bool computersError;
  final VoidCallback onRetryComputers;
  final String? selectedComputerKey;
  final String activeConnectionLabel;
  final bool working;
  final bool updatingRelay;
  final String? verificationCode;
  final String? feedback;
  final VoidCallback? onBackToWorkspace;
  final VoidCallback onOpenReminderSettings;
  final Future<void> Function() onRefreshAll;
  final Future<void> Function(ComputerProfile computer) onRefreshComputer;
  final ValueChanged<ComputerProfile> onSelectComputer;
  final ValueChanged<CrossComputerInboxItem> onOpenInboxItem;
  final ValueChanged<ComputerProfile> onForgetComputer;
  final VoidCallback onScanPair;
  final VoidCallback? onDismissFeedback;

  @override
  State<ComputersHub> createState() => _ComputersHubState();
}

enum _ComputerCardAction { open, refresh, remove }

class _ComputersHubState extends State<ComputersHub>
    with SingleTickerProviderStateMixin {
  CrossComputerFilter _filter = CrossComputerFilter.all;
  String? _computerScopeKey;
  late final AnimationController _spinController = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void initState() {
    super.initState();
    widget.coordinator.addListener(_onCoordinatorChanged);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncSpin();
  }

  @override
  void didUpdateWidget(covariant ComputersHub oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.coordinator, widget.coordinator)) {
      oldWidget.coordinator.removeListener(_onCoordinatorChanged);
      widget.coordinator.addListener(_onCoordinatorChanged);
    }
    _syncSpin();
  }

  void _onCoordinatorChanged() {
    if (!mounted) return;
    _syncSpin();
    setState(() {
      if (_computerScopeKey != null &&
          widget.coordinator.entryFor(_computerScopeKey!) == null) {
        _computerScopeKey = null;
      }
    });
  }

  void _syncSpin() {
    final syncing = widget.coordinator.isSyncing;
    final reduced =
        mounted && MediaQuery.maybeDisableAnimationsOf(context) == true;
    if (syncing && !reduced) {
      if (!_spinController.isAnimating) _spinController.repeat();
    } else {
      if (_spinController.isAnimating) {
        _spinController.stop();
        _spinController.reset();
      }
    }
  }

  @override
  void dispose() {
    widget.coordinator.removeListener(_onCoordinatorChanged);
    _spinController.dispose();
    super.dispose();
  }

  MobileSummaryCounts _scopedCounts(List<ComputerSummaryEntry> entries) {
    if (_computerScopeKey == null) return widget.coordinator.totalCounts;
    return entries
            .where((e) => e.profile.computerKey == _computerScopeKey)
            .firstOrNull
            ?.counts ??
        MobileSummaryCounts.zero;
  }

  Future<void> _openComputerActions(ComputerSummaryEntry entry) async {
    final items = <(WorkspaceGlyph, String, _ComputerCardAction, bool)>[
      (
        WorkspaceGlyph.laptop,
        entry.isActive ? '返回当前工作区' : '切换到这台电脑',
        _ComputerCardAction.open,
        false,
      ),
      if (!entry.isActive && !entry.isRevoked)
        (WorkspaceGlyph.zap, '立即刷新摘要', _ComputerCardAction.refresh, false),
      (WorkspaceGlyph.archive, '移除这台电脑', _ComputerCardAction.remove, true),
    ];
    final action = await showMobileSheet<_ComputerCardAction>(
      context,
      title: entry.profile.name,
      content: (sheet) => SliverList.builder(
        itemCount: items.length,
        itemBuilder: (_, index) {
          final (glyph, label, value, destructive) = items[index];
          return MobileSheetAction(
            glyph: glyph,
            label: label,
            destructive: destructive,
            dividerAbove: index > 0,
            onTap: () => Navigator.pop(sheet, value),
          );
        },
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case _ComputerCardAction.open:
        widget.onSelectComputer(entry.profile);
      case _ComputerCardAction.refresh:
        unawaited(widget.onRefreshComputer(entry.profile));
      case _ComputerCardAction.remove:
        widget.onForgetComputer(entry.profile);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final entries = widget.coordinator.entries;
    final isSyncing = widget.coordinator.isSyncing;
    final scopedCounts = _scopedCounts(entries);
    final inbox = widget.coordinator.inboxItems(
      filter: _filter,
      computerKey: _computerScopeKey,
    );

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        backgroundColor: colors.background,
        surfaceTintColor: Colors.transparent,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
        centerTitle: true,
        title: Text(
          '电脑',
          style: TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w500,
            color: colors.foreground,
            locale: const Locale('zh', 'CN'),
          ),
        ),
        leadingWidth: widget.onBackToWorkspace != null ? 58 : null,
        leading: widget.onBackToWorkspace != null
            ? Align(
                alignment: AlignmentDirectional.centerStart,
                child: MobileGlassChromeButton(
                  padding: const EdgeInsetsDirectional.only(start: 10),
                  child: SizedBox.square(
                    dimension: 40,
                    child: BackButton(onPressed: widget.onBackToWorkspace),
                  ),
                ),
              )
            : null,
        actions: [
          if (entries.isNotEmpty)
            Center(
              child: MobileGlassChromeButton(
                padding: const EdgeInsetsDirectional.only(end: 8),
                child: SizedBox.square(
                  dimension: 40,
                  child: IconButton(
                    key: ComputersHub.refreshButtonKey,
                    tooltip: '刷新全部电脑',
                    padding: EdgeInsets.zero,
                    onPressed: widget.working
                        ? null
                        : () => unawaited(widget.onRefreshAll()),
                    icon: RotationTransition(
                      turns: _spinController,
                      child: Icon(
                        Icons.refresh_rounded,
                        size: 20,
                        color: isSyncing
                            ? colors.foreground
                            : colors.secondaryText,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          Center(
            child: MobileGlassChromeButton(
              padding: const EdgeInsetsDirectional.only(end: 10),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  tooltip: '通知设置',
                  padding: EdgeInsets.zero,
                  icon: const Icon(Icons.notifications_outlined, size: 20),
                  onPressed: widget.onOpenReminderSettings,
                ),
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: _buildBody(
          context,
          colors: colors,
          entries: entries,
          isSyncing: isSyncing,
          scopedCounts: scopedCounts,
          inbox: inbox,
        ),
      ),
    );
  }

  Widget _buildBody(
    BuildContext context, {
    required PigcodeColors colors,
    required List<ComputerSummaryEntry> entries,
    required bool isSyncing,
    required MobileSummaryCounts scopedCounts,
    required List<CrossComputerInboxItem> inbox,
  }) {
    if (widget.loadingComputers) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }
    if (widget.computersError) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '无法读取系统凭据存储',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: colors.foreground,
                ),
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: widget.onRetryComputers,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }

    if (entries.isEmpty) {
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 32),
        children: [
          if (widget.verificationCode case final code?) ...[
            _VerificationCard(
              colors: colors,
              code: code,
              updatingRelay: widget.updatingRelay,
            ),
            const SizedBox(height: 16),
          ] else if (widget.working) ...[
            const LinearProgressIndicator(),
            const SizedBox(height: 16),
          ],
          if (widget.feedback case final message?) ...[
            _FeedbackBanner(
              colors: colors,
              message: message,
              onDismiss: widget.onDismissFeedback,
            ),
            const SizedBox(height: 16),
          ],
          _EmptyOnboardingCard(
            colors: colors,
            working: widget.working,
            onScan: widget.onScanPair,
          ),
        ],
      );
    }

    final totalCounts = widget.coordinator.totalCounts;
    final nonRevokedEntries = entries.where((e) => !e.isRevoked).toList();

    return RefreshIndicator.adaptive(
      onRefresh: widget.onRefreshAll,
      child: ListView(
        key: ComputersHub.listViewKey,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(0, 4, 0, 32),
        children: [
          if (widget.verificationCode case final code?)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
              child: _VerificationCard(
                colors: colors,
                code: code,
                updatingRelay: widget.updatingRelay,
              ),
            )
          else if (widget.working)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: LinearProgressIndicator(),
            ),
          if (widget.feedback case final message?)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: _FeedbackBanner(
                colors: colors,
                message: message,
                onDismiss: widget.onDismissFeedback,
              ),
            ),

          // 顶部静谧状态头（唯一视觉重心）
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
            child: _SummaryHeroHeader(
              colors: colors,
              totalCounts: totalCounts,
              onlineCount: widget.coordinator.onlineCount,
              computerCount: entries.length,
              isSyncing: isSyncing,
            ),
          ),

          // 仅在存在待看条目（或已激活筛选）时显示筛选条，全部已处理时保持画面克制留白
          if (totalCounts.actionable > 0 ||
              _filter != CrossComputerFilter.all ||
              _computerScopeKey != null) ...[
            // 紧急度筛选条
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  _FilterChip(
                    key: ComputersHub.filterAllKey,
                    colors: colors,
                    label: '全部待看',
                    count: scopedCounts.actionable,
                    selected: _filter == CrossComputerFilter.all,
                    onTap: () =>
                        setState(() => _filter = CrossComputerFilter.all),
                  ),
                  const SizedBox(width: 8),
                  _FilterChip(
                    key: ComputersHub.filterAttentionKey,
                    colors: colors,
                    label: '需要处理',
                    count: scopedCounts.attention,
                    accentDot: scopedCounts.attention > 0
                        ? colors.attentionMark
                        : null,
                    selected: _filter == CrossComputerFilter.attention,
                    onTap: () =>
                        setState(() => _filter = CrossComputerFilter.attention),
                  ),
                  const SizedBox(width: 8),
                  _FilterChip(
                    key: ComputersHub.filterErrorKey,
                    colors: colors,
                    label: '出错',
                    count: scopedCounts.error,
                    accentDot: scopedCounts.error > 0 ? colors.error : null,
                    selected: _filter == CrossComputerFilter.error,
                    onTap: () =>
                        setState(() => _filter = CrossComputerFilter.error),
                  ),
                  const SizedBox(width: 8),
                  _FilterChip(
                    key: ComputersHub.filterUnreadKey,
                    colors: colors,
                    label: '未读',
                    count: scopedCounts.unread,
                    selected: _filter == CrossComputerFilter.unread,
                    onTap: () =>
                        setState(() => _filter = CrossComputerFilter.unread),
                  ),
                ],
              ),
            ),

            // 多机范围筛选条（>= 2 台电脑时自动展现）
            if (nonRevokedEntries.length >= 2) ...[
              const SizedBox(height: 10),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  children: [
                    _ComputerScopePill(
                      colors: colors,
                      label: '全部电脑',
                      selected: _computerScopeKey == null,
                      onTap: () => setState(() => _computerScopeKey = null),
                    ),
                    for (final entry in nonRevokedEntries) ...[
                      const SizedBox(width: 8),
                      _ComputerScopePill(
                        key: ValueKey('scope-${entry.profile.computerKey}'),
                        colors: colors,
                        label: entry.profile.name,
                        dotColor: entry.isOnline
                            ? colors.readyMark
                            : colors.faint,
                        count: entry.counts.actionable,
                        selected:
                            _computerScopeKey == entry.profile.computerKey,
                        onTap: () => setState(() {
                          _computerScopeKey =
                              _computerScopeKey == entry.profile.computerKey
                              ? null
                              : entry.profile.computerKey;
                        }),
                      ),
                    ],
                  ],
                ),
              ),
            ],
            const SizedBox(height: 14),
          ],

          // 跨电脑待看汇总队列
          Padding(
            key: ComputersHub.inboxSectionKey,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: _InboxCard(
              colors: colors,
              items: inbox,
              totalActionable: totalCounts.actionable,
              workingCount: totalCounts.working,
              hasActiveFilter:
                  _filter != CrossComputerFilter.all ||
                  _computerScopeKey != null,
              showComputerName:
                  entries.length >= 2 && _computerScopeKey == null,
              onResetFilters: () => setState(() {
                _filter = CrossComputerFilter.all;
                _computerScopeKey = null;
              }),
              onOpenItem: widget.onOpenInboxItem,
            ),
          ),

          const SizedBox(height: 28),

          // 我的电脑区块头
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 6, 8),
            child: Row(
              children: [
                Text(
                  '我的电脑',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: colors.muted,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  '${entries.length}',
                  style: TextStyle(
                    fontSize: 12,
                    color: colors.faint,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
                const Spacer(),
                TextButton.icon(
                  key: ComputersHub.scanButtonKey,
                  onPressed: widget.working ? null : widget.onScanPair,
                  style: TextButton.styleFrom(
                    foregroundColor: colors.foreground,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    minimumSize: const Size(44, 36),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  icon: const Icon(Icons.qr_code_scanner_rounded, size: 15),
                  label: const Text(
                    '扫码配对',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      locale: Locale('zh', 'CN'),
                    ),
                  ),
                ),
              ],
            ),
          ),

          // 电脑卡片列表
          for (var i = 0; i < entries.length; i++) ...[
            if (i > 0) const SizedBox(height: 10),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: _ComputerCard(
                colors: colors,
                entry: entries[i],
                activeConnectionLabel: widget.activeConnectionLabel,
                disabled: widget.working,
                onTap: () => widget.onSelectComputer(entries[i].profile),
                onMore: () => unawaited(_openComputerActions(entries[i])),
                onRescan: widget.working ? null : widget.onScanPair,
                onRemove: widget.working
                    ? null
                    : () => widget.onForgetComputer(entries[i].profile),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

typedef PigcodeColors = ({
  Color background,
  Color window,
  Color surface,
  Color surfaceRaised,
  Color surfaceSunken,
  Color panel,
  Color field,
  Color switchTrack,
  Color switchOn,
  Color switchThumb,
  Color foreground,
  Color secondaryText,
  Color primary,
  Color onPrimary,
  Color divider,
  Color border,
  Color strongBorder,
  Color inputBackground,
  Color inputBorder,
  Color timelineUser,
  Color timelineDivider,
  Color timelineSubtle,
  Color timelineFaint,
  Color popover,
  Color timelinePanel,
  Color timelineCard,
  Color timelineBorder,
  Color timelineInlineCode,
  Color timelineDecoration,
  Color timelineShimmerSoft,
  Color timelineRemoved,
  Color hover,
  Color link,
  Color timelineFile,
  Color selected,
  Color error,
  Color errorTint,
  Color onError,
  Color muted,
  Color faint,
  Color attention,
  Color attentionTint,
  Color attentionMark,
  Color statusAccent,
  Color readyMark,
  Color running,
  Color online,
  Color diffAdded,
  Color diffRemoved,
  Color scrim,
  Color selectedOnSurface,
  Color selectedOnBackground,
  Color diffAddedBackground,
  Color diffRemovedBackground,
});

class _SummaryHeroHeader extends StatelessWidget {
  const _SummaryHeroHeader({
    required this.colors,
    required this.totalCounts,
    required this.onlineCount,
    required this.computerCount,
    required this.isSyncing,
  });

  final PigcodeColors colors;
  final MobileSummaryCounts totalCounts;
  final int onlineCount;
  final int computerCount;
  final bool isSyncing;

  String get _headline {
    if (totalCounts.attention > 0) {
      return '${totalCounts.attention} 项等待处理';
    }
    if (totalCounts.error > 0) {
      return '${totalCounts.error} 项运行出错';
    }
    if (totalCounts.unread > 0) {
      return '${totalCounts.unread} 项未读';
    }
    return '全部已处理';
  }

  @override
  Widget build(BuildContext context) {
    final parts = <String>[
      '$onlineCount/$computerCount 台在线',
      if (totalCounts.working > 0) '${totalCounts.working} 项进行中',
      if (isSyncing) '正在同步…',
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          _headline,
          style: TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w600,
            height: 1.25,
            letterSpacing: -0.4,
            color: colors.foreground,
            fontFeatures: const [FontFeature.tabularFigures()],
            locale: const Locale('zh', 'CN'),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            MobileStatusDot(
              color: onlineCount > 0 ? colors.readyMark : colors.faint,
            ),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                parts.join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  height: 1.4,
                  color: colors.muted,
                  fontFeatures: const [FontFeature.tabularFigures()],
                  locale: const Locale('zh', 'CN'),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    super.key,
    required this.colors,
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
    this.accentDot,
  });

  final PigcodeColors colors;
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;
  final Color? accentDot;

  @override
  Widget build(BuildContext context) {
    final bg = selected ? colors.primary : colors.surface;
    final fg = selected ? colors.onPrimary : colors.secondaryText;
    final countColor = selected
        ? colors.onPrimary.withValues(alpha: 0.78)
        : colors.muted;
    return Material(
      color: bg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: selected
            ? BorderSide.none
            : BorderSide(color: colors.border, width: 1),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 36),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!selected && accentDot != null) ...[
                MobileStatusDot(color: accentDot!),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                  color: fg,
                  locale: const Locale('zh', 'CN'),
                ),
              ),
              if (count > 0) ...[
                const SizedBox(width: 5),
                Text(
                  '$count',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: countColor,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ComputerScopePill extends StatelessWidget {
  const _ComputerScopePill({
    super.key,
    required this.colors,
    required this.label,
    required this.selected,
    required this.onTap,
    this.dotColor,
    this.count = 0,
  });

  final PigcodeColors colors;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final Color? dotColor;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? colors.selectedOnBackground : Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(
          color: selected ? colors.strongBorder : colors.divider,
          width: 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 30),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (dotColor != null) ...[
                MobileStatusDot(color: dotColor!),
                const SizedBox(width: 6),
              ],
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 140),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                    color: selected ? colors.foreground : colors.muted,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
              ),
              if (count > 0) ...[
                const SizedBox(width: 4),
                Text(
                  '$count',
                  style: TextStyle(
                    fontSize: 11.5,
                    color: colors.faint,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _InboxCard extends StatelessWidget {
  const _InboxCard({
    required this.colors,
    required this.items,
    required this.totalActionable,
    required this.workingCount,
    required this.hasActiveFilter,
    required this.showComputerName,
    required this.onResetFilters,
    required this.onOpenItem,
  });

  final PigcodeColors colors;
  final List<CrossComputerInboxItem> items;
  final int totalActionable;
  final int workingCount;
  final bool hasActiveFilter;
  final bool showComputerName;
  final VoidCallback onResetFilters;
  final ValueChanged<CrossComputerInboxItem> onOpenItem;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.border, width: 1),
      ),
      clipBehavior: Clip.antiAlias,
      child: items.isEmpty
          ? _buildEmptyState()
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < items.length; i++) ...[
                  if (i > 0)
                    Divider(
                      height: 1,
                      thickness: 1,
                      indent: 32,
                      endIndent: 14,
                      color: colors.divider,
                    ),
                  _InboxRow(
                    colors: colors,
                    entry: items[i],
                    showComputerName: showComputerName,
                    onTap: () => onOpenItem(items[i]),
                  ),
                ],
              ],
            ),
    );
  }

  Widget _buildEmptyState() {
    if (totalActionable > 0 && hasActiveFilter) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '当前筛选下没有匹配会话',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: colors.secondaryText,
                locale: const Locale('zh', 'CN'),
              ),
            ),
            const SizedBox(height: 8),
            TextButton(onPressed: onResetFilters, child: const Text('查看全部待看')),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 22),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: colors.readyMark.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Center(
              child: IconTheme(
                data: IconThemeData(color: colors.readyMark),
                child: const WorkspaceIcon(WorkspaceGlyph.check, size: 17),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '所有电脑暂无待处理事项',
                  style: TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w500,
                    color: colors.foreground,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  workingCount > 0
                      ? '当前有 $workingCount 个会话仍在运行中，需要确认时会汇聚在这里'
                      : '有新的审批、提问或运行结果时会汇聚在这里',
                  style: TextStyle(
                    fontSize: 12.5,
                    height: 1.4,
                    color: colors.muted,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _InboxRow extends StatelessWidget {
  const _InboxRow({
    required this.colors,
    required this.entry,
    required this.showComputerName,
    required this.onTap,
  });

  final PigcodeColors colors;
  final CrossComputerInboxItem entry;
  final bool showComputerName;
  final VoidCallback onTap;

  Color get _dotColor {
    if (entry.item.isAttention) return colors.attentionMark;
    if (entry.item.isError) return colors.error;
    return colors.primary;
  }

  ({String label, Color bg, Color fg}) get _tag {
    if (entry.item.isAttention) {
      final label = switch (entry.item.pendingKind) {
        MobileThreadPendingKind.approval => '等你确认',
        MobileThreadPendingKind.question => '等你回答',
        null => '等你处理',
      };
      return (label: label, bg: colors.attentionTint, fg: colors.attention);
    }
    if (entry.item.isError) {
      return (label: '出错', bg: colors.errorTint, fg: colors.error);
    }
    return (label: '未读', bg: colors.field, fg: colors.secondaryText);
  }

  @override
  Widget build(BuildContext context) {
    final item = entry.item;
    final tag = _tag;
    final preview = item.pendingPreview?.trim();
    final updatedLabel = _relativeIsoTime(item.updatedAt);

    return InkWell(
      key: ValueKey('inbox-${entry.computer.computerKey}-${item.threadId}'),
      onTap: onTap,
      hoverColor: colors.hover,
      splashColor: colors.selected,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 13, 12, 13),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child: MobileStatusDot(color: _dotColor),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Expanded(
                        child: Text(
                          item.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                            height: 1.35,
                            color: colors.foreground,
                            locale: const Locale('zh', 'CN'),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        updatedLabel,
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.muted,
                          fontFeatures: const [FontFeature.tabularFigures()],
                          locale: const Locale('zh', 'CN'),
                        ),
                      ),
                    ],
                  ),
                  if (preview != null && preview.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      preview,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13,
                        height: 1.35,
                        color: item.isAttention
                            ? colors.attention
                            : colors.secondaryText,
                        locale: const Locale('zh', 'CN'),
                      ),
                    ),
                  ],
                  const SizedBox(height: 7),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: tag.bg,
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: Text(
                          tag.label,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w500,
                            height: 1.2,
                            color: tag.fg,
                            locale: const Locale('zh', 'CN'),
                          ),
                        ),
                      ),
                      if (showComputerName)
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconTheme(
                              data: IconThemeData(color: colors.muted),
                              child: const WorkspaceIcon(
                                WorkspaceGlyph.laptop,
                                size: 12,
                              ),
                            ),
                            const SizedBox(width: 4),
                            ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 120),
                              child: Text(
                                entry.computer.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w500,
                                  color: colors.secondaryText,
                                  locale: const Locale('zh', 'CN'),
                                ),
                              ),
                            ),
                          ],
                        ),
                      Text(
                        showComputerName
                            ? '· ${item.projectName}'
                            : item.projectName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.muted,
                          locale: const Locale('zh', 'CN'),
                        ),
                      ),
                      if (!entry.computerOnline)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 1.5,
                          ),
                          decoration: BoxDecoration(
                            color: colors.field,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            '缓存',
                            style: TextStyle(
                              fontSize: 11,
                              color: colors.muted,
                              locale: const Locale('zh', 'CN'),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(
                Icons.chevron_right_rounded,
                size: 18,
                color: colors.faint,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ComputerCard extends StatelessWidget {
  const _ComputerCard({
    required this.colors,
    required this.entry,
    required this.activeConnectionLabel,
    required this.disabled,
    required this.onTap,
    required this.onMore,
    required this.onRescan,
    required this.onRemove,
  });

  final PigcodeColors colors;
  final ComputerSummaryEntry entry;
  final String activeConnectionLabel;
  final bool disabled;
  final VoidCallback onTap;
  final VoidCallback onMore;
  final VoidCallback? onRescan;
  final VoidCallback? onRemove;

  Color get _badgeDotColor {
    if (entry.isRevoked) return colors.error;
    if (entry.isOnline) return colors.readyMark;
    if (entry.syncState == ComputerSummarySyncState.syncing ||
        entry.relayStatus?.state == RelayComputerState.restarting) {
      return colors.attentionMark;
    }
    return colors.faint;
  }

  String _statusSubtitle(BuildContext context) {
    if (entry.isRevoked) return '配对已撤销';
    if (entry.isActive) return activeConnectionLabel;
    if (entry.syncState == ComputerSummarySyncState.syncing) {
      return '在线 · 正在同步摘要…';
    }
    final status = entry.relayStatus;
    if (status == null) {
      return entry.lastError != null ? '暂未连上中继' : '正在检测状态…';
    }
    final base = switch (status.state) {
      RelayComputerState.online => '在线',
      RelayComputerState.sleeping => '正在睡眠',
      RelayComputerState.exited => 'Pigcode 已退出',
      RelayComputerState.restarting => '正在重启',
      RelayComputerState.offline => '离线',
    };
    if (status.state == RelayComputerState.online) {
      if (entry.syncState == ComputerSummarySyncState.error) {
        return '在线 · 摘要同步失败';
      }
      return '在线 · 点按切换';
    }
    final seen = status.lastOnlineAt?.toLocal();
    if (seen == null) return base;
    return '$base · 最后在线 ${_formatChineseStamp(seen)}';
  }

  @override
  Widget build(BuildContext context) {
    final counts = entry.counts;
    return Material(
      key: ValueKey(entry.profile.computerKey),
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(
          color: entry.isActive ? colors.strongBorder : colors.border,
          width: entry.isActive ? 1.5 : 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: disabled ? null : onTap,
        hoverColor: colors.hover,
        splashColor: colors.selected,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 13, 6, 12),
              child: Row(
                children: [
                  SizedBox(
                    width: 40,
                    height: 40,
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Container(
                          width: 38,
                          height: 38,
                          decoration: BoxDecoration(
                            color: colors.field,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Center(
                            child: IconTheme(
                              data: IconThemeData(
                                color: entry.isActive
                                    ? colors.foreground
                                    : colors.secondaryText,
                              ),
                              child: const WorkspaceIcon(
                                WorkspaceGlyph.laptop,
                                size: 20,
                              ),
                            ),
                          ),
                        ),
                        Positioned(
                          right: 0,
                          bottom: 0,
                          child: Container(
                            width: 12,
                            height: 12,
                            decoration: BoxDecoration(
                              color: _badgeDotColor,
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: colors.surface,
                                width: 2,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text(
                                entry.profile.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w500,
                                  color: colors.foreground,
                                  locale: const Locale('zh', 'CN'),
                                ),
                              ),
                            ),
                            if (entry.isActive) ...[
                              const SizedBox(width: 6),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 1.5,
                                ),
                                decoration: BoxDecoration(
                                  color: colors.selected,
                                  borderRadius: BorderRadius.circular(5),
                                ),
                                child: Text(
                                  '当前',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w500,
                                    color: colors.foreground,
                                    locale: const Locale('zh', 'CN'),
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _statusSubtitle(context),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            color: entry.isRevoked
                                ? colors.error
                                : colors.muted,
                            fontFeatures: const [FontFeature.tabularFigures()],
                            locale: const Locale('zh', 'CN'),
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    key: ValueKey('computer-more-${entry.profile.computerKey}'),
                    tooltip: '更多操作 ${entry.profile.name}',
                    onPressed: disabled ? null : onMore,
                    icon: Icon(
                      Icons.more_horiz_rounded,
                      size: 20,
                      color: colors.muted,
                    ),
                  ),
                ],
              ),
            ),
            Divider(height: 1, thickness: 1, color: colors.divider),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 9, 14, 10),
              child: entry.isRevoked
                  ? Row(
                      children: [
                        Expanded(
                          child: Text(
                            '已在电脑端移除，需重新扫码',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              color: colors.muted,
                              locale: const Locale('zh', 'CN'),
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: onRescan,
                          style: TextButton.styleFrom(
                            foregroundColor: colors.foreground,
                            minimumSize: const Size(0, 30),
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          child: const Text(
                            '重新扫码',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                              locale: Locale('zh', 'CN'),
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: onRemove,
                          style: TextButton.styleFrom(
                            foregroundColor: colors.error,
                            minimumSize: const Size(0, 30),
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          child: const Text(
                            '移除',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                              locale: Locale('zh', 'CN'),
                            ),
                          ),
                        ),
                      ],
                    )
                  : Row(
                      children: [
                        Expanded(
                          child: entry.summary == null
                              ? Text(
                                  entry.syncState ==
                                          ComputerSummarySyncState.syncing
                                      ? '正在获取会话摘要…'
                                      : '暂无缓存摘要',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: colors.faint,
                                    locale: const Locale('zh', 'CN'),
                                  ),
                                )
                              : _ComputerCountsRow(
                                  colors: colors,
                                  counts: counts,
                                ),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ComputerCountsRow extends StatelessWidget {
  const _ComputerCountsRow({required this.colors, required this.counts});

  final PigcodeColors colors;
  final MobileSummaryCounts counts;

  @override
  Widget build(BuildContext context) {
    final segments = <(String, Color, FontWeight)>[
      if (counts.attention > 0)
        ('${counts.attention} 待处理', colors.attention, FontWeight.w500),
      if (counts.error > 0)
        ('${counts.error} 出错', colors.error, FontWeight.w500),
      if (counts.unread > 0)
        ('${counts.unread} 未读', colors.foreground, FontWeight.w500),
      if (counts.working > 0)
        ('${counts.working} 进行中', colors.running, FontWeight.w500),
    ];
    if (segments.isEmpty) {
      return Text(
        counts.total > 0 ? '暂无待办 · ${counts.total} 个会话' : '暂无会话',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 12,
          color: colors.muted,
          fontFeatures: const [FontFeature.tabularFigures()],
          locale: const Locale('zh', 'CN'),
        ),
      );
    }
    return Wrap(
      spacing: 10,
      runSpacing: 2,
      children: [
        for (final (text, color, weight) in segments)
          Text(
            text,
            style: TextStyle(
              fontSize: 12,
              fontWeight: weight,
              color: color,
              fontFeatures: const [FontFeature.tabularFigures()],
              locale: const Locale('zh', 'CN'),
            ),
          ),
      ],
    );
  }
}

class _EmptyOnboardingCard extends StatelessWidget {
  const _EmptyOnboardingCard({
    required this.colors,
    required this.working,
    required this.onScan,
  });

  final PigcodeColors colors;
  final bool working;
  final VoidCallback onScan;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: colors.border, width: 1),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: colors.field,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Center(
                child: IconTheme(
                  data: IconThemeData(color: colors.foreground),
                  child: const WorkspaceIcon(WorkspaceGlyph.laptop, size: 26),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              '连接你的电脑',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
                color: colors.foreground,
                locale: const Locale('zh', 'CN'),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '在电脑端打开「设置 → 手机连接」生成二维码，用手机扫码即可随时查看会话、处理审批与远程操作。',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 14,
                height: 1.5,
                color: colors.muted,
                locale: const Locale('zh', 'CN'),
              ),
            ),
            const SizedBox(height: 22),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                key: ComputersHub.scanButtonKey,
                onPressed: working ? null : onScan,
                style: FilledButton.styleFrom(
                  backgroundColor: colors.primary,
                  foregroundColor: colors.onPrimary,
                  minimumSize: const Size(0, 50),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                icon: const Icon(Icons.qr_code_scanner_rounded, size: 19),
                label: const Text(
                  '扫码配对电脑',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    locale: Locale('zh', 'CN'),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _VerificationCard extends StatelessWidget {
  const _VerificationCard({
    required this.colors,
    required this.code,
    required this.updatingRelay,
  });

  final PigcodeColors colors;
  final String code;
  final bool updatingRelay;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.strongBorder, width: 1.5),
      ),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Semantics(
          liveRegion: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                updatingRelay ? '核对两端数字，在电脑确认更新中继' : '核对两端数字，在电脑点允许',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: colors.secondaryText,
                  locale: const Locale('zh', 'CN'),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                code,
                style: TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 3,
                  color: colors.foreground,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FeedbackBanner extends StatelessWidget {
  const _FeedbackBanner({
    required this.colors,
    required this.message,
    this.onDismiss,
  });

  final PigcodeColors colors;
  final String message;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Material(
        color: colors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: colors.border, width: 1),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  message,
                  style: TextStyle(
                    fontSize: 13.5,
                    height: 1.4,
                    color: colors.foreground,
                    locale: const Locale('zh', 'CN'),
                  ),
                ),
              ),
              if (onDismiss != null)
                IconButton(
                  tooltip: '关闭提示',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints.tightFor(
                    width: 32,
                    height: 32,
                  ),
                  onPressed: onDismiss,
                  icon: IconTheme(
                    data: IconThemeData(color: colors.muted),
                    child: const WorkspaceIcon(WorkspaceGlyph.close, size: 15),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

String _formatChineseStamp(DateTime local) {
  final now = DateTime.now();
  final h = local.hour.toString().padLeft(2, '0');
  final m = local.minute.toString().padLeft(2, '0');
  final time = '$h:$m';
  if (DateUtils.isSameDay(local, now)) return time;
  final yesterday = now.subtract(const Duration(days: 1));
  if (DateUtils.isSameDay(local, yesterday)) return '昨天 $time';
  return '${local.month}月${local.day}日 $time';
}

String _relativeIsoTime(String iso) {
  final parsed = DateTime.tryParse(iso)?.toLocal();
  if (parsed == null) return '';
  final now = DateTime.now();
  final diff = now.difference(parsed);
  if (diff.inMinutes < 1) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (DateUtils.isSameDay(parsed, now)) {
    final h = parsed.hour.toString().padLeft(2, '0');
    final m = parsed.minute.toString().padLeft(2, '0');
    return '$h:$m';
  }
  final yesterday = now.subtract(const Duration(days: 1));
  if (DateUtils.isSameDay(parsed, yesterday)) return '昨天';
  if (diff.inDays < 7) return '${diff.inDays} 天前';
  return '${parsed.month}月${parsed.day}日';
}
