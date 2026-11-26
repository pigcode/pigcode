import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'app_theme.dart';
import 'mobile_glass.dart';
import 'mobile_sheet.dart';
import 'mobile_status_dot.dart';
import 'mobile_surfaces.dart';
import 'new_thread_draft.dart';
import 'offline_cache.dart';
import 'preview/preview_tab.dart';
import 'preview/preview_webview_screen.dart';
import 'share/share_receiver.dart';
import 'sidebar_menu.dart';
import 'theme_colors.dart';
import 'thread_status.dart';
import 'timeline_pane.dart';
import 'workbench/mobile_workbench_screen.dart';
import 'workbench/workbench_utils.dart';
import 'workspace_icon.dart';

/// 顶栏状态胶囊宽度紧凑（上限 118px），把完整提示句压缩成 4~6 字短标签，
/// 避免出现“连不上中继，请...”这类半句截断；完整文案仍保留在会话详情与电脑列表中。
@visibleForTesting
String compactConnectionBadgeLabel(String? connectionLabel) {
  final head = connectionLabel?.split(' · ').first.trim();
  if (head == null || head.isEmpty) return '电脑连接已断开';
  return switch (head) {
    '正在连接电脑…' => '连接中…',
    '正在重新连接电脑…' => '重连中…',
    '电脑上的 Pigcode 已退出' => '电脑已退出',
    '电脑上的 Pigcode 正在重启' => '电脑重启中',
    '连不上中继，请检查网络。' => '连不上中继',
    '这台电脑未连接中继。' => '电脑离线',
    '中继拒绝了访问令牌，请重新扫码。' => '令牌失效',
    '电脑或设备身份验证失败，请检查配对。' => '配对失效',
    '电脑的手机连接已满，请稍后重试。' => '连接已满',
    '请更新 Pigcode 手机端后重新连接。' => '需更新手机端',
    '请更新这台电脑上的 Pigcode 后重新连接。' => '需更新电脑端',
    '连接协议不兼容，请检查两端和中继的版本。' => '版本不兼容',
    '连接已关闭。请确认电脑上的配对未取消。' => '连接已断开',
    '电脑连接已断开' => '电脑连接已断开',
    '正在恢复会话…' => '恢复中…',
    _ => head.split(RegExp(r'[，。]')).first.trim(),
  };
}

typedef _WorkspaceData = ({
  SidebarSnapshot? snapshot,
  bool online,
  String? error,
});

final _workspaceProvider = NotifierProvider.autoDispose
    .family<_WorkspaceController, _WorkspaceData, MobileConnection>(
      _WorkspaceController.new,
    );

class _WorkspaceController extends Notifier<_WorkspaceData> {
  _WorkspaceController(this.connection);
  final MobileConnection connection;
  MobileSidebar? _sidebar;
  StreamSubscription<SidebarSnapshot>? _subscription;
  bool _loading = false;

  @override
  _WorkspaceData build() {
    ref.onDispose(() => unawaited(_subscription?.cancel()));
    unawaited(Future<void>.microtask(refresh));
    unawaited(
      connection.done.then((_) {
        if (ref.mounted) {
          state = (snapshot: state.snapshot, online: false, error: state.error);
        }
      }),
    );
    return (snapshot: null, online: true, error: null);
  }

  Future<void> refresh() async {
    if (!ref.mounted || _loading) return;
    _loading = true;
    state = (snapshot: state.snapshot, online: state.online, error: null);
    try {
      if (_sidebar case final sidebar?) {
        await sidebar.refresh();
        return;
      }
      final sidebar = await connection.openSidebar();
      if (!ref.mounted) return;
      _sidebar = sidebar;
      _subscription = sidebar.updates.listen((snapshot) {
        if (ref.mounted) {
          state = (snapshot: snapshot, online: state.online, error: null);
        }
      }, onError: _failed);
      state = (snapshot: sidebar.snapshot, online: state.online, error: null);
    } catch (error) {
      _failed(error);
    } finally {
      _loading = false;
    }
  }

  void _failed(Object error) {
    if (!ref.mounted) return;
    final message = switch (error) {
      MobileRpcFailure(:final problem) => problem.message,
      ConnectionFailure(code: 'update-desktop') => '请更新电脑上的 Pigcode 后查看会话。',
      _ => '暂时无法读取电脑上的会话。',
    };
    state = (snapshot: state.snapshot, online: state.online, error: message);
  }
}

class MobileWorkspace extends ConsumerStatefulWidget {
  const MobileWorkspace({
    super.key,
    required this.connection,
    required this.connected,
    required this.connectionLabel,
    required this.reconnect,
    required this.onComputers,
    this.onSettings,
    this.computer,
    this.deviceId,
    this.cache,
    this.openReminder,
    this.openShareTarget,
    this.liveShare,
    this.onVisibleThread,
    this.onActiveTargetChanged,
    this.onSidebarChanged,
    this.openExternalUrl,
    this.previewWebViewBuilder,
    this.presented = true,
  });

  final MobileConnection? connection;
  final ComputerProfile? computer;
  final String? deviceId;
  final ComputerOfflineCache? cache;
  final MobileReminder? openReminder;
  final ShareNavigationRequest? openShareTarget;
  final LiveShareInjection? liveShare;
  final ValueChanged<String?>? onVisibleThread;
  final ValueChanged<({String? threadId, bool draftOpen})>?
  onActiveTargetChanged;
  final ValueChanged<SidebarSnapshot?>? onSidebarChanged;
  final ExternalUrlOpener? openExternalUrl;
  final PreviewWebViewBuilder? previewWebViewBuilder;
  final bool presented;
  final bool connected;
  final String connectionLabel;
  final VoidCallback reconnect;
  final VoidCallback onComputers;
  final VoidCallback? onSettings;

  @override
  ConsumerState<MobileWorkspace> createState() => _MobileWorkspaceState();
}

class _MobileWorkspaceState extends ConsumerState<MobileWorkspace> {
  SidebarSnapshot? _lastSidebar;
  SidebarSnapshot? _reportedSidebar;
  final Map<String, List<String>> _timelinePreviewUrls = {};
  bool _loadingCache = false;

  void _reportSidebarIfChanged() {
    if (identical(_reportedSidebar, _lastSidebar) ||
        widget.onSidebarChanged == null) {
      return;
    }
    final snapshot = _lastSidebar;
    _reportedSidebar = snapshot;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && identical(_reportedSidebar, snapshot)) {
        widget.onSidebarChanged?.call(snapshot);
      }
    });
  }

  @override
  void initState() {
    super.initState();
    _restoreSidebar();
  }

  @override
  void didUpdateWidget(covariant MobileWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.cache, widget.cache)) {
      _lastSidebar = null;
      _restoreSidebar();
    }
  }

  void _restoreSidebar() {
    final cache = widget.cache;
    _loadingCache = cache != null;
    if (cache == null) return;
    unawaited(
      cache.readSidebar().catchError((Object _) => null).then((snapshot) {
        if (!mounted || !identical(widget.cache, cache)) return;
        setState(() {
          _lastSidebar ??= snapshot;
          _loadingCache = false;
        });
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final connection = widget.connection;
    final provider = connection == null ? null : _workspaceProvider(connection);
    final data = provider == null ? null : ref.watch(provider);
    final connected = widget.connected && data?.online == true;
    final online = connected && data?.snapshot != null;
    if (online) _lastSidebar = data!.snapshot;
    _reportSidebarIfChanged();
    if (provider != null) {
      ref.listen(provider, (previous, next) {
        final snapshot = next.snapshot;
        final cache = widget.cache;
        if (snapshot != null &&
            cache != null &&
            widget.connected &&
            next.online &&
            !identical(snapshot, previous?.snapshot)) {
          unawaited(cache.saveSidebar(snapshot).catchError((Object _) {}));
        }
      });
    }
    final draftLink = online && connection?.supportsDraftCommands == true
        ? connection
        : null;
    final supportsWorkbench = connectionSupportsWorkbenchRead(connection);
    final supportsPreview = connectionSupportsPreviewTunnel(connection);
    final canOpenWorkbench = online && (supportsWorkbench || supportsPreview);
    final computer = widget.computer;
    final localDrafts = computer != null && widget.deviceId != null;
    return WorkspaceView(
      snapshot: _lastSidebar,
      online: online,
      loadingCache: _loadingCache,
      offlineDraftAvailable: localDrafts,
      connectionLabel: connected && !online
          ? data?.error ?? '正在恢复会话…'
          : widget.connectionLabel,
      computerName: connection?.computerName ?? computer?.name ?? '电脑',
      error: connected ? data?.error : null,
      onRetry: connected
          ? (connection?.supportsSidebar == true && provider != null
                ? () => unawaited(ref.read(provider.notifier).refresh())
                : null)
          : widget.reconnect,
      onComputers: widget.onComputers,
      onSettings: widget.onSettings,
      onOpenWorkbench: canOpenWorkbench
          ? (context, thread) {
              final active = connection;
              if (active == null) return;
              final threadBusy =
                  thread.status == MobileThreadStatus.running ||
                  thread.status == MobileThreadStatus.queued ||
                  thread.status == MobileThreadStatus.waitingApproval;
              unawaited(
                MobileWorkbenchScreen.open(
                  context,
                  connection: active,
                  threadId: thread.id,
                  title: thread.title,
                  threadBusy: threadBusy,
                  initialTab: supportsWorkbench
                      ? MobileWorkbenchTab.files
                      : MobileWorkbenchTab.preview,
                  openExternalUrl: widget.openExternalUrl,
                  previewTabBuilder: supportsPreview
                      ? (_) => PreviewTab(
                            connection: active,
                            threadId: thread.id,
                            computerKey: computer?.computerKey,
                            timelineUrls:
                                _timelinePreviewUrls[thread.id] ?? const [],
                            timelineUrlsProvider: () =>
                                _timelinePreviewUrls[thread.id] ?? const [],
                            openExternalUrl: widget.openExternalUrl,
                            webViewBuilder: widget.previewWebViewBuilder,
                          )
                      : null,
                ),
              );
            }
          : null,
      openReminder: widget.openReminder,
      openShareTarget: widget.openShareTarget,
      onVisibleThread: widget.onVisibleThread,
      onActiveTargetChanged: widget.onActiveTargetChanged,
      presented: widget.presented,
      sidebarCommands: online && connection?.supportsSidebarCommands == true
          ? connection!.sidebarCommands
          : null,
      draft: draftLink != null || localDrafts
          ? (projectId, fallbackProjectId, onAccepted, onProjectNameChanged) =>
                NewThreadDraft(
                  connection: draftLink,
                  computerKey: computer?.computerKey,
                  deviceId: widget.deviceId,
                  projects: _lastSidebar?.projects ?? const [],
                  threads: _lastSidebar?.threads ?? const [],
                  online: draftLink != null,
                  projectId: projectId,
                  fallbackProjectId: fallbackProjectId,
                  onAccepted: onAccepted,
                  onProjectNameChanged: onProjectNameChanged,
                  liveShare: widget.liveShare?.forNewThread == true
                      ? widget.liveShare
                      : null,
                )
          : null,
      timeline: (thread, online, onSynced, presentation) => TimelinePane(
        key: ValueKey(thread.id),
        connection: online ? connection : null,
        threadId: thread.id,
        projectId: thread.projectId,
        projects: _lastSidebar?.projects ?? const [],
        threads: _lastSidebar?.threads ?? const [],
        online: online,
        cache: widget.cache,
        computerKey: computer?.computerKey,
        onSynced: onSynced,
        onRunChangesChanged: presentation.onRunChangesChanged,
        onPreviewUrlsChanged: (urls) {
          _timelinePreviewUrls[thread.id] = urls;
        },
        openExternalUrl: widget.openExternalUrl,
        previewWebViewBuilder: widget.previewWebViewBuilder,
        liveShare:
            widget.liveShare != null &&
                !widget.liveShare!.forNewThread &&
                widget.liveShare!.threadId == thread.id
            ? widget.liveShare
            : null,
        reading: (
          visible: presentation.visible,
          visit: presentation.visit,
          target: thread.readTarget,
          manualUnread: thread.manualUnread,
          unread: thread.unread,
        ),
      ),
    );
  }
}

class WorkspaceView extends StatefulWidget {
  const WorkspaceView({
    super.key,
    required this.snapshot,
    required this.online,
    required this.computerName,
    required this.onComputers,
    this.onSettings,
    this.connectionLabel,
    this.error,
    this.onRetry,
    this.timeline,
    this.draft,
    this.loadingCache = false,
    this.offlineDraftAvailable = false,
    this.openReminder,
    this.openShareTarget,
    this.onVisibleThread,
    this.onActiveTargetChanged,
    this.presented = true,
    this.sidebarCommands,
    this.onOpenWorkbench,
  });

  final SidebarSnapshot? snapshot;
  final bool online;
  final bool loadingCache;
  final bool offlineDraftAvailable;
  final MobileReminder? openReminder;
  final ShareNavigationRequest? openShareTarget;
  final ValueChanged<String?>? onVisibleThread;
  final ValueChanged<({String? threadId, bool draftOpen})>?
  onActiveTargetChanged;
  final bool presented;
  final MobileSidebarCommands? sidebarCommands;
  final void Function(BuildContext context, MobileThreadSummary thread)?
  onOpenWorkbench;
  final String computerName;
  final String? connectionLabel;
  final String? error;
  final VoidCallback? onRetry;
  final Widget Function(
    MobileThreadSummary thread,
    bool online,
    ValueChanged<bool> onSynced,
    ({
      bool visible,
      int visit,
      ValueChanged<RunChangesShortcut?> onRunChangesChanged,
    })
    presentation,
  )?
  timeline;
  final Widget Function(
    String? projectId,
    String? fallbackProjectId,
    ValueChanged<MobileDraftReceipt> onAccepted,
    ValueChanged<String?> onProjectNameChanged,
  )?
  draft;
  final VoidCallback onComputers;
  final VoidCallback? onSettings;

  @override
  State<WorkspaceView> createState() => _WorkspaceViewState();
}

enum _HeaderThreadAction { pin, read, archive }

class _WorkspaceViewState extends State<WorkspaceView> {
  final _menuFocus = FocusNode();
  final _menuButton = FocusNode();
  String? _threadId;
  MobileThreadSummary? _acceptedThread;
  String? _draftProject;
  bool _draftOpen = false;
  bool _open = false;
  bool _updatingThread = false;
  String? _reminderThread;
  bool _reminderUnavailable = false;
  String? _visibleThread;
  ({String? threadId, bool draftOpen})? _reportedActiveTarget;
  String? _syncedThread;
  RunChangesShortcut? _runChanges;
  int _visit = 0;

  MobileThreadSummary? get _thread =>
      widget.snapshot?.threads
          .where(
            (item) =>
                item.id == _threadId &&
                (_reminderThread == null || !item.archived),
          )
          .firstOrNull ??
      (_acceptedThread?.id == _threadId ? _acceptedThread : null);

  @override
  void initState() {
    super.initState();
    _openNotification(widget.openReminder);
    _applyShareTarget(widget.openShareTarget);
    _selectRecentIfNeeded();
  }

  @override
  void didUpdateWidget(covariant WorkspaceView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.presented && !oldWidget.presented) _visit++;
    if (!widget.online) {
      _syncedThread = null;
      _runChanges = null;
    }
    if (!identical(oldWidget.openReminder, widget.openReminder)) {
      _openNotification(widget.openReminder);
      _selectRecentIfNeeded();
    }
    if (oldWidget.openShareTarget?.id != widget.openShareTarget?.id) {
      _applyShareTarget(widget.openShareTarget);
      _selectRecentIfNeeded();
    }
    if (oldWidget.snapshot != widget.snapshot) {
      if (widget.snapshot?.threads.any(
            (thread) => thread.id == _acceptedThread?.id,
          ) ==
          true) {
        _acceptedThread = null;
      }
      _selectRecentIfNeeded();
    }
    if (_reminderThread != null && widget.online) {
      _reminderUnavailable = _thread == null;
      if (!_reminderUnavailable) _reminderThread = null;
    }
  }

  void _applyShareTarget(ShareNavigationRequest? request) {
    if (request == null) return;
    _reminderThread = null;
    _reminderUnavailable = false;
    _open = false;
    if (request.openDraft) {
      _draftOpen = true;
      _draftProject = null;
      _syncedThread = null;
      _runChanges = null;
    } else if (request.threadId case final id?) {
      _draftOpen = false;
      _acceptedThread = null;
      _visit++;
      _selectThread(id);
    }
  }

  void _openNotification(MobileReminder? reminder) {
    _reminderThread = reminder?.threadId;
    _reminderUnavailable = false;
    if (reminder == null) return;
    _visit++;
    _selectThread(reminder.threadId);
    _acceptedThread = null;
    _draftOpen = false;
    _open = false;
    if (widget.online) {
      _reminderUnavailable = _thread == null;
      if (!_reminderUnavailable) _reminderThread = null;
    }
  }

  void _reportVisible(String? id) {
    if (_visibleThread == id || widget.onVisibleThread == null) return;
    _visibleThread = id;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _visibleThread == id) widget.onVisibleThread?.call(id);
    });
  }

  void _updateVisibleThread() {
    final id = _thread?.id;
    _reportVisible(
      widget.online && !_open && !_draftOpen && _syncedThread == id ? id : null,
    );
    final activeTarget = (
      threadId: _draftOpen ? null : (id ?? _threadId),
      draftOpen: _draftOpen,
    );
    if (_reportedActiveTarget != activeTarget &&
        widget.onActiveTargetChanged != null) {
      _reportedActiveTarget = activeTarget;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _reportedActiveTarget == activeTarget) {
          widget.onActiveTargetChanged?.call(activeTarget);
        }
      });
    }
  }

  void _selectThread(String? id) {
    if (_threadId != id) {
      _syncedThread = null;
      _runChanges = null;
    }
    _threadId = id;
  }

  void _openDraft(String? projectId) {
    setState(() {
      _reminderThread = null;
      _reminderUnavailable = false;
      _draftOpen = true;
      _draftProject = projectId;
      _syncedThread = null;
      _runChanges = null;
    });
    if (_open) _menu(false);
  }

  void _acceptDraft(MobileDraftReceipt receipt) {
    setState(() {
      _draftOpen = false;
      _selectThread(receipt.threadId);
      // A receipt can arrive before the sidebar publishes the new thread.
      _acceptedThread =
          widget.snapshot?.threads.any(
                (thread) => thread.id == receipt.threadId,
              ) ==
              true
          ? null
          : MobileThreadSummary(
              id: receipt.threadId,
              projectId: receipt.projectId,
              title: receipt.title,
              updatedAt: DateTime.now().toUtc().toIso8601String(),
              archived: false,
              pinned: false,
              status: MobileThreadStatus.queued,
              unread: false,
            );
    });
  }

  void _selectRecentIfNeeded() {
    if (_thread == null && _reminderThread == null) {
      _selectThread(
        widget.snapshot?.threads
            .where((item) => !item.archived)
            .firstOrNull
            ?.id,
      );
    }
  }

  void _menu(bool open) {
    setState(() => _open = open);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _open == open) {
        (open ? _menuFocus : _menuButton).requestFocus();
      }
    });
  }

  @override
  void dispose() {
    _menuFocus.dispose();
    _menuButton.dispose();
    super.dispose();
  }

  Widget _headerControl(
    BuildContext context,
    double visualInset,
    Widget child,
  ) {
    return Padding(
      padding: EdgeInsets.all(visualInset),
      child: MobileGlassSurface(
        blurSigma: 16,
        child: Material(
          type: MaterialType.transparency,
          shape: const StadiumBorder(),
          child: child,
        ),
      ),
    );
  }

  Future<void> _runThreadAction(
    Future<void> Function(MobileSidebarCommands) change,
  ) async {
    final commands = widget.sidebarCommands;
    if (!widget.online || commands == null || _updatingThread) return;
    setState(() => _updatingThread = true);
    try {
      await change(commands);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('暂时无法更新会话，请重试。')));
      }
    } finally {
      if (mounted) setState(() => _updatingThread = false);
    }
  }

  Future<void> _showThreadSheet(
    MobileThreadSummary thread, {
    required String? projectName,
  }) async {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final canEdit =
        widget.online && widget.sidebarCommands != null && !_updatingThread;
    final actions = canEdit
        ? [
            if (!thread.archived)
              (
                thread.pinned ? WorkspaceGlyph.pinOff : WorkspaceGlyph.pin,
                thread.pinned ? '取消置顶' : '置顶',
                _HeaderThreadAction.pin,
              ),
            if (thread.readTarget != null)
              (
                thread.unread ? WorkspaceGlyph.mailOpen : WorkspaceGlyph.mail,
                thread.unread ? '标为已读' : '标为未读',
                _HeaderThreadAction.read,
              ),
            (
              thread.archived
                  ? WorkspaceGlyph.archiveRestore
                  : WorkspaceGlyph.archive,
              thread.archived ? '取消归档' : '归档',
              _HeaderThreadAction.archive,
            ),
          ]
        : const <(WorkspaceGlyph, String, _HeaderThreadAction)>[];
    final metaParts = <String>[
      if (projectName != null && projectName.isNotEmpty) projectName,
      if (thread.agentName case final agent? when agent.isNotEmpty) agent,
      if (!widget.online)
        widget.connectionLabel ?? '电脑连接已断开'
      else if (thread.status == MobileThreadStatus.waitingApproval)
        waitingThreadLabel(thread)
      else if (thread.status == MobileThreadStatus.running)
        '生成中'
      else if (thread.status == MobileThreadStatus.queued ||
          thread.status == MobileThreadStatus.failed)
        threadStatusText(thread.status),
    ];

    final action = await showMobileSheet<_HeaderThreadAction>(
      context,
      title: thread.title,
      content: (sheet) => SliverList(
        delegate: SliverChildListDelegate([
          if (metaParts.isNotEmpty)
            Padding(
              padding: EdgeInsets.only(bottom: actions.isNotEmpty ? 12 : 0),
              child: Text(
                metaParts.join(' · '),
                style: theme.textTheme.bodySmall?.copyWith(
                  fontSize: 13,
                  color: colors.muted,
                  height: 1.45,
                  leadingDistribution: TextLeadingDistribution.even,
                ),
              ),
            ),
          for (var i = 0; i < actions.length; i++)
            MobileSheetAction(
              glyph: actions[i].$1,
              label: actions[i].$2,
              dividerAbove: i > 0 || metaParts.isNotEmpty,
              onTap: () => Navigator.pop(sheet, actions[i].$3),
            ),
        ]),
      ),
    );
    if (action == null || !mounted) return;
    await _runThreadAction(
      (commands) => switch (action) {
        _HeaderThreadAction.pin => commands.setPinned(thread.id, !thread.pinned),
        _HeaderThreadAction.read => commands.markRead(thread.id, thread.unread),
        _HeaderThreadAction.archive => commands.archive(
          thread.id,
          !thread.archived,
        ),
      },
    );
  }

  Widget _headerStatusBadge(
    BuildContext context, {
    required String label,
    required Color background,
    required Color foreground,
    Color? dotColor,
  }) {
    final theme = Theme.of(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 118),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            spacing: 4,
            children: [
              if (dotColor != null) MobileStatusDot(color: dotColor),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                    color: foreground,
                    height: 1.25,
                    leadingDistribution: TextLeadingDistribution.even,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(
    BuildContext context,
    MobileThreadSummary? thread, {
    required String? projectName,
    required bool canOpenDraft,
  }) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final hit = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
    final visualInset = (hit - 44) / 2;
    final attention =
        widget.online &&
        (widget.snapshot?.threads.any(
              (item) => !item.archived && needsAttention(item),
            ) ??
            false);
    final status = widget.online && !_draftOpen ? thread?.status : null;
    final changes = widget.online && !_draftOpen && thread != null
        ? _runChanges
        : null;
    final fileCount = changes?.fileCount ?? 0;
    final countLabel = changes?.hasMore == true ? '$fileCount+' : '$fileCount';

    final Widget? statusBadge;
    if (!widget.online) {
      final badge = _headerStatusBadge(
        context,
        label: compactConnectionBadgeLabel(widget.connectionLabel),
        background: colors.field,
        foreground: colors.muted,
        dotColor: colors.faint,
      );
      statusBadge = widget.onRetry == null
          ? badge
          : GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onRetry,
              child: badge,
            );
    } else if (status == MobileThreadStatus.waitingApproval && thread != null) {
      statusBadge = _headerStatusBadge(
        context,
        label: waitingThreadLabel(thread),
        background: colors.attentionTint,
        foreground: colors.attention,
      );
    } else if (status == MobileThreadStatus.failed) {
      statusBadge = _headerStatusBadge(
        context,
        label: threadStatusText(status!),
        background: colors.errorTint,
        foreground: colors.error,
      );
    } else if (status == MobileThreadStatus.queued) {
      statusBadge = _headerStatusBadge(
        context,
        label: threadStatusText(status!),
        background: colors.field,
        foreground: colors.running,
        dotColor: colors.running,
      );
    } else {
      statusBadge = null;
    }

    final titleText = _draftOpen ? '新会话' : thread?.title ?? '会话';
    final canOpenThreadSheet = !_draftOpen && thread != null;
    final titleRow = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (status == MobileThreadStatus.running) ...[
          Semantics(
            label: '生成中',
            child: TickerMode(
              enabled: widget.presented && !_open,
              child: MobileRunningDotMatrix(color: colors.statusAccent),
            ),
          ),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Text(
            titleText,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.titleMedium?.copyWith(
              fontSize: 16,
              fontWeight: FontWeight.w500,
              height: 1.45,
              leadingDistribution: TextLeadingDistribution.even,
            ),
          ),
        ),
        if (canOpenThreadSheet) ...[
          const SizedBox(width: 4),
          IconTheme(
            data: IconThemeData(color: colors.faint),
            child: const WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 12),
          ),
        ],
        if (statusBadge != null) ...[
          const SizedBox(width: 6),
          statusBadge,
        ],
      ],
    );

    final showChanges = changes != null;
    final showWorkbench =
        widget.online &&
        !_draftOpen &&
        thread != null &&
        widget.onOpenWorkbench != null;
    final showRightAction = _draftOpen || canOpenDraft;
    final rightActionCount =
        (showChanges ? 1 : 0) +
        (showWorkbench ? 1 : 0) +
        (showRightAction ? 1 : 0);
    final hasRightControl = rightActionCount > 0;

    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 54),
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: 12 - visualInset,
          vertical: 5 - visualInset,
        ),
        child: Row(
          children: [
            _headerControl(
              context,
              visualInset,
              SizedBox.square(
                dimension: hit - visualInset * 2,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    Semantics(
                      value: attention ? '有待处理会话' : null,
                      child: IconButton(
                        focusNode: _menuButton,
                        padding: EdgeInsets.zero,
                        onPressed: () => _menu(true),
                        tooltip: '打开菜单',
                        color: colors.foreground,
                        icon: const WorkspaceIcon(WorkspaceGlyph.menu),
                      ),
                    ),
                    if (attention)
                      Positioned(
                        right: 8,
                        top: 9,
                        child: IgnorePointer(
                          child: Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: colors.attentionMark,
                              border: Border.all(
                                color: colors.surface,
                                width: 1.5,
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: _headerControl(
                  context,
                  visualInset,
                  canOpenThreadSheet
                      ? Tooltip(
                          message: '会话详情',
                          child: Semantics(
                            button: true,
                            child: InkWell(
                              borderRadius: BorderRadius.circular(999),
                              onTap: () => _showThreadSheet(
                                thread,
                                projectName: projectName,
                              ),
                              child: SizedBox(
                                height: hit - visualInset * 2,
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 13,
                                  ),
                                  child: titleRow,
                                ),
                              ),
                            ),
                          ),
                        )
                      : SizedBox(
                          height: hit - visualInset * 2,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 13),
                            child: titleRow,
                          ),
                        ),
                ),
              ),
            ),
            if (!widget.online &&
                widget.error != null &&
                widget.onRetry != null &&
                thread != null)
              IconButton(
                tooltip: '重试读取会话',
                onPressed: widget.onRetry,
                icon: const Icon(Icons.refresh, size: 20),
              ),
            if (hasRightControl) ...[
              const SizedBox(width: 8),
              _headerControl(
                context,
                visualInset,
                Padding(
                  padding: EdgeInsets.symmetric(
                    horizontal: rightActionCount > 1 ? 2 : 0,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (showChanges)
                        Semantics(
                          value: fileCount > 0 ? '$countLabel 个文件' : null,
                          child: IconButton(
                            tooltip: '改动',
                            style: IconButton.styleFrom(
                              minimumSize: Size.square(hit - visualInset * 2),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            onPressed: changes.open,
                            color: colors.foreground,
                            disabledColor: colors.faint,
                            icon: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const WorkspaceIcon(
                                  WorkspaceGlyph.changes,
                                  size: 18,
                                ),
                                if (fileCount > 0) ...[
                                  const SizedBox(width: 3),
                                  Text(
                                    countLabel,
                                    style: theme.textTheme.bodySmall?.copyWith(
                                      fontSize: 13,
                                      height: 1.45,
                                      fontFeatures: const [
                                        FontFeature.tabularFigures(),
                                      ],
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ),
                      if (showWorkbench)
                        SizedBox.square(
                          dimension: hit - visualInset * 2,
                          child: IconButton(
                            key: const ValueKey('workspace-workbench-button'),
                            tooltip: '工作台',
                            padding: EdgeInsets.zero,
                            style: IconButton.styleFrom(
                              minimumSize: Size.square(hit - visualInset * 2),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            onPressed: () =>
                                widget.onOpenWorkbench!(context, thread),
                            color: colors.foreground,
                            icon: const WorkspaceIcon(
                              WorkspaceGlyph.folder,
                              size: 18,
                            ),
                          ),
                        ),
                      if (showRightAction)
                        SizedBox.square(
                          dimension: hit - visualInset * 2,
                          child: IconButton(
                            tooltip: _draftOpen ? '返回会话' : '新会话',
                            padding: EdgeInsets.zero,
                            onPressed: _draftOpen
                                ? () => setState(() => _draftOpen = false)
                                : () => _openDraft(null),
                            color: colors.foreground,
                            icon: WorkspaceIcon(
                              _draftOpen
                                  ? WorkspaceGlyph.close
                                  : WorkspaceGlyph.compose,
                              size: 18,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : const Duration(milliseconds: 320);
    const curve = Cubic(.2, .7, .2, 1);
    final thread = _thread;
    _updateVisibleThread();
    final project = widget.snapshot?.projects
        .where((item) => item.id == thread?.projectId)
        .firstOrNull;
    final edge = BorderRadius.horizontal(left: Radius.circular(_open ? 34 : 0));
    final canOpenDraft =
        widget.draft != null &&
        (widget.snapshot?.projects.isNotEmpty == true ||
            widget.offlineDraftAvailable);

    return PopScope(
      canPop: !_open && !_draftOpen,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (_open) {
          _menu(false);
        } else if (_draftOpen) {
          setState(() => _draftOpen = false);
        }
      },
      child: Scaffold(
        backgroundColor: colors.window,
        body: AnnotatedRegion(
          value: pigcodeSystemOverlay(theme.brightness),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final width = constraints.maxWidth * .84;
              return Stack(
                fit: StackFit.expand,
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: SizedBox(
                      width: width,
                      child: ExcludeSemantics(
                        excluding: !_open,
                        child: ExcludeFocus(
                          excluding: !_open,
                          child: IgnorePointer(
                            ignoring: !_open,
                            child: TickerMode(
                              enabled: _open,
                              child: SidebarMenu(
                                active: _open,
                                snapshot: widget.snapshot,
                                selectedId: _draftOpen ? null : thread?.id,
                                computerName: widget.computerName,
                                online: widget.online,
                                connectionLabel: widget.connectionLabel,
                                commands: widget.sidebarCommands,
                                focusNode: _menuFocus,
                                onSelect: (id) {
                                  _reminderThread = null;
                                  _reminderUnavailable = false;
                                  _draftOpen = false;
                                  _visit++;
                                  _selectThread(id);
                                  _menu(false);
                                },
                                onNewThread: canOpenDraft ? _openDraft : null,
                                onSettings: widget.onSettings,
                                onComputers: () {
                                  _menu(false);
                                  widget.onComputers();
                                },
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  AnimatedPositioned(
                    duration: duration,
                    curve: curve,
                    top: 0,
                    bottom: 0,
                    left: _open ? width : 0,
                    right: _open ? -width : 0,
                    child: AnimatedContainer(
                      duration: duration,
                      curve: curve,
                      clipBehavior: Clip.antiAlias,
                      decoration: BoxDecoration(
                        color: colors.background,
                        borderRadius: edge,
                        boxShadow: _open
                            ? [mobileDrawerShadow(theme.brightness)]
                            : null,
                      ),
                      child: Builder(
                        builder: (context) {
                          final topPadding = MediaQuery.paddingOf(context).top;
                          const headerHeight = 54.0;
                          final topInset = topPadding + headerHeight;
                          final body = _draftOpen && widget.draft != null
                              ? KeyedSubtree(
                                  key: ValueKey(('new-thread', _draftProject)),
                                  child: widget.draft!(
                                    _draftProject,
                                    thread?.projectId,
                                    _acceptDraft,
                                    (_) {},
                                  ),
                                )
                              : _summary(thread);
                          return Stack(
                            fit: StackFit.expand,
                            children: [
                              ExcludeSemantics(
                                excluding: _open,
                                child: ExcludeFocus(
                                  excluding: _open,
                                  child: MobileChromeInsets(
                                    topInset: topInset,
                                    child: Stack(
                                      fit: StackFit.expand,
                                      children: [
                                        Positioned.fill(child: body),
                                        Positioned(
                                          top: 0,
                                          left: 0,
                                          right: 0,
                                          child: MobileTopGlassVeil(
                                            height: topInset + 16,
                                          ),
                                        ),
                                        Positioned(
                                          top: 0,
                                          left: 0,
                                          right: 0,
                                          child: SafeArea(
                                            bottom: false,
                                            child: _header(
                                              context,
                                              thread,
                                              projectName: project?.name,
                                              canOpenDraft: canOpenDraft,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              if (_open)
                                Semantics(
                                  button: true,
                                  label: '收起菜单',
                                  child: GestureDetector(
                                    behavior: HitTestBehavior.opaque,
                                    onTap: () => _menu(false),
                                  ),
                                ),
                            ],
                          );
                        },
                      ),
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

  Widget _summary(MobileThreadSummary? thread) {
    if (widget.error case final error? when thread == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(error),
              if (widget.onRetry != null)
                TextButton(onPressed: widget.onRetry, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    if (_reminderThread != null && thread == null && !widget.loadingCache) {
      return Center(
        child: Text(_reminderUnavailable ? '通知对应的会话已不可用。' : '连接电脑后打开通知里的会话。'),
      );
    }
    if (widget.snapshot == null) {
      return Center(
        child: widget.online || widget.loadingCache
            ? const CircularProgressIndicator.adaptive()
            : Text(widget.connectionLabel ?? '电脑连接已断开'),
      );
    }
    if (thread == null) {
      return const Center(child: Text('没有已打开的会话'));
    }
    if (widget.timeline case final build?) {
      return build(
        thread,
        widget.online,
        (synced) {
          if (!mounted || _thread?.id != thread.id || _draftOpen) return;
          final id = synced ? thread.id : null;
          if (_syncedThread != id) setState(() => _syncedThread = id);
        },
        (
          visible: widget.presented && !_open && !_draftOpen,
          visit: _visit,
          onRunChangesChanged: (changes) {
            if (!mounted ||
                _thread?.id != thread.id ||
                _draftOpen ||
                !widget.online) {
              return;
            }
            if (_runChanges != changes) setState(() => _runChanges = changes);
          },
        ),
      );
    }
    if (!widget.online) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final topInset = MediaQuery.paddingOf(context).top + 54;
    return ListView(
      key: ValueKey(thread.id),
      padding: EdgeInsets.fromLTRB(16, topInset + 20, 16, 16),
      children: [
        Text(
          threadStatusText(thread.status),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: thread.status == MobileThreadStatus.failed
                ? theme.colorScheme.error
                : theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
