import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'sidebar_menu.dart';
import 'theme_colors.dart';
import 'thread_status.dart';

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

class MobileWorkspace extends ConsumerWidget {
  const MobileWorkspace({
    super.key,
    required this.connection,
    required this.onComputers,
  });

  final MobileConnection connection;
  final VoidCallback onComputers;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = _workspaceProvider(connection);
    final data = ref.watch(provider);
    return WorkspaceView(
      snapshot: data.snapshot,
      online: data.online,
      computerName: connection.computerName,
      error: data.error,
      onRetry: connection.supportsSidebar
          ? () => unawaited(ref.read(provider.notifier).refresh())
          : null,
      onComputers: onComputers,
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
    this.error,
    this.onRetry,
  });

  final SidebarSnapshot? snapshot;
  final bool online;
  final String computerName;
  final String? error;
  final VoidCallback? onRetry;
  final VoidCallback onComputers;

  @override
  State<WorkspaceView> createState() => _WorkspaceViewState();
}

class _WorkspaceViewState extends State<WorkspaceView> {
  final _menuFocus = FocusNode();
  final _menuButton = FocusNode();
  String? _threadId;
  bool _open = false;

  MobileThreadSummary? get _thread => widget.snapshot?.threads
      .where((item) => item.id == _threadId)
      .firstOrNull;

  @override
  void initState() {
    super.initState();
    _selectRecentIfNeeded();
  }

  @override
  void didUpdateWidget(covariant WorkspaceView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.snapshot != widget.snapshot) _selectRecentIfNeeded();
  }

  void _selectRecentIfNeeded() {
    if (_thread == null) {
      _threadId = widget.snapshot?.threads
          .where((item) => !item.archived)
          .firstOrNull
          ?.id;
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
    final project = widget.snapshot?.projects
        .where((item) => item.id == thread?.projectId)
        .firstOrNull;
    final subtitle = !widget.online
        ? '电脑连接已断开'
        : project?.name ?? widget.computerName;
    final edge = BorderRadius.horizontal(left: Radius.circular(_open ? 34 : 0));

    return PopScope(
      canPop: !_open,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && _open) _menu(false);
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
                                selectedId: thread?.id,
                                computerName: widget.computerName,
                                online: widget.online,
                                focusNode: _menuFocus,
                                onSelect: (id) {
                                  _threadId = id;
                                  _menu(false);
                                },
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
                                  ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      minHeight: 58,
                                    ),
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 12,
                                        vertical: 4,
                                      ),
                                      child: Row(
                                        children: [
                                          IconButton(
                                            focusNode: _menuButton,
                                            onPressed: () => _menu(true),
                                            tooltip: '打开菜单',
                                            icon: const Icon(
                                              Icons.menu,
                                              size: 20,
                                            ),
                                          ),
                                          const SizedBox(width: 10),
                                          Expanded(
                                            child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                Text(
                                                  thread?.title ?? '会话',
                                                  maxLines: 2,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                  style: theme
                                                      .textTheme
                                                      .titleMedium
                                                      ?.copyWith(
                                                        fontSize: 16,
                                                        fontWeight:
                                                            FontWeight.w500,
                                                      ),
                                                ),
                                                Text(
                                                  subtitle,
                                                  style: theme
                                                      .textTheme
                                                      .bodySmall
                                                      ?.copyWith(
                                                        fontSize: 12,
                                                        color: colors
                                                            .secondaryText,
                                                      ),
                                                ),
                                              ],
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  Divider(height: 1, color: colors.divider),
                                  Expanded(child: _summary(thread)),
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
    if (widget.error case final error?) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(error),
              if (widget.online && widget.onRetry != null)
                TextButton(onPressed: widget.onRetry, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    if (widget.snapshot == null) {
      return Center(
        child: widget.online
            ? const CircularProgressIndicator.adaptive()
            : const Text('电脑连接已断开'),
      );
    }
    if (thread == null) {
      return const Center(child: Text('没有已打开的会话'));
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
