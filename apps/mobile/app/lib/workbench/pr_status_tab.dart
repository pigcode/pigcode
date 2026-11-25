import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../composer/composer_tokens.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import 'workbench_utils.dart';

/// 工作台「PR」Tab：只读展示当前会话分支的 GitHub Pull Request 状态与快捷外链操作。
class PrStatusTab extends StatefulWidget {
  const PrStatusTab({
    super.key,
    required this.connection,
    required this.threadId,
    this.active = true,
    this.openExternalUrl,
  });

  static const stateBadgeKey = ValueKey('pr-state-badge');
  static const openBrowserButtonKey = ValueKey('pr-open-browser-button');
  static const copyLinkButtonKey = ValueKey('pr-copy-link-button');

  final MobileConnection connection;
  final String threadId;
  final bool active;
  final ExternalUrlOpener? openExternalUrl;

  @override
  State<PrStatusTab> createState() => _PrStatusTabState();
}

class _PrStatusTabState extends State<PrStatusTab> {
  MobilePrStatusResult? _result;
  bool _loading = false;
  bool _hasRequested = false;
  String? _error;
  int _requestSeq = 0;

  @override
  void initState() {
    super.initState();
    if (widget.active) {
      unawaited(_load());
    }
  }

  @override
  void didUpdateWidget(covariant PrStatusTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !_hasRequested) {
      unawaited(_load());
    }
  }

  Future<void> _load() async {
    _hasRequested = true;
    final seq = ++_requestSeq;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await widget.connection.workbench.getPrStatus(
        threadId: widget.threadId,
      );
      if (!mounted || seq != _requestSeq) return;
      setState(() {
        _result = result;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || seq != _requestSeq) return;
      setState(() {
        _loading = false;
        _error = workbenchErrorMessage(
          error,
          fallback: '暂时无法读取 PR 状态，请重试。',
        );
      });
    }
  }

  Future<void> _openInBrowser(String url) async {
    final uri = Uri.tryParse(url);
    final opener = widget.openExternalUrl ?? launchExternalUrl;
    var opened = false;
    if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) {
      try {
        opened = await opener(uri);
      } catch (_) {
        opened = false;
      }
    }
    if (!mounted) return;
    if (!opened) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('无法在外部浏览器打开此链接')),
      );
    }
  }

  Future<void> _copyLink(String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已复制 PR 链接')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (!_hasRequested) {
      return const SizedBox.shrink();
    }

    if (_loading && _result == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    if (_error != null && _result == null) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: 340,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(TimelineSpace.x9),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    spacing: TimelineSpace.x4,
                    children: [
                      Icon(
                        Icons.error_outline_rounded,
                        size: 32,
                        color: colors.muted,
                      ),
                      Text(
                        _error!,
                        textAlign: TextAlign.center,
                        style: TimelineType.contentStyle(colors.muted),
                      ),
                      TextButton(
                        onPressed: () => unawaited(_load()),
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    final result = _result!;
    if (result.status == 'ok' && result.pr != null) {
      return _buildPrDetail(context, result.pr!);
    }
    return _buildNonPrState(context, result);
  }

  Widget _buildPrDetail(BuildContext context, MobilePullRequestInfo pr) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final badge = _prStateBadgeStyle(pr, brightness);
    final review = _reviewDecisionInfo(pr.reviewDecision, brightness);
    final checks = pr.checksSummary;
    final hasDiffStats =
        pr.additions != null || pr.deletions != null || pr.changedFiles != null;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(TimelineSpace.x7),
        children: [
          _PrCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: TimelineSpace.x5,
              children: [
                Row(
                  spacing: TimelineSpace.x4,
                  children: [
                    DecoratedBox(
                      key: PrStatusTab.stateBadgeKey,
                      decoration: BoxDecoration(
                        color: badge.background,
                        borderRadius: BorderRadius.circular(
                          TimelineRadius.full,
                        ),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: TimelineSpace.x5,
                          vertical: TimelineSpace.x2,
                        ),
                        child: Text(
                          badge.label,
                          style: TimelineType.smallStyle(
                            badge.foreground,
                            weight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ),
                    Text(
                      '#${pr.number}',
                      style: TimelineType.metaMonoStyle(colors.muted),
                    ),
                  ],
                ),
                Text(
                  pr.title,
                  style: TimelineType.headingStyle(
                    TimelineType.heading2,
                    FontWeight.w600,
                  ).copyWith(color: colors.foreground),
                ),
                _BranchFlowPill(
                  headRefName: pr.headRefName,
                  baseRefName: pr.baseRefName,
                ),
              ],
            ),
          ),
          if (hasDiffStats) ...[
            const SizedBox(height: TimelineSpace.x6),
            _PrCard(
              child: Row(
                children: [
                  Icon(
                    Icons.difference_outlined,
                    size: TimelineIcon.control,
                    color: colors.muted,
                  ),
                  const SizedBox(width: TimelineSpace.x4),
                  Expanded(
                    child: Wrap(
                      spacing: TimelineSpace.x4,
                      runSpacing: TimelineSpace.x2,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        if (pr.additions != null)
                          Text(
                            '+${pr.additions}',
                            style: TimelineType.diffCountStyle(
                              colors.diffAdded,
                            ).copyWith(fontWeight: FontWeight.w600),
                          ),
                        if (pr.deletions != null)
                          Text(
                            '-${pr.deletions}',
                            style: TimelineType.diffCountStyle(
                              colors.diffRemoved,
                            ).copyWith(fontWeight: FontWeight.w600),
                          ),
                        if (pr.changedFiles != null)
                          Text(
                            '· ${pr.changedFiles} 个文件',
                            style: TimelineType.metaStyle(colors.muted).copyWith(
                              fontFeatures: TimelineType.tabular,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
          if (review != null || checks != null) ...[
            const SizedBox(height: TimelineSpace.x6),
            _PrCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: TimelineSpace.x5,
                children: [
                  if (review != null)
                    Row(
                      spacing: TimelineSpace.x4,
                      children: [
                        Icon(
                          review.icon,
                          size: TimelineIcon.control,
                          color: review.color,
                        ),
                        Text(
                          '代码评审',
                          style: TimelineType.metaStyle(colors.muted),
                        ),
                        const Spacer(),
                        Text(
                          review.label,
                          style: TimelineType.metaStyle(
                            review.color,
                            weight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                  if (review != null && checks != null)
                    Divider(height: 1, thickness: 1, color: colors.divider),
                  if (checks != null) _ChecksSummaryRow(checks: checks),
                ],
              ),
            ),
          ],
          const SizedBox(height: TimelineSpace.x8),
          Row(
            spacing: TimelineSpace.x4,
            children: [
              Expanded(
                child: FilledButton.icon(
                  key: PrStatusTab.openBrowserButtonKey,
                  style: FilledButton.styleFrom(
                    minimumSize: Size(0, touch),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(TimelineRadius.panel),
                    ),
                  ),
                  onPressed: () => unawaited(_openInBrowser(pr.url)),
                  icon: const Icon(Icons.open_in_new_rounded, size: 18),
                  label: const Text('在浏览器打开'),
                ),
              ),
              Expanded(
                child: OutlinedButton.icon(
                  key: PrStatusTab.copyLinkButtonKey,
                  style: OutlinedButton.styleFrom(
                    minimumSize: Size(0, touch),
                    foregroundColor: colors.foreground,
                    side: BorderSide(color: colors.strongBorder),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(TimelineRadius.panel),
                    ),
                  ),
                  onPressed: () => unawaited(_copyLink(pr.url)),
                  icon: const Icon(Icons.copy_rounded, size: 18),
                  label: const Text('复制链接'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildNonPrState(BuildContext context, MobilePrStatusResult result) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final info = _nonPrStatusCopy(result.status, result.branch);

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(TimelineSpace.x7),
        children: [
          const SizedBox(height: TimelineSpace.x9),
          _PrCard(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              spacing: TimelineSpace.x4,
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: colors.field,
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: Icon(info.icon, size: 24, color: colors.secondaryText),
                ),
                Text(
                  info.title,
                  textAlign: TextAlign.center,
                  style: TimelineType.headingStyle(
                    TimelineType.heading3,
                    FontWeight.w600,
                  ).copyWith(color: colors.foreground),
                ),
                if (result.branch case final branch? when branch.isNotEmpty)
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.field,
                      borderRadius: BorderRadius.circular(TimelineRadius.full),
                      border: Border.all(color: colors.border),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: TimelineSpace.x5,
                        vertical: TimelineSpace.x2,
                      ),
                      child: Text(
                        branch,
                        style: TimelineType.metaMonoStyle(colors.foreground),
                      ),
                    ),
                  ),
                Text(
                  info.description,
                  textAlign: TextAlign.center,
                  style: TimelineType.metaStyle(
                    colors.muted,
                    height: TimelineType.noticeHeight,
                  ),
                ),
                const SizedBox(height: TimelineSpace.x2),
                TextButton(
                  onPressed: () => unawaited(_load()),
                  child: const Text('刷新状态'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  ({String label, Color background, Color foreground}) _prStateBadgeStyle(
    MobilePullRequestInfo pr,
    Brightness brightness,
  ) {
    final dark = brightness == Brightness.dark;
    final colors = dark ? pigcodeDark : pigcodeLight;
    final upper = pr.state.toUpperCase();
    if (pr.isDraft == true && upper == 'OPEN') {
      return (
        label: 'DRAFT',
        background: colors.field,
        foreground: colors.muted,
      );
    }
    return switch (upper) {
      'OPEN' => (
        label: 'OPEN',
        background: colors.diffAddedBackground,
        foreground: colors.diffAdded,
      ),
      'MERGED' => (
        label: 'MERGED',
        background: dark ? const Color(0xFF2E2242) : const Color(0xFFF3ECFF),
        foreground: dark ? const Color(0xFFC4A7FF) : const Color(0xFF6F42C1),
      ),
      'CLOSED' => (
        label: 'CLOSED',
        background: colors.errorTint,
        foreground: colors.error,
      ),
      _ => (
        label: upper,
        background: colors.field,
        foreground: colors.secondaryText,
      ),
    };
  }

  ({String label, IconData icon, Color color})? _reviewDecisionInfo(
    String? decision,
    Brightness brightness,
  ) {
    if (decision == null || decision.trim().isEmpty) return null;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    return switch (decision.toUpperCase()) {
      'APPROVED' => (
        label: '已批准',
        icon: Icons.check_circle_outline_rounded,
        color: colors.diffAdded,
      ),
      'CHANGES_REQUESTED' => (
        label: '待修改',
        icon: Icons.edit_note_rounded,
        color: colors.error,
      ),
      'REVIEW_REQUIRED' => (
        label: '待评审',
        icon: Icons.schedule_rounded,
        color: colors.attention,
      ),
      _ => (
        label: decision,
        icon: Icons.rate_review_outlined,
        color: colors.muted,
      ),
    };
  }

  ({IconData icon, String title, String description}) _nonPrStatusCopy(
    String status,
    String? branch,
  ) {
    return switch (status) {
      'no-pr' => (
        icon: Icons.merge_type_rounded,
        title: '尚未创建 PR',
        description: branch != null && branch.isNotEmpty
            ? '当前分支 `$branch` 尚未创建 Pull Request。'
            : '当前分支尚未创建 Pull Request。',
      ),
      'not-git' => (
        icon: Icons.folder_off_outlined,
        title: '当前项目不是 Git 仓库',
        description: '该项目目录未初始化 Git 仓库，无法查询 PR 状态。',
      ),
      'no-remote' => (
        icon: Icons.cloud_off_outlined,
        title: '未配置 GitHub 远端',
        description: '当前仓库未配置 GitHub 远端地址，无法关联 Pull Request。',
      ),
      'gh-unavailable' => (
        icon: Icons.terminal_rounded,
        title: '电脑未安装 GitHub CLI (gh)',
        description: '请先在电脑上安装 GitHub CLI (`gh`) 后再查看 PR 状态。',
      ),
      'gh-unauthenticated' => (
        icon: Icons.lock_outline_rounded,
        title: 'GitHub CLI 尚未登录',
        description: '电脑上的 `gh` 尚未登录，请先在电脑终端运行 `gh auth login`。',
      ),
      _ => (
        icon: Icons.info_outline_rounded,
        title: '暂无 PR 信息',
        description: '当前无法获取该分支的 Pull Request 状态。',
      ),
    };
  }
}

class _PrCard extends StatelessWidget {
  const _PrCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.timelineCard,
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
        border: Border.all(color: colors.timelineBorder),
        boxShadow: TimelineShadow.card,
      ),
      child: Padding(
        padding: const EdgeInsets.all(TimelineSpace.x7),
        child: child,
      ),
    );
  }
}

class _BranchFlowPill extends StatelessWidget {
  const _BranchFlowPill({
    required this.headRefName,
    required this.baseRefName,
  });

  final String headRefName;
  final String baseRefName;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.field,
        borderRadius: BorderRadius.circular(TimelineRadius.block),
        border: Border.all(color: colors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x5,
          vertical: TimelineSpace.x3,
        ),
        child: Wrap(
          spacing: TimelineSpace.x3,
          runSpacing: TimelineSpace.x2,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              headRefName,
              style: TimelineType.metaMonoStyle(colors.foreground),
            ),
            Text('→', style: TimelineType.metaStyle(colors.muted)),
            Text(
              baseRefName,
              style: TimelineType.metaMonoStyle(colors.secondaryText),
            ),
          ],
        ),
      ),
    );
  }
}

class _ChecksSummaryRow extends StatelessWidget {
  const _ChecksSummaryRow({required this.checks});

  final MobilePrChecksSummary checks;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: TimelineSpace.x3,
      children: [
        Row(
          spacing: TimelineSpace.x4,
          children: [
            Icon(
              Icons.verified_outlined,
              size: TimelineIcon.control,
              color: colors.muted,
            ),
            Text('CI 检查', style: TimelineType.metaStyle(colors.muted)),
            const Spacer(),
            Text(
              checks.total == 0 ? '暂无检查' : '共 ${checks.total} 项',
              style: TimelineType.smallStyle(colors.muted).copyWith(
                fontFeatures: TimelineType.tabular,
              ),
            ),
          ],
        ),
        if (checks.total > 0)
          Wrap(
            spacing: TimelineSpace.x3,
            runSpacing: TimelineSpace.x2,
            children: [
              _CheckCountPill(
                label: '${checks.passed} 通过',
                color: colors.diffAdded,
                background: colors.diffAddedBackground,
              ),
              _CheckCountPill(
                label: '${checks.failed} 失败',
                color: colors.error,
                background: colors.errorTint,
              ),
              _CheckCountPill(
                label: '${checks.pending} 运行中',
                color: ComposerSurface.accentText(brightness),
                background: ComposerSurface.accentSoft(brightness),
              ),
            ],
          ),
      ],
    );
  }
}

class _CheckCountPill extends StatelessWidget {
  const _CheckCountPill({
    required this.label,
    required this.color,
    required this.background,
  });

  final String label;
  final Color color;
  final Color background;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(TimelineRadius.full),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x4,
          vertical: TimelineSpace.x2,
        ),
        child: Text(
          label,
          style: TimelineType.smallStyle(color, weight: FontWeight.w500)
              .copyWith(fontFeatures: TimelineType.tabular),
        ),
      ),
    );
  }
}
