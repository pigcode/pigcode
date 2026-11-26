import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../composer/composer_tokens.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/relative_time.dart';
import '../timeline/timeline_tokens.dart';
import 'workbench_utils.dart';

/// 工作台「Git」Tab：集中管理当前会话的 Worktree（切换/新建/移除）与检查点（列表/创建/恢复）。
class GitWorkbenchTab extends StatefulWidget {
  const GitWorkbenchTab({
    super.key,
    required this.connection,
    required this.threadId,
    this.active = true,
    this.revision = 0,
    this.threadBusy = false,
    this.onWorkspaceMutated,
  });

  static const createWorktreeButtonKey = ValueKey('git-create-worktree');
  static const removeWorktreeButtonKey = ValueKey('git-remove-worktree');
  static const createCheckpointButtonKey = ValueKey('git-create-checkpoint');
  static ValueKey<String> switchWorktreeKey(String id) =>
      ValueKey('git-switch-worktree-$id');
  static ValueKey<String> restoreCheckpointKey(String id) =>
      ValueKey('git-restore-checkpoint-$id');

  final MobileConnection connection;
  final String threadId;
  final bool active;
  final int revision;
  final bool threadBusy;
  final VoidCallback? onWorkspaceMutated;

  @override
  State<GitWorkbenchTab> createState() => _GitWorkbenchTabState();
}

class _GitWorkbenchTabState extends State<GitWorkbenchTab> {
  MobileWorktreeListResult? _worktrees;
  MobileCheckpointListResult? _checkpoints;
  bool _loading = false;
  bool _hasRequested = false;
  bool _acting = false;
  String? _error;
  int _requestSeq = 0;

  bool get _canWrite => connectionSupportsWorkbenchWrite(widget.connection);

  @override
  void initState() {
    super.initState();
    if (widget.active && _canWrite) {
      unawaited(_load());
    }
  }

  @override
  void didUpdateWidget(covariant GitWorkbenchTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_canWrite) return;
    if ((widget.active && !_hasRequested) ||
        (oldWidget.revision != widget.revision && _hasRequested) ||
        oldWidget.threadId != widget.threadId) {
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
      final results = await Future.wait<Object>([
        widget.connection.workbenchWrite.listWorktrees(
          threadId: widget.threadId,
        ),
        widget.connection.workbenchWrite.listCheckpoints(
          threadId: widget.threadId,
        ),
      ]);
      if (!mounted || seq != _requestSeq) return;
      setState(() {
        _worktrees = results[0] as MobileWorktreeListResult;
        _checkpoints = results[1] as MobileCheckpointListResult;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || seq != _requestSeq) return;
      setState(() {
        _loading = false;
        _error = workbenchErrorMessage(
          error,
          fallback: '暂时无法读取 Worktree 与检查点信息，请重试。',
        );
      });
    }
  }

  void _showNotice(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _createWorktree() async {
    if (_acting || widget.threadBusy) return;
    setState(() => _acting = true);
    try {
      final created = await widget.connection.workbenchWrite.createWorktree(
        threadId: widget.threadId,
      );
      if (!mounted) return;
      widget.onWorkspaceMutated?.call();
      await _load();
      if (!mounted) return;
      _showNotice('已创建并切换到 ${created.branch ?? created.name}');
    } catch (error) {
      if (!mounted) return;
      _showNotice(workbenchErrorMessage(error, fallback: '创建 Worktree 失败。'));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _switchWorktree(MobileWorktreeItem item) async {
    if (_acting || widget.threadBusy || item.active) return;
    setState(() => _acting = true);
    try {
      await widget.connection.workbenchWrite.switchWorktree(
        threadId: widget.threadId,
        worktreeId: item.id,
      );
      if (!mounted) return;
      widget.onWorkspaceMutated?.call();
      await _load();
      if (!mounted) return;
      _showNotice('已切换到 ${item.branch ?? item.name}');
    } catch (error) {
      if (!mounted) return;
      _showNotice(workbenchErrorMessage(error, fallback: '切换 Worktree 失败。'));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _confirmRemoveWorktree(MobileWorktreeItem item) async {
    if (_acting || widget.threadBusy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final palette = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: const Text('移除当前 Worktree？'),
          content: Text(
            '将强制移除「${item.branch ?? item.name}」对应的工作树目录并切回主工作区，该目录内未提交的改动会丢失。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: palette.error,
                foregroundColor: palette.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('确认移除'),
            ),
          ],
        );
      },
    );
    if (!mounted || confirmed != true) return;
    setState(() => _acting = true);
    try {
      await widget.connection.workbenchWrite.removeWorktree(
        threadId: widget.threadId,
      );
      if (!mounted) return;
      widget.onWorkspaceMutated?.call();
      await _load();
      if (!mounted) return;
      _showNotice('已移除 Worktree 并切回主工作区');
    } catch (error) {
      if (!mounted) return;
      _showNotice(workbenchErrorMessage(error, fallback: '移除 Worktree 失败。'));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _showCreateCheckpointDialog() async {
    if (_acting) return;
    final result = await showDialog<({bool confirmed, String label})>(
      context: context,
      builder: (_) => const _CheckpointLabelDialog(),
    );
    if (!mounted || result == null || !result.confirmed) return;
    setState(() => _acting = true);
    try {
      final label = result.label.trim();
      await widget.connection.workbenchWrite.createCheckpoint(
        threadId: widget.threadId,
        label: label.isEmpty ? null : label,
      );
      if (!mounted) return;
      await _load();
      if (!mounted) return;
      _showNotice('已创建检查点');
    } catch (error) {
      if (!mounted) return;
      _showNotice(workbenchErrorMessage(error, fallback: '创建检查点失败。'));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _confirmRestoreCheckpoint(MobileCheckpointItem item) async {
    if (_acting || widget.threadBusy || !item.restorable) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final palette = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: const Text('恢复到此检查点？'),
          content: const Text(
            '仅恢复工作区文件到该时刻的状态，不会回滚对话记录，Agent 也不会自动得知文件已变化。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: palette.error,
                foregroundColor: palette.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('确认恢复'),
            ),
          ],
        );
      },
    );
    if (!mounted || confirmed != true) return;
    setState(() => _acting = true);
    try {
      final restored = await widget.connection.workbenchWrite.restoreCheckpoint(
        threadId: widget.threadId,
        checkpointId: item.id,
      );
      if (!mounted) return;
      widget.onWorkspaceMutated?.call();
      await _load();
      if (!mounted) return;
      _showNotice('已恢复检查点（影响 ${restored.affectedCount} 个文件）');
    } catch (error) {
      if (!mounted) return;
      _showNotice(workbenchErrorMessage(error, fallback: '恢复检查点失败。'));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  String _phaseLabel(String phase) => switch (phase) {
    'baseline' => '开始前',
    'final' => '结束后',
    'manual' => '手动',
    _ => phase,
  };

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;

    if (!_canWrite) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(TimelineSpace.x9),
          child: Text(
            '请更新电脑上的 Pigcode 后管理 Worktree 与检查点。',
            textAlign: TextAlign.center,
            style: TimelineType.contentStyle(colors.muted),
          ),
        ),
      );
    }

    if (!_hasRequested) {
      return const SizedBox.shrink();
    }

    if (_loading && _worktrees == null && _checkpoints == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    if (_error != null && _worktrees == null && _checkpoints == null) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: 320,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(TimelineSpace.x9),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    spacing: TimelineSpace.x4,
                    children: [
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

    final worktrees = _worktrees?.worktrees ?? const <MobileWorktreeItem>[];
    final mainActive = _worktrees?.mainActive ?? true;
    final checkpoints =
        (_checkpoints?.checkpoints ?? const <MobileCheckpointItem>[])
            .reversed
            .toList(growable: false);

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(
          TimelineSpace.x7,
          TimelineSpace.x7,
          TimelineSpace.x7,
          80,
        ),
        children: [
          if (widget.threadBusy) ...[
            DecoratedBox(
              decoration: BoxDecoration(
                color: colors.attentionTint,
                borderRadius: BorderRadius.circular(TimelineRadius.panel),
                border: Border.all(color: colors.divider),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: TimelineSpace.x6,
                  vertical: TimelineSpace.x4,
                ),
                child: Row(
                  spacing: TimelineSpace.x3,
                  children: [
                    Icon(
                      Icons.info_outline_rounded,
                      size: 18,
                      color: colors.attention,
                    ),
                    Expanded(
                      child: Text(
                        '会话运行中，结束后才可新建/切换/移除 Worktree 或恢复检查点。',
                        style: TimelineType.smallStyle(colors.attention),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: TimelineSpace.x6),
          ],
          _GitCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              spacing: TimelineSpace.x4,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.account_tree_outlined,
                      size: 18,
                      color: colors.muted,
                    ),
                    const SizedBox(width: TimelineSpace.x3),
                    Expanded(
                      child: Text(
                        'Worktree',
                        style: TimelineType.headingStyle(
                          TimelineType.heading3,
                          FontWeight.w600,
                        ).copyWith(color: colors.foreground),
                      ),
                    ),
                    TextButton.icon(
                      key: GitWorkbenchTab.createWorktreeButtonKey,
                      onPressed: (_acting || widget.threadBusy)
                          ? null
                          : () => unawaited(_createWorktree()),
                      icon: const Icon(Icons.add_rounded, size: 18),
                      label: const Text('新建'),
                    ),
                  ],
                ),
                Divider(height: 1, thickness: 1, color: colors.divider),
                Row(
                  spacing: TimelineSpace.x3,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '主工作区',
                            style: TimelineType.contentStyle(
                              colors.foreground,
                              weight: FontWeight.w500,
                            ),
                          ),
                          Text(
                            mainActive ? '当前会话正在项目主目录工作' : '移除活动 Worktree 后切回主工作区',
                            style: TimelineType.smallStyle(colors.muted),
                          ),
                        ],
                      ),
                    ),
                    if (mainActive) _StatusPill(label: '使用中', accent: true),
                  ],
                ),
                for (final item in worktrees) ...[
                  Divider(height: 1, thickness: 1, color: colors.divider),
                  Row(
                    spacing: TimelineSpace.x3,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              item.branch ?? item.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TimelineType.contentStyle(
                                colors.foreground,
                                weight: FontWeight.w500,
                              ),
                            ),
                            if (item.branch != null)
                              Text(
                                item.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TimelineType.smallStyle(colors.muted),
                              ),
                          ],
                        ),
                      ),
                      if (item.active) ...[
                        _StatusPill(label: '使用中', accent: true),
                        TextButton(
                          key: GitWorkbenchTab.removeWorktreeButtonKey,
                          style: TextButton.styleFrom(
                            foregroundColor: colors.error,
                          ),
                          onPressed: (_acting || widget.threadBusy)
                              ? null
                              : () => unawaited(_confirmRemoveWorktree(item)),
                          child: const Text('移除'),
                        ),
                      ] else
                        OutlinedButton(
                          key: GitWorkbenchTab.switchWorktreeKey(item.id),
                          onPressed: (_acting || widget.threadBusy)
                              ? null
                              : () => unawaited(_switchWorktree(item)),
                          child: const Text('切换'),
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: TimelineSpace.x7),
          _GitCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              spacing: TimelineSpace.x4,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.history_rounded,
                      size: 18,
                      color: colors.muted,
                    ),
                    const SizedBox(width: TimelineSpace.x3),
                    Expanded(
                      child: Text(
                        '检查点',
                        style: TimelineType.headingStyle(
                          TimelineType.heading3,
                          FontWeight.w600,
                        ).copyWith(color: colors.foreground),
                      ),
                    ),
                    TextButton.icon(
                      key: GitWorkbenchTab.createCheckpointButtonKey,
                      onPressed: _acting
                          ? null
                          : () => unawaited(_showCreateCheckpointDialog()),
                      icon: const Icon(Icons.add_rounded, size: 18),
                      label: const Text('新建检查点'),
                    ),
                  ],
                ),
                Divider(height: 1, thickness: 1, color: colors.divider),
                if (checkpoints.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: TimelineSpace.x5,
                    ),
                    child: Text(
                      '暂无检查点。Agent 每轮运行前后会自动保存，也可手动创建。',
                      style: TimelineType.metaStyle(colors.muted),
                    ),
                  )
                else
                  for (var i = 0; i < checkpoints.length; i++) ...[
                    if (i > 0)
                      Divider(height: 1, thickness: 1, color: colors.divider),
                    _CheckpointRow(
                      item: checkpoints[i],
                      phaseLabel: _phaseLabel(checkpoints[i].phase),
                      disabled: _acting || widget.threadBusy,
                      onRestore: () =>
                          unawaited(_confirmRestoreCheckpoint(checkpoints[i])),
                    ),
                  ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _GitCard extends StatelessWidget {
  const _GitCard({required this.child});

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

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, this.accent = false});

  final String label;
  final bool accent;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: accent ? ComposerSurface.accentSoft(brightness) : colors.field,
        borderRadius: BorderRadius.circular(TimelineRadius.full),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x4,
          vertical: 2,
        ),
        child: Text(
          label,
          style: TimelineType.microStyle(
            accent ? ComposerSurface.accentText(brightness) : colors.muted,
          ).copyWith(fontWeight: FontWeight.w500),
        ),
      ),
    );
  }
}

class _CheckpointRow extends StatelessWidget {
  const _CheckpointRow({
    required this.item,
    required this.phaseLabel,
    required this.disabled,
    required this.onRestore,
  });

  final MobileCheckpointItem item;
  final String phaseLabel;
  final bool disabled;
  final VoidCallback onRestore;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final relative = timelineRelativeTime(item.createdAt);
    return Row(
      spacing: TimelineSpace.x3,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 4,
            children: [
              Row(
                spacing: TimelineSpace.x3,
                children: [
                  _StatusPill(
                    label: phaseLabel,
                    accent: item.phase == 'manual',
                  ),
                  if (item.label != null && item.label!.isNotEmpty)
                    Flexible(
                      child: Text(
                        item.label!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TimelineType.metaStyle(
                          colors.foreground,
                          weight: FontWeight.w500,
                        ),
                      ),
                    ),
                ],
              ),
              Text(
                relative.isNotEmpty ? relative : item.createdAt,
                style: TimelineType.smallStyle(colors.muted),
              ),
            ],
          ),
        ),
        if (item.restorable)
          OutlinedButton(
            key: GitWorkbenchTab.restoreCheckpointKey(item.id),
            onPressed: disabled ? null : onRestore,
            child: const Text('恢复'),
          ),
      ],
    );
  }
}

class _CheckpointLabelDialog extends StatefulWidget {
  const _CheckpointLabelDialog();

  @override
  State<_CheckpointLabelDialog> createState() => _CheckpointLabelDialogState();
}

class _CheckpointLabelDialogState extends State<_CheckpointLabelDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MobileGlassDialog(
      title: const Text('新建检查点'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(
          labelText: '备注（可选）',
          hintText: '如：重构前快照',
          border: OutlineInputBorder(),
        ),
        onSubmitted: (_) => Navigator.of(
          context,
        ).pop((confirmed: true, label: _controller.text)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(
            context,
          ).pop((confirmed: true, label: _controller.text)),
          child: const Text('创建'),
        ),
      ],
    );
  }
}
