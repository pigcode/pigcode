import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:xterm2/xterm.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workbench/workbench_utils.dart';
import '../workspace_icon.dart';
import 'terminal_shortcut_bar.dart';
import 'terminal_theme.dart';

typedef ClipboardTextReader = Future<String?> Function();

Future<String?> _defaultReadClipboard() async {
  final data = await Clipboard.getData(Clipboard.kTextPlain);
  return data?.text;
}

class _LocalTerminalTab {
  _LocalTerminalTab({
    required this.summary,
    required this.terminal,
    required this.controller,
  });

  MobileTerminalSummary summary;
  final Terminal terminal;
  final TerminalController controller;
  int lastCursor = 0;
  bool exited = false;
  int? exitCode;
  bool attached = false;
  int lastSentCols = 0;
  int lastSentRows = 0;
}

/// 手机端全屏远程终端页：
/// - 顶栏采用统一液态玻璃风格（返回、终端切换胶囊、新建终端）；
/// - 手机自建终端（`origin: mobile`）完整可写/自适应尺寸/带快捷按键栏；
/// - 电脑已有终端（`origin: desktop`）只读附着观看，横向滚动保留桌面列宽，不发 write/resize/close；
/// - 通过 `connectionListenable` 感知断线重连，自动带 `afterCursor` 无漏续传。
class MobileTerminalScreen extends StatefulWidget {
  const MobileTerminalScreen({
    super.key,
    required this.connectionListenable,
    required this.threadId,
    this.threadTitle,
    this.resizeDebounce = const Duration(milliseconds: 150),
    this.autoCreateWhenEmpty = true,
    this.readClipboard,
  });

  static const switcherButtonKey = ValueKey('terminal-switcher-button');
  static const newTerminalButtonKey = ValueKey('terminal-new-button');
  static const readOnlyBannerKey = ValueKey('terminal-readonly-banner');
  static const readOnlyNewMobileButtonKey = ValueKey(
    'terminal-readonly-new-mobile',
  );
  static const offlineBannerKey = ValueKey('terminal-offline-banner');
  static const exitedBannerKey = ValueKey('terminal-exited-banner');
  static const emptyCreateButtonKey = ValueKey('terminal-empty-create-button');

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    required String threadId,
    String? threadTitle,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => MobileTerminalScreen(
        connectionListenable: connectionListenable,
        threadId: threadId,
        threadTitle: threadTitle,
      ),
    ),
  );

  final ValueListenable<MobileConnection?> connectionListenable;
  final String threadId;
  final String? threadTitle;
  final Duration resizeDebounce;
  final bool autoCreateWhenEmpty;
  final ClipboardTextReader? readClipboard;

  @override
  State<MobileTerminalScreen> createState() => _MobileTerminalScreenState();
}

class _MobileTerminalScreenState extends State<MobileTerminalScreen> {
  final Map<String, _LocalTerminalTab> _tabs = {};
  final Map<String, List<MobileTerminalOutputEvent>> _earlyOutputs = {};
  final FocusNode _terminalFocus = FocusNode(debugLabel: 'mobile-terminal');
  final ScrollController _horizontalScroll = ScrollController();

  MobileConnection? _boundConnection;
  StreamSubscription<MobileTerminalOutputEvent>? _outputSub;
  StreamSubscription<MobileTerminalExitEvent>? _exitSub;
  Timer? _resizeTimer;

  List<MobileTerminalSummary> _remoteList = const [];
  String? _activeId;
  bool _loading = true;
  bool _creating = false;
  bool _offline = false;
  bool _ctrlArmed = false;
  String? _error;
  int _syncSeq = 0;

  _LocalTerminalTab? get _activeTab =>
      _activeId == null ? null : _tabs[_activeId!];

  @override
  void initState() {
    super.initState();
    widget.connectionListenable.addListener(_onConnectionChanged);
    _bindConnection(widget.connectionListenable.value);
  }

  @override
  void didUpdateWidget(covariant MobileTerminalScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.connectionListenable != widget.connectionListenable) {
      oldWidget.connectionListenable.removeListener(_onConnectionChanged);
      widget.connectionListenable.addListener(_onConnectionChanged);
      _bindConnection(widget.connectionListenable.value);
    }
  }

  @override
  void dispose() {
    widget.connectionListenable.removeListener(_onConnectionChanged);
    _resizeTimer?.cancel();
    unawaited(_outputSub?.cancel());
    unawaited(_exitSub?.cancel());
    final conn = _boundConnection;
    if (conn != null && connectionSupportsTerminal(conn)) {
      for (final tab in _tabs.values) {
        if (tab.attached && !tab.exited) {
          unawaited(
            conn.terminal
                .detach(terminalId: tab.summary.id)
                .catchError((Object _) {}),
          );
        }
      }
    }
    for (final tab in _tabs.values) {
      tab.controller.dispose();
    }
    _terminalFocus.dispose();
    _horizontalScroll.dispose();
    super.dispose();
  }

  void _showNotice(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  void _onConnectionChanged() {
    _bindConnection(widget.connectionListenable.value);
  }

  void _bindConnection(MobileConnection? connection) {
    if (identical(connection, _boundConnection)) return;
    _resizeTimer?.cancel();
    unawaited(_outputSub?.cancel());
    unawaited(_exitSub?.cancel());
    _outputSub = null;
    _exitSub = null;
    _boundConnection = connection;

    for (final tab in _tabs.values) {
      tab.attached = false;
    }

    if (connection == null) {
      if (mounted) {
        setState(() {
          _offline = true;
          _loading = false;
        });
      }
      return;
    }

    if (!connectionSupportsTerminal(connection)) {
      if (mounted) {
        setState(() {
          _offline = false;
          _loading = false;
          _error = '请更新电脑上的 Pigcode 后使用远程终端。';
        });
      }
      return;
    }

    _outputSub = connection.terminal.outputs.listen(_onTerminalOutput);
    _exitSub = connection.terminal.exits.listen(_onTerminalExit);
    unawaited(
      connection.done.then((_) {
        if (!mounted || !identical(_boundConnection, connection)) return;
        for (final tab in _tabs.values) {
          tab.attached = false;
        }
        setState(() => _offline = true);
      }),
    );

    if (mounted) {
      setState(() {
        _offline = false;
        _error = null;
        if (_activeId == null) _loading = true;
      });
    }
    unawaited(_syncAfterConnect(connection));
  }

  ({int cols, int rows}) _estimatePhoneSize() {
    if (!mounted) return (cols: 48, rows: 24);
    final mq = MediaQuery.maybeOf(context);
    if (mq == null) return (cols: 48, rows: 24);
    const charWidth = 7.8;
    const lineHeight = 16.5;
    final usableW = math.max(160.0, mq.size.width - 16);
    final usableH = math.max(180.0, mq.size.height - mq.padding.vertical - 130);
    final cols = (usableW / charWidth).floor().clamp(
      mobileTerminalColsMin,
      mobileTerminalColsMax,
    );
    final rows = (usableH / lineHeight).floor().clamp(
      mobileTerminalRowsMin,
      mobileTerminalRowsMax,
    );
    return (cols: cols, rows: rows);
  }

  _LocalTerminalTab _ensureTab(MobileTerminalSummary summary) {
    final existing = _tabs[summary.id];
    if (existing != null) {
      existing.summary = summary;
      return existing;
    }
    final terminal = Terminal(maxLines: 5000, reflowEnabled: summary.writable);
    terminal.resize(summary.cols, summary.rows);
    final controller = TerminalController();
    final tab =
        _LocalTerminalTab(
            summary: summary,
            terminal: terminal,
            controller: controller,
          )
          ..lastSentCols = summary.cols
          ..lastSentRows = summary.rows;

    terminal.onOutput = (data) => _handleTerminalInput(summary.id, data);
    terminal.onResize = (width, height, pixelWidth, pixelHeight) {
      _scheduleResize(summary.id, width, height);
    };
    _tabs[summary.id] = tab;

    // 刷出先到达的缓冲输出（防极快回环时序竞态）
    final early = _earlyOutputs.remove(summary.id);
    if (early != null) {
      for (final event in early) {
        _applyOutputEvent(tab, event);
      }
    }
    return tab;
  }

  Future<void> _syncAfterConnect(MobileConnection connection) async {
    final seq = ++_syncSeq;
    try {
      final list = await connection.terminal.list(threadId: widget.threadId);
      if (!mounted ||
          seq != _syncSeq ||
          !identical(_boundConnection, connection)) {
        return;
      }
      _remoteList = list;

      // 情况 1：此前已有选中的终端
      if (_activeId != null) {
        final existingSummary = _findSummary(list, _activeId!);
        if (existingSummary != null) {
          final tab = _ensureTab(existingSummary);
          await _attachTab(connection, tab);
          if (!mounted || seq != _syncSeq) return;
          setState(() {
            _loading = false;
            _error = null;
          });
          return;
        }
        // 原终端在断线期间已结束：保留已渲染内容并标为退出态
        final oldTab = _tabs[_activeId!];
        if (oldTab != null) {
          setState(() {
            oldTab.exited = true;
            oldTab.attached = false;
            _loading = false;
            _error = null;
          });
          return;
        }
      }

      // 情况 2：首次进入——列表非空时优先附着最新手机终端，否则附着第一个电脑终端
      if (list.isNotEmpty) {
        final preferred = list.lastWhere(
          (item) => item.writable,
          orElse: () => list.first,
        );
        final tab = _ensureTab(preferred);
        _activeId = preferred.id;
        await _attachTab(connection, tab);
        if (!mounted || seq != _syncSeq) return;
        setState(() {
          _loading = false;
          _error = null;
        });
        return;
      }

      // 情况 3：空列表——按配置自动新建 1 个手机终端
      if (widget.autoCreateWhenEmpty) {
        await _openNewTerminalInternal(connection, seq: seq);
        return;
      }

      setState(() {
        _loading = false;
        _error = null;
      });
    } catch (error) {
      if (!mounted || seq != _syncSeq) return;
      setState(() {
        _loading = false;
        _error = workbenchErrorMessage(error, fallback: '暂时无法加载远程终端，请重试。');
      });
    }
  }

  MobileTerminalSummary? _findSummary(
    List<MobileTerminalSummary> list,
    String id,
  ) {
    for (final item in list) {
      if (item.id == id) return item;
    }
    return null;
  }

  Future<void> _attachTab(
    MobileConnection connection,
    _LocalTerminalTab tab, {
    bool forceFullReplay = false,
  }) async {
    final afterCursor = forceFullReplay ? 0 : tab.lastCursor;
    final writable = tab.summary.writable;
    final result = await connection.terminal.attach(
      threadId: widget.threadId,
      terminalId: tab.summary.id,
      afterCursor: afterCursor,
      cols: writable ? tab.terminal.viewWidth : null,
      rows: writable ? tab.terminal.viewHeight : null,
    );
    if (!mounted || !identical(_boundConnection, connection)) return;
    tab.summary = result.terminal;
    tab.attached = true;
    tab.exited = false;
    tab.exitCode = null;
    if (!writable) {
      tab.terminal.resize(result.terminal.cols, result.terminal.rows);
    } else {
      tab.lastSentCols = tab.terminal.viewWidth;
      tab.lastSentRows = tab.terminal.viewHeight;
    }
    if (result.truncated || forceFullReplay) {
      tab.terminal.reset();
      tab.lastCursor = 0;
      if (result.truncated) {
        _showNotice('断线期间输出较多，已回放最近内容');
      }
    }
  }

  Future<void> _openNewTerminal() async {
    final conn = _boundConnection;
    if (conn == null || _offline || _creating) return;
    await _openNewTerminalInternal(conn, seq: ++_syncSeq);
  }

  Future<void> _openNewTerminalInternal(
    MobileConnection connection, {
    required int seq,
  }) async {
    setState(() {
      _creating = true;
      _error = null;
    });
    try {
      final size = _estimatePhoneSize();
      final created = await connection.terminal.open(
        threadId: widget.threadId,
        cols: size.cols,
        rows: size.rows,
      );
      if (!mounted ||
          seq != _syncSeq ||
          !identical(_boundConnection, connection)) {
        return;
      }
      final tab = _ensureTab(created)
        ..attached = true
        ..exited = false
        ..exitCode = null;
      _remoteList = [
        ..._remoteList.where((item) => item.id != created.id),
        created,
      ];
      setState(() {
        _activeId = tab.summary.id;
        _loading = false;
        _creating = false;
        _ctrlArmed = false;
      });
    } catch (error) {
      if (!mounted) return;
      final message = workbenchErrorMessage(error, fallback: '创建终端失败，请重试。');
      setState(() {
        _loading = false;
        _creating = false;
        if (_activeId == null) _error = message;
      });
      if (_activeId != null) {
        _showNotice(message);
      }
    }
  }

  Future<void> _switchToTerminal(MobileTerminalSummary target) async {
    final conn = _boundConnection;
    if (conn == null || _offline) return;
    final tab = _ensureTab(target);
    setState(() {
      _activeId = target.id;
      _ctrlArmed = false;
      _error = null;
    });
    if (!tab.attached && !tab.exited) {
      try {
        await _attachTab(conn, tab);
        if (mounted) setState(() {});
      } catch (error) {
        if (!mounted) return;
        _showNotice(workbenchErrorMessage(error, fallback: '附着终端失败。'));
      }
    }
  }

  Future<void> _closeMobileTerminal(MobileTerminalSummary target) async {
    final conn = _boundConnection;
    if (conn == null || _offline || !target.writable) return;
    try {
      await conn.terminal.close(terminalId: target.id);
      if (!mounted) return;
      final removed = _tabs.remove(target.id);
      removed?.controller.dispose();
      _remoteList = _remoteList.where((e) => e.id != target.id).toList();
      if (_activeId == target.id) {
        if (_remoteList.isNotEmpty) {
          final next = _remoteList.lastWhere(
            (item) => item.writable,
            orElse: () => _remoteList.first,
          );
          await _switchToTerminal(next);
        } else {
          setState(() => _activeId = null);
        }
      } else {
        setState(() {});
      }
      _showNotice('已关闭终端');
    } catch (error) {
      if (!mounted) return;
      _showNotice(workbenchErrorMessage(error, fallback: '关闭终端失败。'));
    }
  }

  void _onTerminalOutput(MobileTerminalOutputEvent event) {
    final tab = _tabs[event.terminalId];
    if (tab == null) {
      (_earlyOutputs[event.terminalId] ??= []).add(event);
      return;
    }
    _applyOutputEvent(tab, event);
  }

  void _applyOutputEvent(
    _LocalTerminalTab tab,
    MobileTerminalOutputEvent event,
  ) {
    if (event.overflow) {
      _showNotice('终端输出过快，正在重新同步…');
      final conn = _boundConnection;
      if (conn != null && !_offline) {
        unawaited(_attachTab(conn, tab, forceFullReplay: true));
      }
      return;
    }
    if (!event.replay && event.cursor <= tab.lastCursor) {
      return;
    }
    if (event.data.isNotEmpty) {
      tab.terminal.write(event.data);
    }
    if (event.cursor > tab.lastCursor) {
      tab.lastCursor = event.cursor;
    }
  }

  void _onTerminalExit(MobileTerminalExitEvent event) {
    final tab = _tabs[event.terminalId];
    if (tab == null || !mounted) return;
    setState(() {
      tab.exited = true;
      tab.exitCode = event.exitCode;
      tab.attached = false;
      _remoteList = _remoteList.where((e) => e.id != event.terminalId).toList();
    });
  }

  void _handleTerminalInput(String terminalId, String raw) {
    final tab = _tabs[terminalId];
    final conn = _boundConnection;
    if (tab == null ||
        conn == null ||
        _offline ||
        !tab.summary.writable ||
        tab.exited) {
      return;
    }
    var payload = raw;
    if (_ctrlArmed) {
      payload = applyStickyCtrl(raw);
      if (mounted) setState(() => _ctrlArmed = false);
    }
    unawaited(
      conn.terminal.write(terminalId: terminalId, data: payload).catchError((
        Object error,
      ) {
        if (!mounted) return;
        _showNotice(workbenchErrorMessage(error, fallback: '发送终端输入失败。'));
      }),
    );
  }

  void _sendRawSequence(String seq) {
    final tab = _activeTab;
    final conn = _boundConnection;
    if (tab == null ||
        conn == null ||
        _offline ||
        !tab.summary.writable ||
        tab.exited) {
      return;
    }
    if (_ctrlArmed) {
      setState(() => _ctrlArmed = false);
    }
    unawaited(
      conn.terminal.write(terminalId: tab.summary.id, data: seq).catchError((
        Object error,
      ) {
        if (!mounted) return;
        _showNotice(workbenchErrorMessage(error, fallback: '发送按键失败。'));
      }),
    );
  }

  Future<void> _pasteClipboard() async {
    final reader = widget.readClipboard ?? _defaultReadClipboard;
    final text = await reader();
    if (!mounted || text == null || text.isEmpty) return;
    _sendRawSequence(text);
  }

  void _scheduleResize(String terminalId, int cols, int rows) {
    final tab = _tabs[terminalId];
    final conn = _boundConnection;
    if (tab == null ||
        conn == null ||
        _offline ||
        !tab.summary.writable ||
        tab.exited) {
      return;
    }
    final clampedCols = cols.clamp(
      mobileTerminalColsMin,
      mobileTerminalColsMax,
    );
    final clampedRows = rows.clamp(
      mobileTerminalRowsMin,
      mobileTerminalRowsMax,
    );
    if (clampedCols == tab.lastSentCols && clampedRows == tab.lastSentRows) {
      return;
    }
    _resizeTimer?.cancel();
    _resizeTimer = Timer(widget.resizeDebounce, () {
      if (!mounted || !identical(_boundConnection, conn) || _offline) return;
      final current = _tabs[terminalId];
      if (current == null || !current.summary.writable || current.exited) {
        return;
      }
      current.lastSentCols = clampedCols;
      current.lastSentRows = clampedRows;
      unawaited(
        conn.terminal
            .resize(
              terminalId: terminalId,
              cols: clampedCols,
              rows: clampedRows,
            )
            .catchError((Object _) {
              return MobileTerminalResizeResult(
                cols: clampedCols,
                rows: clampedRows,
              );
            }),
      );
    });
  }

  Future<void> _openTerminalSwitcher() async {
    final conn = _boundConnection;
    if (conn != null && !_offline && connectionSupportsTerminal(conn)) {
      try {
        final refreshed = await conn.terminal.list(threadId: widget.threadId);
        if (mounted && identical(_boundConnection, conn)) {
          setState(() => _remoteList = refreshed);
        }
      } catch (_) {
        // 刷新失败时继续展示已缓存列表
      }
    }
    if (!mounted) return;
    await showMobileSheet<void>(
      context,
      title: '会话终端',
      content: (sheet) {
        final colors = Theme.of(sheet).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return SliverList.list(
          children: [
            if (_remoteList.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  '当前会话没有运行中的终端。',
                  style: TimelineType.metaStyle(colors.muted),
                ),
              ),
            for (final item in _remoteList)
              ListTile(
                key: ValueKey('terminal-sheet-item-${item.id}'),
                contentPadding: EdgeInsets.zero,
                leading: WorkspaceIcon(WorkspaceGlyph.terminal, size: 20),
                title: Row(
                  spacing: 6,
                  children: [
                    Flexible(
                      child: Text(
                        '${item.shell} · ${item.cwdLabel}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (!item.writable)
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.field,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: colors.border),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 1,
                          ),
                          child: Text(
                            '只读',
                            style: TextStyle(
                              fontSize: 11,
                              color: colors.muted,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
                subtitle: Text(
                  item.writable
                      ? '手机终端 · ${item.cols}×${item.rows}'
                      : '电脑终端 · 只读观看 · ${item.cols}×${item.rows}',
                  style: TimelineType.smallStyle(colors.muted),
                ),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (item.id == _activeId)
                      Icon(
                        Icons.check_rounded,
                        size: 18,
                        color: colors.foreground,
                      ),
                    if (item.writable)
                      IconButton(
                        key: ValueKey('terminal-sheet-close-${item.id}'),
                        tooltip: '关闭终端',
                        icon: Icon(
                          Icons.close_rounded,
                          size: 18,
                          color: colors.error,
                        ),
                        onPressed: () {
                          Navigator.pop(sheet);
                          unawaited(_closeMobileTerminal(item));
                        },
                      ),
                  ],
                ),
                onTap: () {
                  Navigator.pop(sheet);
                  unawaited(_switchToTerminal(item));
                },
              ),
            const Divider(height: 16),
            MobileSheetAction(
              label: '新建手机终端',
              glyph: WorkspaceGlyph.plus,
              onTap: () {
                Navigator.pop(sheet);
                unawaited(_openNewTerminal());
              },
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final brightness = theme.brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final termTheme = pigcodeTerminalTheme(brightness);
    final touch = timelineTouchHeight(context);
    final active = _activeTab;

    final pillLabel = active == null
        ? (widget.threadTitle ?? '终端')
        : '${active.summary.shell} · ${active.summary.cwdLabel}';

    return Scaffold(
      backgroundColor: termTheme.background,
      resizeToAvoidBottomInset: true,
      appBar: AppBar(
        centerTitle: true,
        backgroundColor: termTheme.background,
        surfaceTintColor: Colors.transparent,
        toolbarHeight: touch + 8,
        titleSpacing: 0,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(brightness),
        leadingWidth: touch + 16,
        leading: Align(
          alignment: AlignmentDirectional.centerStart,
          child: MobileGlassChromeButton(
            padding: const EdgeInsetsDirectional.only(start: 10),
            child: SizedBox.square(
              dimension: 40,
              child: IconButton(
                tooltip: '返回',
                padding: EdgeInsets.zero,
                onPressed: () => Navigator.maybePop(context),
                icon: const RotatedBox(
                  quarterTurns: 1,
                  child: WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 20),
                ),
              ),
            ),
          ),
        ),
        title: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 230),
          child: MobileGlassSurface(
            borderRadius: BorderRadius.circular(20),
            child: InkWell(
              key: MobileTerminalScreen.switcherButtonKey,
              borderRadius: BorderRadius.circular(20),
              onTap: _openTerminalSwitcher,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  spacing: 6,
                  children: [
                    Flexible(
                      child: Text(
                        pillLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                          color: colors.foreground,
                        ),
                      ),
                    ),
                    if (active != null && !active.summary.writable)
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.attentionTint,
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 1,
                          ),
                          child: Text(
                            '只读',
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w600,
                              color: colors.attention,
                            ),
                          ),
                        ),
                      ),
                    Icon(
                      Icons.keyboard_arrow_down_rounded,
                      size: 16,
                      color: colors.muted,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        actions: [
          MobileGlassChromeButton(
            padding: const EdgeInsetsDirectional.only(end: 10),
            child: SizedBox.square(
              dimension: 40,
              child: IconButton(
                key: MobileTerminalScreen.newTerminalButtonKey,
                tooltip: '新建终端',
                padding: EdgeInsets.zero,
                onPressed: (_offline || _creating) ? null : _openNewTerminal,
                icon: const WorkspaceIcon(WorkspaceGlyph.plus, size: 18),
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_offline)
            Container(
              key: MobileTerminalScreen.offlineBannerKey,
              width: double.infinity,
              color: colors.attentionTint,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                spacing: 8,
                children: [
                  Icon(
                    Icons.wifi_off_rounded,
                    size: 16,
                    color: colors.attention,
                  ),
                  Expanded(
                    child: Text(
                      '电脑连接已断开，重连后将自动回到原终端…',
                      style: TimelineType.smallStyle(colors.attention),
                    ),
                  ),
                ],
              ),
            ),
          Expanded(child: _buildBody(context, termTheme, active)),
          if (active != null && active.exited)
            _buildExitedBanner(context, active)
          else if (active != null && !active.summary.writable)
            _buildReadOnlyBanner(context)
          else if (active != null && active.summary.writable)
            TerminalShortcutBar(
              ctrlArmed: _ctrlArmed,
              enabled: !_offline && !active.exited,
              onToggleCtrl: () => setState(() => _ctrlArmed = !_ctrlArmed),
              onSendSequence: _sendRawSequence,
              onPaste: () => unawaited(_pasteClipboard()),
              onHideKeyboard: () => _terminalFocus.unfocus(),
            ),
        ],
      ),
    );
  }

  Widget _buildBody(
    BuildContext context,
    TerminalTheme termTheme,
    _LocalTerminalTab? active,
  ) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    if (_loading && active == null) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }
    if (_error != null && active == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            spacing: 12,
            children: [
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: TimelineType.contentStyle(colors.muted),
              ),
              FilledButton(
                onPressed: _boundConnection == null
                    ? null
                    : () => unawaited(_syncAfterConnect(_boundConnection!)),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    if (active == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            spacing: 14,
            children: [
              WorkspaceIcon(WorkspaceGlyph.terminal, size: 32),
              Text(
                '当前会话暂无运行中的终端',
                style: TimelineType.contentStyle(colors.muted),
              ),
              FilledButton.icon(
                key: MobileTerminalScreen.emptyCreateButtonKey,
                onPressed: (_offline || _creating) ? null : _openNewTerminal,
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('新建手机终端'),
              ),
            ],
          ),
        ),
      );
    }

    final brightness = Theme.of(context).brightness;
    final writable = active.summary.writable && !active.exited;
    final view = TerminalView(
      active.terminal,
      key: ValueKey('xterm-${active.summary.id}'),
      controller: active.controller,
      theme: termTheme,
      textStyle: pigcodeTerminalStyle(),
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      focusNode: writable ? _terminalFocus : null,
      autofocus: false,
      readOnly: !writable,
      autoResize: writable,
      hardwareKeyboardOnly: !writable,
      deleteDetection: writable,
      keyboardAppearance: brightness,
      alwaysShowCursor: writable,
    );

    if (active.summary.writable) {
      return view;
    }

    // 电脑端只读终端：按电脑原始列数保留排版宽度，支持横向滑动浏览
    return LayoutBuilder(
      builder: (context, constraints) {
        final desiredWidth = math.max(
          constraints.maxWidth,
          active.summary.cols * 8.2 + 24,
        );
        return SingleChildScrollView(
          controller: _horizontalScroll,
          scrollDirection: Axis.horizontal,
          child: SizedBox(
            width: desiredWidth,
            height: constraints.maxHeight,
            child: view,
          ),
        );
      },
    );
  }

  Widget _buildReadOnlyBanner(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return SafeArea(
      top: false,
      child: Container(
        key: MobileTerminalScreen.readOnlyBannerKey,
        width: double.infinity,
        decoration: BoxDecoration(
          color: colors.panel,
          border: Border(top: BorderSide(color: colors.divider)),
        ),
        padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
        child: Row(
          spacing: 10,
          children: [
            Icon(Icons.visibility_outlined, size: 17, color: colors.muted),
            Expanded(
              child: Text(
                '电脑终端（只读观看，不修改电脑列宽）',
                style: TimelineType.smallStyle(colors.muted),
              ),
            ),
            FilledButton.tonal(
              key: MobileTerminalScreen.readOnlyNewMobileButtonKey,
              onPressed: (_offline || _creating) ? null : _openNewTerminal,
              style: FilledButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
              child: const Text('新建手机终端'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildExitedBanner(BuildContext context, _LocalTerminalTab active) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final detail = active.exitCode == null
        ? '终端已结束'
        : '终端进程已退出（退出码 ${active.exitCode}）';
    return SafeArea(
      top: false,
      child: Container(
        key: MobileTerminalScreen.exitedBannerKey,
        width: double.infinity,
        decoration: BoxDecoration(
          color: colors.panel,
          border: Border(top: BorderSide(color: colors.divider)),
        ),
        padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
        child: Row(
          spacing: 10,
          children: [
            Icon(Icons.stop_circle_outlined, size: 17, color: colors.muted),
            Expanded(
              child: Text(detail, style: TimelineType.smallStyle(colors.muted)),
            ),
            FilledButton(
              onPressed: (_offline || _creating) ? null : _openNewTerminal,
              style: FilledButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
              child: const Text('新建终端'),
            ),
          ],
        ),
      ),
    );
  }
}
