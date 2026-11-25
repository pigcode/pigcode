import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'file_browser_tab.dart';
import 'pr_status_tab.dart';
import 'workbench_utils.dart';

/// 手机端只读工作台顶部 Tab 枚举（为 `#152` 预留 `preview` 插槽）。
enum MobileWorkbenchTab { files, pr, preview }

/// 手机端全屏只读工作台：
/// - 顶栏左侧返回，中间紧凑分段切换「文件」/「PR」（若传入 `previewTabBuilder` 则追加「预览」）；
/// - 使用 `IndexedStack` 保持切换 Tab 时的目录位置与 PR 加载状态不丢失。
class MobileWorkbenchScreen extends StatefulWidget {
  const MobileWorkbenchScreen({
    super.key,
    required this.connection,
    required this.threadId,
    this.title,
    this.initialTab = MobileWorkbenchTab.files,
    this.initialDirectory = '',
    this.previewTabBuilder,
    this.openExternalUrl,
    this.searchDebounce = const Duration(milliseconds: 250),
  });

  static const filesTabKey = ValueKey('workbench-tab-files');
  static const prTabKey = ValueKey('workbench-tab-pr');
  static const previewTabKey = ValueKey('workbench-tab-preview');

  final MobileConnection connection;
  final String threadId;
  final String? title;
  final MobileWorkbenchTab initialTab;
  final String initialDirectory;
  final WidgetBuilder? previewTabBuilder;
  final ExternalUrlOpener? openExternalUrl;
  final Duration searchDebounce;

  static Future<void> open(
    BuildContext context, {
    required MobileConnection connection,
    required String threadId,
    String? title,
    MobileWorkbenchTab initialTab = MobileWorkbenchTab.files,
    String initialDirectory = '',
    WidgetBuilder? previewTabBuilder,
    ExternalUrlOpener? openExternalUrl,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => MobileWorkbenchScreen(
        connection: connection,
        threadId: threadId,
        title: title,
        initialTab: initialTab,
        initialDirectory: initialDirectory,
        previewTabBuilder: previewTabBuilder,
        openExternalUrl: openExternalUrl,
      ),
    ),
  );

  @override
  State<MobileWorkbenchScreen> createState() => _MobileWorkbenchScreenState();
}

class _MobileWorkbenchScreenState extends State<MobileWorkbenchScreen> {
  late MobileWorkbenchTab _selectedTab;

  List<MobileWorkbenchTab> get _availableTabs => [
    MobileWorkbenchTab.files,
    MobileWorkbenchTab.pr,
    if (widget.previewTabBuilder != null) MobileWorkbenchTab.preview,
  ];

  @override
  void initState() {
    super.initState();
    _selectedTab = _resolveInitialTab(widget.initialTab);
  }

  @override
  void didUpdateWidget(covariant MobileWorkbenchScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_availableTabs.contains(_selectedTab)) {
      _selectedTab = MobileWorkbenchTab.files;
    }
  }

  MobileWorkbenchTab _resolveInitialTab(MobileWorkbenchTab requested) {
    if (requested == MobileWorkbenchTab.preview &&
        widget.previewTabBuilder == null) {
      return MobileWorkbenchTab.files;
    }
    return requested;
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
        leadingWidth: touch + 8,
        leading: Align(
          alignment: AlignmentDirectional.centerStart,
          child: SizedBox.square(
            dimension: touch,
            child: IconButton(
              tooltip: '返回',
              onPressed: () => Navigator.maybePop(context),
              alignment: AlignmentDirectional.centerStart,
              padding: const EdgeInsetsDirectional.only(start: 6),
              icon: const RotatedBox(
                quarterTurns: 1,
                child: WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 24),
              ),
            ),
          ),
        ),
        title: _WorkbenchSegmentedControl(
          tabs: tabs,
          selected: _selectedTab,
          onSelected: (tab) {
            if (_selectedTab != tab) {
              setState(() => _selectedTab = tab);
            }
          },
        ),
        actions: [SizedBox(width: touch + 8)],
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
        child: IndexedStack(
          index: selectedIndex,
          children: [
            TickerMode(
              enabled: _selectedTab == MobileWorkbenchTab.files,
              child: FileBrowserTab(
                connection: widget.connection,
                threadId: widget.threadId,
                initialDirectory: widget.initialDirectory,
                searchDebounce: widget.searchDebounce,
              ),
            ),
            TickerMode(
              enabled: _selectedTab == MobileWorkbenchTab.pr,
              child: PrStatusTab(
                connection: widget.connection,
                threadId: widget.threadId,
                active: _selectedTab == MobileWorkbenchTab.pr,
                openExternalUrl: widget.openExternalUrl,
              ),
            ),
            if (widget.previewTabBuilder case final buildPreview?)
              TickerMode(
                enabled: _selectedTab == MobileWorkbenchTab.preview,
                child: Builder(builder: buildPreview),
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
    MobileWorkbenchTab.pr => 'PR',
    MobileWorkbenchTab.preview => '预览',
  };

  ValueKey<String> _key(MobileWorkbenchTab tab) => switch (tab) {
    MobileWorkbenchTab.files => MobileWorkbenchScreen.filesTabKey,
    MobileWorkbenchTab.pr => MobileWorkbenchScreen.prTabKey,
    MobileWorkbenchTab.preview => MobileWorkbenchScreen.previewTabKey,
  };

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.field,
        borderRadius: BorderRadius.circular(TimelineRadius.full),
        border: Border.all(color: colors.border),
      ),
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
  });

  final String label;
  final bool selected;
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
            constraints: const BoxConstraints(minWidth: 64, minHeight: 34),
            padding: const EdgeInsets.symmetric(
              horizontal: TimelineSpace.x6,
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
