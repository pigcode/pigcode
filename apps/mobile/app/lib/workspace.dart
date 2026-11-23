import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'new_thread_draft.dart';
import 'offline_cache.dart';
import 'sidebar_menu.dart';
import 'theme_colors.dart';
import 'thread_status.dart';
import 'timeline_pane.dart';

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
    this.onVisibleThread,
    this.presented = true,
  });

  final MobileConnection? connection;
  final ComputerProfile? computer;
  final String? deviceId;
  final ComputerOfflineCache? cache;
  final MobileReminder? openReminder;
  final ValueChanged<String?>? onVisibleThread;
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
  bool _loadingCache = false;

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
      openReminder: widget.openReminder,
      onVisibleThread: widget.onVisibleThread,
      presented: widget.presented,
      sidebarCommands: online && connection?.supportsSidebarCommands == true
          ? connection!.sidebarCommands
          : null,
      draft: draftLink != null || localDrafts
          ? (projectId, fallbackProjectId, onAccepted) => NewThreadDraft(
              connection: draftLink,
              computerKey: computer?.computerKey,
              deviceId: widget.deviceId,
              projects: _lastSidebar?.projects ?? const [],
              online: draftLink != null,
              projectId: projectId,
              fallbackProjectId: fallbackProjectId,
              onAccepted: onAccepted,
            )
          : null,
      timeline: (thread, online, onSynced, presentation) => TimelinePane(
        key: ValueKey(thread.id),
        connection: online ? connection : null,
        threadId: thread.id,
        online: online,
        cache: widget.cache,
        computerKey: computer?.computerKey,
        onSynced: onSynced,
        onRunChangesChanged: presentation.onRunChangesChanged,
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
    this.onVisibleThread,
    this.presented = true,
    this.sidebarCommands,
  });

  final SidebarSnapshot? snapshot;
  final bool online;
  final bool loadingCache;
  final bool offlineDraftAvailable;
  final MobileReminder? openReminder;
  final ValueChanged<String?>? onVisibleThread;
  final bool presented;
  final MobileSidebarCommands? sidebarCommands;
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
  )?
  draft;
  final VoidCallback onComputers;
  final VoidCallback? onSettings;

  @override
  State<WorkspaceView> createState() => _WorkspaceViewState();
}

class _WorkspaceViewState extends State<WorkspaceView> {
  final _menuFocus = FocusNode();
  final _menuButton = FocusNode();
  String? _threadId;
  MobileThreadSummary? _acceptedThread;
  String? _draftProject;
  bool _draftOpen = false;
  bool _open = false;
  String? _reminderThread;
  bool _reminderUnavailable = false;
  String? _visibleThread;
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

  Widget _header(
    BuildContext context,
    MobileThreadSummary? thread,
    String subtitle, {
    required bool canOpenDraft,
  }) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final hit = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
    final attention =
        widget.online &&
        (widget.snapshot?.threads.any(
              (item) => !item.archived && needsAttention(item),
            ) ??
            false);
    final status = widget.online && !_draftOpen ? thread?.status : null;
    final statusColor = switch (status) {
      MobileThreadStatus.waitingApproval => colors.attention,
      MobileThreadStatus.running || MobileThreadStatus.queued => colors.running,
      MobileThreadStatus.failed => colors.error,
      _ => null,
    };
    final dotColor = switch (status) {
      MobileThreadStatus.running || MobileThreadStatus.queued => colors.running,
      _ when !widget.online => colors.muted,
      _ => null,
    };
    final secondary = _draftOpen && widget.online
        ? widget.computerName
        : statusColor != null
        ? threadStatusText(status!)
        : subtitle;
    final changes = widget.online ? _runChanges : null;
    final fileCount = changes?.fileCount ?? 0;
    final countLabel = changes?.hasMore == true ? '$fileCount+' : '$fileCount';

    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 58),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Row(
          children: [
            Material(
              color: colors.surface,
              shadowColor: colors.scrim,
              elevation: 1,
              shape: CircleBorder(
                side: BorderSide(color: colors.divider, width: .5),
              ),
              child: SizedBox.square(
                dimension: hit,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    Semantics(
                      value: attention ? '有待处理会话' : null,
                      child: IconButton(
                        focusNode: _menuButton,
                        onPressed: () => _menu(true),
                        tooltip: '打开菜单',
                        icon: const Icon(Icons.menu, size: 20),
                      ),
                    ),
                    if (attention)
                      Positioned(
                        right: 9,
                        top: 9,
                        child: IgnorePointer(
                          child: Icon(
                            Icons.circle,
                            color: colors.attention,
                            size: 6,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _draftOpen ? '新会话' : thread?.title ?? '会话',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontSize: 16,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  Row(
                    children: [
                      if (dotColor != null) ...[
                        Icon(Icons.circle, size: 6, color: dotColor),
                        const SizedBox(width: 5),
                      ],
                      Flexible(
                        child: Text(
                          secondary,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            fontSize: 12,
                            color: statusColor ?? colors.muted,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
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
            if (thread != null || _draftOpen || canOpenDraft) ...[
              const SizedBox(width: 10),
              Material(
                color: colors.surface,
                shadowColor: colors.scrim,
                elevation: 1,
                shape: StadiumBorder(
                  side: BorderSide(color: colors.divider, width: .5),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (thread != null && !_draftOpen)
                      Semantics(
                        value: fileCount > 0 ? '$countLabel 个文件' : null,
                        child: IconButton(
                          tooltip: '改动',
                          style: IconButton.styleFrom(
                            minimumSize: Size.square(hit),
                          ),
                          onPressed: changes?.open,
                          icon: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.difference_outlined, size: 20),
                              if (fileCount > 0) ...[
                                const SizedBox(width: 3),
                                Text(
                                  countLabel,
                                  style: theme.textTheme.labelMedium,
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    if (_draftOpen || canOpenDraft)
                      SizedBox.square(
                        dimension: hit,
                        child: IconButton(
                          tooltip: _draftOpen ? '返回会话' : '新会话',
                          onPressed: _draftOpen
                              ? () => setState(() => _draftOpen = false)
                              : () => _openDraft(null),
                          icon: Icon(
                            _draftOpen ? Icons.close : Icons.edit_square,
                            size: 20,
                          ),
                        ),
                      ),
                  ],
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
    final subtitle = !widget.online
        ? widget.connectionLabel ?? '电脑连接已断开'
        : project?.name ?? widget.computerName;
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
        backgroundColor: _open ? colors.window : colors.background,
        body: SafeArea(
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
                                snapshot: widget.snapshot,
                                selectedId: _draftOpen ? null : thread?.id,
                                computerName: widget.computerName,
                                online: widget.online,
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
                            ? [
                                BoxShadow(
                                  color: colors.scrim,
                                  blurRadius: 12,
                                  offset: const Offset(-3, 0),
                                ),
                              ]
                            : null,
                      ),
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          ExcludeSemantics(
                            excluding: _open,
                            child: ExcludeFocus(
                              excluding: _open,
                              child: Column(
                                children: [
                                  _header(
                                    context,
                                    thread,
                                    subtitle,
                                    canOpenDraft: canOpenDraft,
                                  ),
                                  Expanded(
                                    child: _draftOpen && widget.draft != null
                                        ? KeyedSubtree(
                                            key: ValueKey((
                                              'new-thread',
                                              _draftProject,
                                            )),
                                            child: widget.draft!(
                                              _draftProject,
                                              thread?.projectId,
                                              _acceptDraft,
                                            ),
                                          )
                                        : _summary(thread),
                                  ),
                                ],
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
    return ListView(
      key: ValueKey(thread.id),
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 16),
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
