import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_form_widgets.dart';
import 'manage_utils.dart';
import 'plugin_detail_sheet.dart';

enum _PluginTab { installed, marketplace }

enum _MarketFilter { official, community, personal }

/// 手机端插件管理页：支持已安装插件分组查看、启停/更新/卸载，以及官方/社区/个人市场浏览与安装。
class PluginManageScreen extends StatefulWidget {
  const PluginManageScreen({
    super.key,
    required this.connectionListenable,
    this.computerName,
  });

  static const refreshButtonKey = ValueKey('plugin-refresh-button');
  static const installedTabKey = ValueKey('plugin-tab-installed');
  static const marketplaceTabKey = ValueKey('plugin-tab-marketplace');
  static const searchInputKey = ValueKey('plugin-search-input');
  static const searchClearKey = ValueKey('plugin-search-clear');
  static const marketFilterOfficialKey = ValueKey(
    'plugin-market-filter-official',
  );
  static const marketFilterCommunityKey = ValueKey(
    'plugin-market-filter-community',
  );
  static const marketFilterPersonalKey = ValueKey(
    'plugin-market-filter-personal',
  );

  static ValueKey<String> pluginCardKey(String pluginId) =>
      ValueKey('plugin-card-$pluginId');
  static ValueKey<String> pluginToggleKey(String pluginId) =>
      ValueKey('plugin-toggle-$pluginId');
  static ValueKey<String> marketPluginCardKey(
    String marketId,
    String entryName,
  ) => ValueKey('market-plugin-$marketId-$entryName');
  static ValueKey<String> marketInstallButtonKey(String entryName) =>
      ValueKey('market-install-$entryName');
  static ValueKey<String> marketUpdateButtonKey(String entryName) =>
      ValueKey('market-update-$entryName');

  final ValueListenable<MobileConnection?> connectionListenable;
  final String? computerName;

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    String? computerName,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => PluginManageScreen(
        connectionListenable: connectionListenable,
        computerName: computerName,
      ),
    ),
  );

  @override
  State<PluginManageScreen> createState() => _PluginManageScreenState();
}

class _PluginManageScreenState extends State<PluginManageScreen> {
  final TextEditingController _searchController = TextEditingController();

  MobileConnection? _connection;
  _PluginTab _tab = _PluginTab.installed;
  _MarketFilter _marketFilter = _MarketFilter.official;
  String _query = '';

  List<MobilePluginSummary> _plugins = const [];
  bool _pluginsTruncated = false;
  List<MobileMarketplaceSummary> _marketplaces = const [];
  bool _marketplacesTruncated = false;

  bool _loading = true;
  bool _refreshing = false;
  String? _error;
  String? _marketplacesError;
  final Set<String> _busyPluginIds = <String>{};
  final Set<String> _busyMarketKeys = <String>{};
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    widget.connectionListenable.addListener(_onConnectionChanged);
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant PluginManageScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.connectionListenable != widget.connectionListenable) {
      oldWidget.connectionListenable.removeListener(_onConnectionChanged);
      widget.connectionListenable.addListener(_onConnectionChanged);
      _onConnectionChanged();
    }
  }

  @override
  void dispose() {
    widget.connectionListenable.removeListener(_onConnectionChanged);
    _searchController.dispose();
    super.dispose();
  }

  void _onConnectionChanged() {
    if (!mounted) return;
    final next = widget.connectionListenable.value;
    final reconnected = next != null && !identical(next, _connection);
    setState(() => _connection = next);
    if (reconnected) {
      unawaited(_load());
    }
  }

  Future<void> _load({
    bool refreshMarketplaces = false,
    bool silent = false,
  }) async {
    final conn = _connection;
    final seq = ++_seq;
    final hasAnyData = _plugins.isNotEmpty || _marketplaces.isNotEmpty;
    if (!silent) {
      setState(() {
        if (!hasAnyData) {
          _loading = true;
          _error = null;
        } else {
          _refreshing = true;
        }
      });
    }
    if (conn == null) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _loading = false;
        _refreshing = false;
        if (!hasAnyData) {
          _error = '电脑连接已断开，重连后将自动刷新。';
        }
      });
      return;
    }

    MobilePluginListResult? listResult;
    Object? listError;
    MobileMarketplaceListResult? marketResult;
    Object? marketError;

    await Future.wait<void>([
      conn.plugins.list().then(
        (value) => listResult = value,
        onError: (Object err) => listError = err,
      ),
      (refreshMarketplaces
              ? conn.plugins.refreshMarketplaces()
              : conn.plugins.marketplaces())
          .then(
            (value) => marketResult = value,
            onError: (Object err) => marketError = err,
          ),
    ]);

    if (!mounted || seq != _seq) return;
    setState(() {
      if (listResult != null) {
        _plugins = listResult!.plugins;
        _pluginsTruncated = listResult!.truncated;
        _error = null;
      } else if (listError != null && _plugins.isEmpty) {
        _error = manageErrorMessage(listError!);
      }

      if (marketResult != null) {
        _marketplaces = marketResult!.marketplaces;
        _marketplacesTruncated = marketResult!.truncated;
        _marketplacesError = null;
      } else if (marketError != null) {
        _marketplacesError = manageErrorMessage(marketError!);
      }

      _loading = false;
      _refreshing = false;
    });

    if (!silent) {
      if (listError != null && _plugins.isNotEmpty) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text(manageErrorMessage(listError!))),
        );
      } else if (refreshMarketplaces && marketError != null) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text(manageErrorMessage(marketError!))),
        );
      }
    }
  }

  void _upsertInstalledPlugin(MobilePluginSummary updated) {
    final idx = _plugins.indexWhere((p) => p.id == updated.id);
    if (idx >= 0) {
      _plugins = [
        for (var i = 0; i < _plugins.length; i++)
          i == idx ? updated : _plugins[i],
      ];
    } else {
      _plugins = [..._plugins, updated];
    }
  }

  ({MobileMarketplaceSummary market, MobileMarketplacePlugin entry})?
  _marketplaceMatchForInstalled(MobilePluginSummary plugin) {
    if (plugin.originKind == MobilePluginOriginKind.marketplace &&
        plugin.marketplaceId != null) {
      for (final market in _marketplaces) {
        if (market.id != plugin.marketplaceId) continue;
        final expectedName = plugin.marketplacePluginName ?? plugin.name;
        for (final entry in market.plugins) {
          if (entry.name == expectedName || entry.name == plugin.name) {
            return (market: market, entry: entry);
          }
        }
      }
    }
    for (final market in _marketplaces) {
      if (!market.official) continue;
      for (final entry in market.plugins) {
        if (entry.name == plugin.name) {
          return (market: market, entry: entry);
        }
      }
    }
    return null;
  }

  String? _pickChineseI18n(Map<String, String>? i18n) {
    if (i18n == null) return null;
    for (final key in const ['zh-CN', 'zh', 'zh-Hans']) {
      final value = i18n[key]?.trim();
      if (value != null && value.isNotEmpty) return value;
    }
    return null;
  }

  String _displayNameForInstalled(
    MobilePluginSummary plugin,
    MobileMarketplacePlugin? marketEntry,
  ) {
    final localizedZh = _pickChineseI18n(marketEntry?.displayNameI18n);
    if (localizedZh != null) return localizedZh;
    if (plugin.displayName.trim().isNotEmpty) return plugin.displayName.trim();
    return marketEntry?.localizedDisplayName ?? plugin.name;
  }

  String? _descriptionForInstalled(
    MobilePluginSummary plugin,
    MobileMarketplacePlugin? marketEntry,
  ) {
    final localizedZh = _pickChineseI18n(marketEntry?.descriptionI18n);
    if (localizedZh != null) return localizedZh;
    final raw = plugin.description?.trim();
    if (raw != null && raw.isNotEmpty) return raw;
    return marketEntry?.localizedDescription;
  }

  String? _availableUpdateVersion(
    MobilePluginSummary plugin,
    ({MobileMarketplaceSummary market, MobileMarketplacePlugin entry})? match,
  ) {
    if (match == null) return null;
    if (!hasPluginUpdate(plugin, match.market, match.entry)) return null;
    final nextVersion = match.entry.version?.trim();
    return nextVersion != null && nextVersion.isNotEmpty ? nextVersion : null;
  }

  MobilePluginSummary? _installedMatchForMarket(
    MobileMarketplaceSummary market,
    MobileMarketplacePlugin entry,
  ) {
    for (final plugin in _plugins) {
      if (plugin.originKind == MobilePluginOriginKind.marketplace &&
          plugin.marketplaceId == market.id &&
          (plugin.marketplacePluginName == entry.name ||
              (plugin.marketplacePluginName == null &&
                  plugin.name == entry.name))) {
        return plugin;
      }
    }
    for (final plugin in _plugins) {
      if (plugin.name == entry.name) return plugin;
    }
    return null;
  }

  bool _matchesInstalledSearch(
    MobilePluginSummary plugin,
    String displayName,
    String? description,
    String needle,
  ) {
    if (needle.isEmpty) return true;
    return [
      displayName,
      plugin.displayName,
      plugin.name,
      plugin.id,
      description ?? '',
      plugin.description ?? '',
    ].any((field) => field.toLowerCase().contains(needle));
  }

  bool _matchesMarketSearch(MobileMarketplacePlugin entry, String needle) {
    if (needle.isEmpty) return true;
    return [
      entry.localizedDisplayName,
      entry.displayName ?? '',
      entry.name,
      entry.localizedDescription ?? '',
      entry.description ?? '',
      entry.author ?? '',
      entry.category ?? '',
    ].any((field) => field.toLowerCase().contains(needle));
  }

  Future<void> _togglePlugin(MobilePluginSummary plugin, bool next) async {
    final conn = _connection;
    if (conn == null || _busyPluginIds.contains(plugin.id)) return;
    setState(() => _busyPluginIds.add(plugin.id));
    try {
      final updated = await conn.plugins.setEnabled(
        id: plugin.id,
        enabled: next,
      );
      if (!mounted) return;
      setState(() => _upsertInstalledPlugin(updated));
      unawaited(_load(silent: true));
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(pluginActionErrorMessage(error))));
    } finally {
      if (mounted) {
        setState(() => _busyPluginIds.remove(plugin.id));
      }
    }
  }

  Future<void> _installFromMarketplace(
    MobileMarketplaceSummary market,
    MobileMarketplacePlugin entry,
  ) async {
    final conn = _connection;
    final key = '${market.id}:${entry.name}';
    if (conn == null || _busyMarketKeys.contains(key)) return;
    setState(() => _busyMarketKeys.add(key));
    try {
      final installed = await conn.plugins.installFromMarketplace(
        marketplace: market.id,
        name: entry.name,
      );
      if (!mounted) return;
      setState(() => _upsertInstalledPlugin(installed));
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text('已安装 ${entry.localizedDisplayName}')),
      );
      await _load(silent: true);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(pluginActionErrorMessage(error))));
    } finally {
      if (mounted) {
        setState(() => _busyMarketKeys.remove(key));
      }
    }
  }

  Future<void> _updateFromMarketplace(
    MobilePluginSummary installed,
    MobileMarketplacePlugin entry,
  ) async {
    final conn = _connection;
    if (conn == null || _busyPluginIds.contains(installed.id)) return;
    setState(() => _busyPluginIds.add(installed.id));
    try {
      final updated = await conn.plugins.update(id: installed.id);
      if (!mounted) return;
      setState(() => _upsertInstalledPlugin(updated));
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text('已更新 ${entry.localizedDisplayName}')),
      );
      await _load(silent: true);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(pluginActionErrorMessage(error))));
    } finally {
      if (mounted) {
        setState(() => _busyPluginIds.remove(installed.id));
      }
    }
  }

  Future<void> _openInstalledDetail(
    MobilePluginSummary plugin,
    ({MobileMarketplaceSummary market, MobileMarketplacePlugin entry})? match,
    String displayName,
    String? description,
    String? updateVersion,
  ) async {
    final changed = await PluginDetailSheet.showInstalled(
      context,
      connectionListenable: widget.connectionListenable,
      plugin: plugin,
      displayNameOverride: displayName,
      descriptionOverride: description,
      iconUrl: match?.entry.iconUrl,
      availableUpdateVersion: updateVersion,
    );
    if (!mounted || changed != true) return;
    await _load(silent: true);
  }

  Future<void> _openMarketplaceDetail(
    MobileMarketplaceSummary market,
    MobileMarketplacePlugin entry,
    MobilePluginSummary? installed,
    bool hasUpdate,
  ) async {
    final changed = await PluginDetailSheet.showMarketplace(
      context,
      connectionListenable: widget.connectionListenable,
      marketplace: market,
      entry: entry,
      installed: installed,
      hasUpdate: hasUpdate,
    );
    if (!mounted || changed != true) return;
    await _load(silent: true);
  }

  void _onRefreshPressed() {
    if (_connection == null || _refreshing || _loading) return;
    unawaited(_load(refreshMarketplaces: _tab == _PluginTab.marketplace));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        title: ManageAppBarTitle(
          title: '桌面插件',
          computerName: widget.computerName,
        ),
        centerTitle: true,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
        leadingWidth: 58,
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
        actions: [
          Center(
            child: MobileGlassChromeButton(
              padding: const EdgeInsetsDirectional.only(end: 10),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  key: PluginManageScreen.refreshButtonKey,
                  tooltip: _tab == _PluginTab.marketplace ? '刷新插件市场' : '刷新插件列表',
                  padding: EdgeInsets.zero,
                  onPressed: _connection == null || _refreshing || _loading
                      ? null
                      : _onRefreshPressed,
                  icon: _refreshing
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator.adaptive(
                            strokeWidth: 2,
                          ),
                        )
                      : const Icon(Icons.refresh, size: 20),
                ),
              ),
            ),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Divider(height: 1, thickness: 1, color: colors.divider),
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (_connection == null) const ManageOfflineBanner(),
            _buildTopControls(context),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator.adaptive())
                  : _tab == _PluginTab.installed
                  ? _buildInstalledTab(context)
                  : _buildMarketplaceTab(context),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTopControls(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final touch = timelineTouchHeight(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.background,
        border: Border(bottom: BorderSide(color: colors.divider)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          spacing: 10,
          children: [
            _PluginTabSwitcher(
              selected: _tab,
              onSelected: (next) {
                if (_tab != next) {
                  setState(() => _tab = next);
                }
              },
            ),
            Container(
              decoration: BoxDecoration(
                color: colors.field,
                borderRadius: BorderRadius.circular(TimelineRadius.panel),
                border: Border.all(color: colors.border),
              ),
              padding: const EdgeInsetsDirectional.only(
                start: TimelineSpace.x5,
                end: TimelineSpace.x1,
              ),
              child: Row(
                children: [
                  IconTheme(
                    data: IconThemeData(color: colors.muted),
                    child: const WorkspaceIcon(
                      WorkspaceGlyph.search,
                      size: TimelineIcon.control,
                    ),
                  ),
                  const SizedBox(width: TimelineSpace.x4),
                  Expanded(
                    child: TextField(
                      key: PluginManageScreen.searchInputKey,
                      controller: _searchController,
                      onChanged: (value) => setState(() => _query = value),
                      textInputAction: TextInputAction.search,
                      style: TimelineType.contentStyle(colors.foreground),
                      decoration: InputDecoration(
                        isDense: true,
                        border: InputBorder.none,
                        hintText: _tab == _PluginTab.installed
                            ? '搜索已安装插件…'
                            : '搜索插件市场…',
                        hintStyle: TimelineType.contentStyle(colors.faint),
                        contentPadding: const EdgeInsets.symmetric(
                          vertical: 10,
                        ),
                      ),
                    ),
                  ),
                  if (_query.isNotEmpty)
                    SizedBox.square(
                      dimension: touch - 6,
                      child: IconButton(
                        key: PluginManageScreen.searchClearKey,
                        tooltip: '清空搜索',
                        padding: EdgeInsets.zero,
                        onPressed: () {
                          _searchController.clear();
                          setState(() => _query = '');
                        },
                        icon: IconTheme(
                          data: IconThemeData(color: colors.muted),
                          child: const WorkspaceIcon(
                            WorkspaceGlyph.close,
                            size: TimelineIcon.control,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            if (_tab == _PluginTab.marketplace) _buildMarketFilterBar(context),
          ],
        ),
      ),
    );
  }

  Widget _buildMarketFilterBar(BuildContext context) => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      spacing: 8,
      children: [
        _FilterChipCapsule(
          key: PluginManageScreen.marketFilterOfficialKey,
          label: '官方',
          selected: _marketFilter == _MarketFilter.official,
          onTap: () => setState(() => _marketFilter = _MarketFilter.official),
        ),
        _FilterChipCapsule(
          key: PluginManageScreen.marketFilterCommunityKey,
          label: '社区',
          selected: _marketFilter == _MarketFilter.community,
          onTap: () => setState(() => _marketFilter = _MarketFilter.community),
        ),
        _FilterChipCapsule(
          key: PluginManageScreen.marketFilterPersonalKey,
          label: '个人市场',
          selected: _marketFilter == _MarketFilter.personal,
          onTap: () => setState(() => _marketFilter = _MarketFilter.personal),
        ),
      ],
    ),
  );

  Widget _buildInstalledTab(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    if (_error != null && _plugins.isEmpty) {
      return _buildErrorState(context, _error!);
    }

    final needle = _query.trim().toLowerCase();
    final grouped = <MobilePluginKind, List<_ResolvedInstalledPlugin>>{};
    for (final kind in pluginKindOrder) {
      grouped[kind] = <_ResolvedInstalledPlugin>[];
    }
    for (final plugin in _plugins) {
      final match = _marketplaceMatchForInstalled(plugin);
      final displayName = _displayNameForInstalled(plugin, match?.entry);
      final description = _descriptionForInstalled(plugin, match?.entry);
      if (!_matchesInstalledSearch(plugin, displayName, description, needle)) {
        continue;
      }
      final updateVersion = _availableUpdateVersion(plugin, match);
      grouped[plugin.kind]!.add(
        _ResolvedInstalledPlugin(
          plugin: plugin,
          match: match,
          displayName: displayName,
          description: description,
          updateVersion: updateVersion,
        ),
      );
    }

    final nonEmptyKinds = [
      for (final kind in pluginKindOrder)
        if (grouped[kind]!.isNotEmpty) kind,
    ];

    if (nonEmptyKinds.isEmpty) {
      return RefreshIndicator.adaptive(
        onRefresh: () => _load(refreshMarketplaces: false),
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 60),
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                spacing: 12,
                children: [
                  Text(
                    needle.isNotEmpty ? '未找到匹配的已安装插件' : '当前电脑还没有安装插件',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.muted,
                    ),
                  ),
                  if (needle.isNotEmpty)
                    OutlinedButton(
                      onPressed: () {
                        _searchController.clear();
                        setState(() => _query = '');
                      },
                      child: const Text('清空搜索'),
                    )
                  else
                    FilledButton(
                      onPressed: () =>
                          setState(() => _tab = _PluginTab.marketplace),
                      child: const Text('前往插件市场'),
                    ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator.adaptive(
      onRefresh: () => _load(refreshMarketplaces: false),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          for (var g = 0; g < nonEmptyKinds.length; g++) ...[
            if (g > 0) const SizedBox(height: 18),
            _buildInstalledGroup(
              context,
              nonEmptyKinds[g],
              grouped[nonEmptyKinds[g]]!,
            ),
          ],
          if (_pluginsTruncated) ...[
            const SizedBox(height: 16),
            Text(
              '已安装插件较多，仅显示前 ${_plugins.length} 项。',
              textAlign: TextAlign.center,
              style: TimelineType.metaStyle(colors.muted),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildInstalledGroup(
    BuildContext context,
    MobilePluginKind kind,
    List<_ResolvedInstalledPlugin> items,
  ) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ManageSectionHeader(title: pluginKindLabel(kind)),
        const SizedBox(height: 8),
        ManageSurfaceCard(
          children: [
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) Divider(height: 1, indent: 66, color: colors.divider),
              _buildInstalledRow(context, items[i]),
            ],
          ],
        ),
      ],
    );
  }

  Widget _buildInstalledRow(
    BuildContext context,
    _ResolvedInstalledPlugin item,
  ) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final plugin = item.plugin;
    final versionText = formatPluginVersion(plugin.version);
    final busy = _busyPluginIds.contains(plugin.id);
    final hasConflict =
        plugin.conflict != null && plugin.conflict!.trim().isNotEmpty;
    final hasError =
        plugin.error != null &&
        plugin.error!.trim().isNotEmpty &&
        plugin.error!.trim() != plugin.conflict?.trim();

    return InkWell(
      key: PluginManageScreen.pluginCardKey(plugin.id),
      onTap: () => unawaited(
        _openInstalledDetail(
          plugin,
          item.match,
          item.displayName,
          item.description,
          item.updateVersion,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          spacing: 8,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                PluginAvatar(
                  seed: plugin.id,
                  label: item.displayName,
                  iconUrl: item.match?.entry.iconUrl,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    spacing: 3,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              item.displayName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TimelineType.contentStyle(
                                colors.foreground,
                                weight: FontWeight.w500,
                              ),
                            ),
                          ),
                          if (versionText.isNotEmpty) ...[
                            const SizedBox(width: 6),
                            Text(
                              versionText,
                              style: TimelineType.smallStyle(colors.muted),
                            ),
                          ],
                          if (plugin.builtin) ...[
                            const SizedBox(width: 6),
                            PluginStatusPill(
                              label: '内置',
                              background: colors.field,
                              foreground: colors.muted,
                            ),
                          ],
                        ],
                      ),
                      if (item.updateVersion != null || hasConflict || hasError)
                        Wrap(
                          spacing: 6,
                          runSpacing: 4,
                          children: [
                            if (item.updateVersion != null)
                              PluginStatusPill(
                                label: '有更新',
                                background: colors.running.withValues(
                                  alpha: 0.14,
                                ),
                                foreground: colors.running,
                              ),
                            if (hasError)
                              PluginStatusPill(
                                label: '异常',
                                background: colors.errorTint,
                                foreground: colors.error,
                                icon: Icons.error_outline,
                              ),
                            if (hasConflict)
                              PluginStatusPill(
                                label: '冲突',
                                background: colors.attentionTint,
                                foreground: colors.attention,
                                icon: Icons.warning_amber_rounded,
                              ),
                          ],
                        ),
                      if (item.description != null &&
                          item.description!.isNotEmpty)
                        Text(
                          item.description!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TimelineType.metaStyle(colors.muted),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Switch.adaptive(
                  key: PluginManageScreen.pluginToggleKey(plugin.id),
                  value: plugin.enabled,
                  onChanged: _connection == null || busy
                      ? null
                      : (next) => unawaited(_togglePlugin(plugin, next)),
                ),
              ],
            ),
            if (hasError)
              _InlineIssueStrip(
                message: plugin.error!.trim(),
                background: colors.errorTint,
                foreground: colors.error,
                icon: Icons.error_outline,
              ),
            if (hasConflict)
              _InlineIssueStrip(
                message: plugin.conflict!.trim(),
                background: colors.attentionTint,
                foreground: colors.attention,
                icon: Icons.warning_amber_rounded,
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildMarketplaceTab(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (_marketplacesError != null && _marketplaces.isEmpty) {
      return _buildErrorState(context, _marketplacesError!);
    }

    final needle = _query.trim().toLowerCase();
    final enabledMarkets = [
      for (final m in _marketplaces)
        if (m.enabled) m,
    ];

    final sections = <Widget>[];
    if (_marketFilter == _MarketFilter.personal) {
      final personalMarkets = [
        for (final m in enabledMarkets)
          if (!m.official) m,
      ];
      for (final market in personalMarkets) {
        final entries = [
          for (final entry in market.plugins)
            if (_matchesMarketSearch(entry, needle)) entry,
        ];
        final hasMarketError =
            market.error != null && market.error!.trim().isNotEmpty;
        if (needle.isNotEmpty && entries.isEmpty && !hasMarketError) {
          continue;
        }
        sections.add(
          _buildPersonalMarketSection(
            context,
            market: market,
            entries: entries,
          ),
        );
      }
      if (sections.isEmpty) {
        sections.add(
          _buildMarketEmptyPlaceholder(
            context,
            needle.isNotEmpty ? '未找到匹配的个人市场插件' : '暂无已启用的个人市场',
            showClearSearch: needle.isNotEmpty,
          ),
        );
      }
    } else {
      final targetPublisher = _marketFilter == _MarketFilter.official
          ? MobileMarketplacePublisherType.official
          : MobileMarketplacePublisherType.community;
      final officialMarkets = [
        for (final m in enabledMarkets)
          if (m.official) m,
      ];
      final errorBanners = <Widget>[];
      final entries =
          <
            ({MobileMarketplaceSummary market, MobileMarketplacePlugin entry})
          >[];
      for (final market in officialMarkets) {
        if (market.error != null && market.error!.trim().isNotEmpty) {
          errorBanners.add(
            _InlineIssueStrip(
              message: '${market.displayName}刷新失败：${market.error!.trim()}',
              background: colors.attentionTint,
              foreground: colors.attention,
              icon: Icons.warning_amber_rounded,
            ),
          );
        }
        for (final entry in market.plugins) {
          if (entry.publisherType != targetPublisher) continue;
          if (!_matchesMarketSearch(entry, needle)) continue;
          entries.add((market: market, entry: entry));
        }
      }
      for (final banner in errorBanners) {
        sections.add(banner);
      }
      if (entries.isEmpty) {
        sections.add(
          _buildMarketEmptyPlaceholder(
            context,
            needle.isNotEmpty
                ? '未找到匹配的市场插件'
                : _marketFilter == _MarketFilter.official
                ? '暂无官方市场插件'
                : '暂无社区插件',
            showClearSearch: needle.isNotEmpty,
          ),
        );
      } else {
        sections.add(
          ManageSurfaceCard(
            children: [
              for (var i = 0; i < entries.length; i++) ...[
                if (i > 0)
                  Divider(height: 1, indent: 66, color: colors.divider),
                _buildMarketplaceRow(
                  context,
                  market: entries[i].market,
                  entry: entries[i].entry,
                ),
              ],
            ],
          ),
        );
      }
    }

    return RefreshIndicator.adaptive(
      onRefresh: () => _load(refreshMarketplaces: true),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          for (var i = 0; i < sections.length; i++) ...[
            if (i > 0) const SizedBox(height: 16),
            sections[i],
          ],
          if (_marketplacesTruncated) ...[
            const SizedBox(height: 16),
            Text(
              '市场插件条目较多，仅展示部分列表。',
              textAlign: TextAlign.center,
              style: TimelineType.metaStyle(colors.muted),
            ),
          ],
          const SizedBox(height: 24),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Text(
              '添加自定义市场源或本地路径安装请在电脑端操作',
              textAlign: TextAlign.center,
              style: TimelineType.smallStyle(colors.muted),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPersonalMarketSection(
    BuildContext context, {
    required MobileMarketplaceSummary market,
    required List<MobileMarketplacePlugin> entries,
  }) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final hasError = market.error != null && market.error!.trim().isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 2,
            children: [
              Text(
                market.displayName,
                style: TimelineType.metaStyle(
                  colors.secondaryText,
                  weight: FontWeight.w600,
                ),
              ),
              if (market.sourceLabel.trim().isNotEmpty &&
                  market.sourceLabel.trim() != market.displayName)
                Text(
                  market.sourceLabel.trim(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TimelineType.microStyle(colors.muted),
                ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        if (hasError) ...[
          _InlineIssueStrip(
            message: '市场源刷新失败：${market.error!.trim()}',
            background: colors.attentionTint,
            foreground: colors.attention,
            icon: Icons.warning_amber_rounded,
          ),
          const SizedBox(height: 8),
        ],
        ManageSurfaceCard(
          children: [
            if (entries.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  '该市场源暂无可用插件',
                  style: TimelineType.metaStyle(colors.muted),
                ),
              )
            else
              for (var i = 0; i < entries.length; i++) ...[
                if (i > 0)
                  Divider(height: 1, indent: 66, color: colors.divider),
                _buildMarketplaceRow(
                  context,
                  market: market,
                  entry: entries[i],
                ),
              ],
          ],
        ),
      ],
    );
  }

  Widget _buildMarketplaceRow(
    BuildContext context, {
    required MobileMarketplaceSummary market,
    required MobileMarketplacePlugin entry,
  }) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final installed = _installedMatchForMarket(market, entry);
    final hasUpdate =
        installed != null && hasPluginUpdate(installed, market, entry);
    final marketKey = '${market.id}:${entry.name}';
    final installing = _busyMarketKeys.contains(marketKey);
    final updating = installed != null && _busyPluginIds.contains(installed.id);
    final online = _connection != null;

    final displayName = entry.localizedDisplayName;
    final description = entry.localizedDescription?.trim();
    final versionText = formatPluginVersion(entry.version);
    final metaParts = <String>[
      if (versionText.isNotEmpty) versionText,
      if (entry.author != null && entry.author!.trim().isNotEmpty)
        entry.author!.trim(),
    ];

    Widget trailingAction;
    if (installed != null && hasUpdate) {
      trailingAction = FilledButton.tonal(
        key: PluginManageScreen.marketUpdateButtonKey(entry.name),
        style: FilledButton.styleFrom(
          visualDensity: VisualDensity.compact,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          minimumSize: const Size(56, 32),
        ),
        onPressed: online && !updating
            ? () => unawaited(_updateFromMarketplace(installed, entry))
            : null,
        child: updating
            ? const SizedBox.square(
                dimension: 14,
                child: CircularProgressIndicator.adaptive(strokeWidth: 2),
              )
            : const Text('更新'),
      );
    } else if (installed != null) {
      trailingAction = Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: colors.field,
          borderRadius: BorderRadius.circular(TimelineRadius.full),
        ),
        child: Text('已安装', style: TimelineType.smallStyle(colors.muted)),
      );
    } else {
      trailingAction = FilledButton(
        key: PluginManageScreen.marketInstallButtonKey(entry.name),
        style: FilledButton.styleFrom(
          visualDensity: VisualDensity.compact,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          minimumSize: const Size(56, 32),
        ),
        onPressed: online && !installing
            ? () => unawaited(_installFromMarketplace(market, entry))
            : null,
        child: installing
            ? const SizedBox.square(
                dimension: 14,
                child: CircularProgressIndicator.adaptive(strokeWidth: 2),
              )
            : const Text('安装'),
      );
    }

    return InkWell(
      key: PluginManageScreen.marketPluginCardKey(market.id, entry.name),
      onTap: () => unawaited(
        _openMarketplaceDetail(market, entry, installed, hasUpdate),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            PluginAvatar(
              seed: '${market.id}/${entry.name}',
              label: displayName,
              iconUrl: entry.iconUrl,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 3,
                children: [
                  Text(
                    displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.contentStyle(
                      colors.foreground,
                      weight: FontWeight.w500,
                    ),
                  ),
                  if (metaParts.isNotEmpty)
                    Text(
                      metaParts.join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.smallStyle(colors.muted),
                    ),
                  if (description != null && description.isNotEmpty)
                    Text(
                      description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TimelineType.metaStyle(colors.muted),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            trailingAction,
          ],
        ),
      ),
    );
  }

  Widget _buildMarketEmptyPlaceholder(
    BuildContext context,
    String message, {
    required bool showClearSearch,
  }) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        spacing: 12,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: TimelineType.contentStyle(colors.muted),
          ),
          if (showClearSearch)
            OutlinedButton(
              onPressed: () {
                _searchController.clear();
                setState(() => _query = '');
              },
              child: const Text('清空搜索'),
            ),
        ],
      ),
    );
  }

  Widget _buildErrorState(BuildContext context, String message) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: 12,
          children: [
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: colors.muted),
            ),
            OutlinedButton(
              onPressed: _connection == null
                  ? null
                  : () => unawaited(
                      _load(
                        refreshMarketplaces: _tab == _PluginTab.marketplace,
                      ),
                    ),
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ResolvedInstalledPlugin {
  const _ResolvedInstalledPlugin({
    required this.plugin,
    required this.match,
    required this.displayName,
    required this.description,
    required this.updateVersion,
  });

  final MobilePluginSummary plugin;
  final ({MobileMarketplaceSummary market, MobileMarketplacePlugin entry})?
  match;
  final String displayName;
  final String? description;
  final String? updateVersion;
}

class _PluginTabSwitcher extends StatelessWidget {
  const _PluginTabSwitcher({required this.selected, required this.onSelected});

  final _PluginTab selected;
  final ValueChanged<_PluginTab> onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: colors.field,
        borderRadius: BorderRadius.circular(TimelineRadius.full),
        border: Border.all(color: colors.border),
      ),
      child: Row(
        children: [
          Expanded(
            child: _SegmentPill(
              key: PluginManageScreen.installedTabKey,
              label: '已安装',
              selected: selected == _PluginTab.installed,
              onTap: () => onSelected(_PluginTab.installed),
            ),
          ),
          Expanded(
            child: _SegmentPill(
              key: PluginManageScreen.marketplaceTabKey,
              label: '插件市场',
              selected: selected == _PluginTab.marketplace,
              onTap: () => onSelected(_PluginTab.marketplace),
            ),
          ),
        ],
      ),
    );
  }
}

class _SegmentPill extends StatelessWidget {
  const _SegmentPill({
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
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
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
            constraints: const BoxConstraints(minHeight: 34),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
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
                weight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FilterChipCapsule extends StatelessWidget {
  const _FilterChipCapsule({
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
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? colors.primary : colors.field,
        shape: StadiumBorder(
          side: BorderSide(color: selected ? colors.primary : colors.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            child: Text(
              label,
              style: TimelineType.smallStyle(
                selected ? colors.onPrimary : colors.secondaryText,
                weight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _InlineIssueStrip extends StatelessWidget {
  const _InlineIssueStrip({
    required this.message,
    required this.background,
    required this.foreground,
    required this.icon,
  });

  final String message;
  final Color background;
  final Color foreground;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 6,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(icon, size: 14, color: foreground),
        ),
        Expanded(
          child: Text(
            message,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TimelineType.smallStyle(foreground),
          ),
        ),
      ],
    ),
  );
}
