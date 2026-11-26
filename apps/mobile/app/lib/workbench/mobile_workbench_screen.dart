import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'file_browser_tab.dart';
import 'git_workbench_tab.dart';
import 'pr_status_tab.dart';
import 'workbench_utils.dart';

typedef WorkbenchPreviewTabBuilder =
    Widget Function(BuildContext context, MobileConnection connection);

/// 手机端工作台顶部 Tab 枚举（支持 `workbench.write` 时展示「Git」）。
enum MobileWorkbenchTab { files, git, pr, preview }

/// 手机端全屏工作台：
/// - 顶栏左侧返回，中间紧凑液态玻璃分段切换「文件 / Git / PR / 预览」；
/// - 使用 `IndexedStack` 保持切换 Tab 时的状态，并通过共享 `workspaceRevision` 联动写操作刷新；
/// - 传入 `connectionListenable` 时，电脑端重启或网络切换重连后自动切换到新连接并刷新。
class MobileWorkbenchScreen extends StatefulWidget {
  const MobileWorkbenchScreen({
    super.key,
    required this.connection,
    this.connectionListenable,
    required this.threadId,
    this.title,
    this.initialTab = MobileWorkbenchTab.files,
    this.initialDirectory = '',
    this.previewTabBuilder,
    this.connectionPreviewTabBuilder,
    this.openExternalUrl,
    this.threadBusy = false,
    this.searchDebounce = const Duration(milliseconds: 250),
  });

  static const filesTabKey = ValueKey('workbench-tab-files');
  static const gitTabKey = ValueKey('workbench-tab-git');
  static const prTabKey = ValueKey('workbench-tab-pr');
  static const previewTabKey = ValueKey('workbench-tab-preview');
  static const offlineBannerKey = ValueKey('workbench-offline-banner');

  final MobileConnection connection;
  final ValueListenable<MobileConnection?>? connectionListenable;
  final String threadId;
  final String? title;
  final MobileWorkbenchTab initialTab;
  final String initialDirectory;
  final WidgetBuilder? previewTabBuilder;
  final WorkbenchPreviewTabBuilder? connectionPreviewTabBuilder;
  final ExternalUrlOpener? openExternalUrl;
  final bool threadBusy;
  final Duration searchDebounce;

  static Future<void> open(
    BuildContext context, {
    required MobileConnection connection,
    ValueListenable<MobileConnection?>? connectionListenable,
    required String threadId,
    String? title,
    MobileWorkbenchTab initialTab = MobileWorkbenchTab.files,
    String initialDirectory = '',
    WidgetBuilder? previewTabBuilder,
    WorkbenchPreviewTabBuilder? connectionPreviewTabBuilder,
    ExternalUrlOpener? openExternalUrl,
    bool threadBusy = false,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => MobileWorkbenchScreen(
        connection: connection,
        connectionListenable: connectionListenable,
        threadId: threadId,
        title: title,
        initialTab: initialTab,
        initialDirectory: initialDirectory,
        previewTabBuilder: previewTabBuilder,
        connectionPreviewTabBuilder: connectionPreviewTabBuilder,
        openExternalUrl: openExternalUrl,
        threadBusy: threadBusy,
      ),
    ),
  );

  @override
  State<MobileWorkbenchScreen> createState() => _MobileWorkbenchScreenState();
}

class _MobileWorkbenchScreenState extends State<MobileWorkbenchScreen> {
  late MobileConnection _connection;
  bool _offline = false;
  late MobileWorkbenchTab _selectedTab;
  bool _previewActivated = false;
  int _workspaceRevision = 0;

  bool get _hasPreviewBuilder =>
      widget.connectionPreviewTabBuilder != null ||
      widget.previewTabBuilder != null;

  bool get _hasWorkbenchTabs =>
      connectionSupportsWorkbenchRead(_connection) || !_hasPreviewBuilder;

  bool get _hasGitTab =>
      _hasWorkbenchTabs && connectionSupportsWorkbenchWrite(_connection);

  List<MobileWorkbenchTab> get _availableTabs => [
    if (_hasWorkbenchTabs) MobileWorkbenchTab.files,
    if (_hasGitTab) MobileWorkbenchTab.git,
    if (_hasWorkbenchTabs) MobileWorkbenchTab.pr,
    if (_hasPreviewBuilder) MobileWorkbenchTab.preview,
  ];

  void _bumpWorkspaceRevision() {
    if (!mounted) return;
    setState(() => _workspaceRevision++);
  }

  @override
  void initState() {
    super.initState();
    final current = widget.connectionListenable?.value;
    _connection = current ?? widget.connection;
    _offline = widget.connectionListenable != null && current == null;
    widget.connectionListenable?.addListener(_handleConnectionChanged);
    _selectedTab = _resolveInitialTab(widget.initialTab);
    _previewActivated = _selectedTab == MobileWorkbenchTab.preview;
  }

  @override
  void didUpdateWidget(covariant MobileWorkbenchScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.connectionListenable != widget.connectionListenable) {
      oldWidget.connectionListenable?.removeListener(_handleConnectionChanged);
      widget.connectionListenable?.addListener(_handleConnectionChanged);
      _syncFromListenable(bumpRevision: false);
    } else if (widget.connectionListenable == null &&
        !identical(oldWidget.connection, widget.connection)) {
      _connection = widget.connection;
      _offline = false;
      _workspaceRevision++;
    }
    if (!_availableTabs.contains(_selectedTab)) {
      _selectedTab = _availableTabs.first;
    }
    if (_selectedTab == MobileWorkbenchTab.preview) {
      _previewActivated = true;
    }
  }

  @override
  void dispose() {
    widget.connectionListenable?.removeListener(_handleConnectionChanged);
    super.dispose();
  }

  void _handleConnectionChanged() {
    if (!mounted) return;
    setState(() => _syncFromListenable(bumpRevision: true));
  }

  void _syncFromListenable({required bool bumpRevision}) {
    final listenable = widget.connectionListenable;
    if (listenable == null) return;
    final next = listenable.value;
    if (next == null) {
      _offline = true;
      return;
    }
    final changed = !identical(next, _connection);
    _connection = next;
    _offline = false;
    if (changed && bumpRevision) {
      _workspaceRevision++;
    }
    if (!_availableTabs.contains(_selectedTab)) {
      _selectedTab = _availableTabs.first;
    }
  }

  MobileWorkbenchTab _resolveInitialTab(MobileWorkbenchTab requested) {
    final tabs = _availableTabs;
    if (tabs.contains(requested)) return requested;
    return tabs.first;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);
    final tabs = _availableTabs;
    final selectedIndex = tabs.indexOf(_selectedTab).clamp(0, tabs.length - 1);

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        centerTitle: true,
        toolbarHeight: touch + 8,
        titleSpacing: 0,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
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
        title: _WorkbenchSegmentedControl(
          tabs: tabs,
          selected: _selectedTab,
          onSelected: (tab) {
            if (_selectedTab != tab) {
              setState(() {
                _selectedTab = tab;
                if (tab == MobileWorkbenchTab.preview) {
                  _previewActivated = true;
                }
              });
            }
          },
        ),
        actions: [SizedBox(width: tabs.length >= 4 ? 12 : touch + 16)],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Divider(
            height: 1,
            thickness: 1,
            color: colors.divider,
          ),
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (_offline)
              Container(
                key: MobileWorkbenchScreen.offlineBannerKey,
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: TimelineSpace.x6,
                  vertical: TimelineSpace.x2,
                ),
                decoration: BoxDecoration(
                  color: colors.surface,
                  border: Border(bottom: BorderSide(color: colors.divider)),
                ),
                child: Text(
                  '电脑连接已断开，正在重连…',
                  style: TimelineType.metaStyle(colors.muted),
                ),
              ),
            Expanded(
              child: IndexedStack(
                index: selectedIndex,
                children: [
                  if (_hasWorkbenchTabs)
                    TickerMode(
                      enabled: _selectedTab == MobileWorkbenchTab.files,
                      child: FileBrowserTab(
                        connection: _connection,
                        threadId: widget.threadId,
                        initialDirectory: widget.initialDirectory,
                        searchDebounce: widget.searchDebounce,
                        revision: _workspaceRevision,
                        threadBusy: widget.threadBusy,
                        onWorkspaceMutated: _bumpWorkspaceRevision,
                        onOpenGitTab: _hasGitTab
                            ? () => setState(
                                () => _selectedTab = MobileWorkbenchTab.git,
                              )
                            : null,
                      ),
                    ),
                  if (_hasGitTab)
                    TickerMode(
                      enabled: _selectedTab == MobileWorkbenchTab.git,
                      child: GitWorkbenchTab(
                        connection: _connection,
                        threadId: widget.threadId,
                        active: _selectedTab == MobileWorkbenchTab.git,
                        revision: _workspaceRevision,
                        threadBusy: widget.threadBusy,
                        onWorkspaceMutated: _bumpWorkspaceRevision,
                      ),
                    ),
                  if (_hasWorkbenchTabs)
                    TickerMode(
                      enabled: _selectedTab == MobileWorkbenchTab.pr,
                      child: PrStatusTab(
                        connection: _connection,
                        threadId: widget.threadId,
                        active: _selectedTab == MobileWorkbenchTab.pr,
                        revision: _workspaceRevision,
                        openExternalUrl: widget.openExternalUrl,
                        onWorkspaceMutated: _bumpWorkspaceRevision,
                      ),
                    ),
                  if (_hasPreviewBuilder)
                    TickerMode(
                      enabled: _selectedTab == MobileWorkbenchTab.preview,
                      child: _previewActivated
                          ? Builder(
                              builder: (ctx) =>
                                  widget.connectionPreviewTabBuilder?.call(
                                    ctx,
                                    _connection,
                                  ) ??
                                  widget.previewTabBuilder!(ctx),
                            )
                          : const SizedBox.shrink(),
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

class _WorkbenchSegmentedControl extends StatelessWidget {
  const _WorkbenchSegmentedControl({
    required this.tabs,
    required this.selected,
    required this.onSelected,
  });

  final List<MobileWorkbenchTab> tabs;
  final MobileWorkbenchTab selected;
  final ValueChanged<MobileWorkbenchTab> onSelected;

  String _label(MobileWorkbenchTab tab) => switch (tab) {
    MobileWorkbenchTab.files => '文件',
    MobileWorkbenchTab.git => 'Git',
    MobileWorkbenchTab.pr => 'PR',
    MobileWorkbenchTab.preview => '预览',
  };

  ValueKey<String> _key(MobileWorkbenchTab tab) => switch (tab) {
    MobileWorkbenchTab.files => MobileWorkbenchScreen.filesTabKey,
    MobileWorkbenchTab.git => MobileWorkbenchScreen.gitTabKey,
    MobileWorkbenchTab.pr => MobileWorkbenchScreen.prTabKey,
    MobileWorkbenchTab.preview => MobileWorkbenchScreen.previewTabKey,
  };

  @override
  Widget build(BuildContext context) {
    final compact = tabs.length >= 4;
    return MobileGlassSurface(
      blurSigma: 16,
      child: Padding(
        padding: const EdgeInsets.all(3),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final tab in tabs)
              _SegmentButton(
                key: _key(tab),
                label: _label(tab),
                selected: tab == selected,
                compact: compact,
                onTap: () => onSelected(tab),
              ),
          ],
        ),
      ),
    );
  }
}

class _SegmentButton extends StatelessWidget {
  const _SegmentButton({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.compact = false,
  });

  final String label;
  final bool selected;
  final bool compact;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : TimelineMotion.med;

    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          customBorder: const StadiumBorder(),
          child: AnimatedContainer(
            duration: duration,
            curve: TimelineMotion.ease,
            constraints: BoxConstraints(
              minWidth: compact ? 52 : 64,
              minHeight: 34,
            ),
            padding: EdgeInsets.symmetric(
              horizontal: compact ? TimelineSpace.x4 : TimelineSpace.x6,
              vertical: TimelineSpace.x2,
            ),
            decoration: BoxDecoration(
              color: selected ? colors.surfaceRaised : Colors.transparent,
              borderRadius: BorderRadius.circular(TimelineRadius.full),
              boxShadow: selected ? TimelineShadow.sm : null,
            ),
            alignment: Alignment.center,
            child: Text(
              label,
              style: TimelineType.metaStyle(
                selected ? colors.foreground : colors.muted,
                weight: selected ? FontWeight.w500 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
