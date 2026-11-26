import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import 'manage_utils.dart';

/// 已安装插件列表的固定分组顺序：Agent -> 界面 -> 能力 -> 组合包。
const List<MobilePluginKind> pluginKindOrder = [
  MobilePluginKind.agent,
  MobilePluginKind.ui,
  MobilePluginKind.capability,
  MobilePluginKind.bundle,
];

String pluginKindLabel(MobilePluginKind kind) => switch (kind) {
  MobilePluginKind.agent => 'Agent',
  MobilePluginKind.ui => '界面',
  MobilePluginKind.capability => '能力',
  MobilePluginKind.bundle => '组合包',
};

String formatPluginVersion(String? raw) {
  final trimmed = raw?.trim() ?? '';
  if (trimmed.isEmpty) return '';
  if (trimmed.startsWith('v') || trimmed.startsWith('V')) {
    return trimmed;
  }
  return 'v$trimmed';
}

String pluginOriginDisplay(MobilePluginSummary plugin) {
  if (plugin.builtin) return '内置';
  final label = plugin.originLabel?.trim();
  if (label != null && label.isNotEmpty) return label;
  return switch (plugin.originKind) {
    MobilePluginOriginKind.builtin => '内置',
    MobilePluginOriginKind.marketplace => plugin.marketplaceId ?? '插件市场',
    MobilePluginOriginKind.npm => 'npm',
    MobilePluginOriginKind.github => 'GitHub',
    MobilePluginOriginKind.git => 'Git',
    MobilePluginOriginKind.url => '远程压缩包',
    MobilePluginOriginKind.local => '本地目录',
    null => '未知来源',
  };
}

/// 仅接受安全 `https://` 远程图片地址（与 Host 脱敏规则对齐，杜绝 data:/http:/本地路径）。
bool isSafePluginIconUrl(String? raw) {
  final trimmed = raw?.trim() ?? '';
  if (trimmed.isEmpty || trimmed.length > 512) return false;
  final uri = Uri.tryParse(trimmed);
  return uri != null && uri.scheme == 'https' && uri.host.isNotEmpty;
}

/// 插件操作错误文案：遇到 `PLUGIN_CONFLICT` 时尽量保留 Host 提供的具体冲突原因。
String pluginActionErrorMessage(Object error) {
  if (error is MobileRpcFailure && error.problem.code == 'PLUGIN_CONFLICT') {
    final detail = error.problem.message.trim();
    final fallback = manageErrorMessage(error);
    if (detail.isEmpty || detail == fallback) return fallback;
    if (detail.contains('冲突')) return detail;
    return '插件冲突：$detail';
  }
  return manageErrorMessage(error);
}

/// 插件图标：安全 `https://` 地址用网络图加载，缺失或加载失败时平滑回退到首字母色块头像。
class PluginAvatar extends StatelessWidget {
  const PluginAvatar({
    super.key,
    required this.seed,
    required this.label,
    this.iconUrl,
    this.size = 40,
    this.borderRadius = 10,
  });

  final String seed;
  final String label;
  final String? iconUrl;
  final double size;
  final double borderRadius;

  static const _lightSwatches = <({Color bg, Color fg})>[
    (bg: Color(0xFFE6F0FB), fg: Color(0xFF1A5DA8)),
    (bg: Color(0xFFE4F4EC), fg: Color(0xFF146C43)),
    (bg: Color(0xFFF6ECE1), fg: Color(0xFF9C5400)),
    (bg: Color(0xFFEDEAF8), fg: Color(0xFF4F3DA8)),
    (bg: Color(0xFFFBE9EC), fg: Color(0xFFA62639)),
    (bg: Color(0xFFE7F3F5), fg: Color(0xFF156570)),
  ];

  static const _darkSwatches = <({Color bg, Color fg})>[
    (bg: Color(0xFF213142), fg: Color(0xFF8EC0F8)),
    (bg: Color(0xFF1E3328), fg: Color(0xFF72D19A)),
    (bg: Color(0xFF3A2C1D), fg: Color(0xFFF2BE6B)),
    (bg: Color(0xFF2D2842), fg: Color(0xFFB7A6F5)),
    (bg: Color(0xFF3E2328), fg: Color(0xFFF38E9A)),
    (bg: Color(0xFF1E3236), fg: Color(0xFF7AC9D4)),
  ];

  String _initial() {
    final trimmed = label.trim();
    if (trimmed.isEmpty) return 'P';
    final rune = trimmed.runes.first;
    final ch = String.fromCharCode(rune);
    return ch.toUpperCase();
  }

  int _hash(String value) {
    var h = 2166136261;
    for (final code in value.codeUnits) {
      h ^= code;
      h = (h * 16777619) & 0x7fffffff;
    }
    return h;
  }

  Widget _buildFallback(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final swatches = dark ? _darkSwatches : _lightSwatches;
    final swatch = swatches[_hash(seed) % swatches.length];
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: swatch.bg,
        borderRadius: BorderRadius.circular(borderRadius),
      ),
      alignment: Alignment.center,
      child: Text(
        _initial(),
        style: TextStyle(
          fontSize: (size * 0.44).clamp(13.0, 22.0),
          fontWeight: FontWeight.w600,
          color: swatch.fg,
          height: 1,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!isSafePluginIconUrl(iconUrl)) {
      return _buildFallback(context);
    }
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return ClipRRect(
      borderRadius: BorderRadius.circular(borderRadius),
      child: Container(
        width: size,
        height: size,
        color: colors.field,
        child: Image.network(
          iconUrl!.trim(),
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => _buildFallback(context),
        ),
      ),
    );
  }
}

/// 紧凑状态胶囊标签（内置 / 有更新 / 冲突 / 异常 / 分类）。
class PluginStatusPill extends StatelessWidget {
  const PluginStatusPill({
    super.key,
    required this.label,
    required this.background,
    required this.foreground,
    this.icon,
  });

  final String label;
  final Color background;
  final Color foreground;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(6),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      spacing: 3,
      children: [
        if (icon case final iconData?)
          Icon(iconData, size: 11, color: foreground),
        Text(label, style: TimelineType.microStyle(foreground)),
      ],
    ),
  );
}

/// 插件详情底部抽屉：支持「已安装插件详情」和「市场插件详情」两种模式。
class PluginDetailSheet extends StatefulWidget {
  const PluginDetailSheet({
    super.key,
    required this.connectionListenable,
    required MobilePluginSummary this.plugin,
    this.displayNameOverride,
    this.descriptionOverride,
    this.iconUrl,
    this.availableUpdateVersion,
    this.onMutated,
  }) : marketplace = null,
       entry = null,
       installed = null,
       hasUpdate = false;

  const PluginDetailSheet.forMarketplace({
    super.key,
    required this.connectionListenable,
    required MobileMarketplaceSummary this.marketplace,
    required MobileMarketplacePlugin this.entry,
    this.installed,
    this.hasUpdate = false,
    this.onMutated,
  }) : plugin = null,
       displayNameOverride = null,
       descriptionOverride = null,
       iconUrl = null,
       availableUpdateVersion = null;

  static const updateButtonKey = ValueKey('plugin-detail-update');
  static const uninstallButtonKey = ValueKey('plugin-detail-uninstall');
  static const uninstallConfirmKey = ValueKey(
    'plugin-detail-uninstall-confirm',
  );
  static const installButtonKey = ValueKey('plugin-detail-install');

  final ValueListenable<MobileConnection?> connectionListenable;
  final MobilePluginSummary? plugin;
  final MobileMarketplaceSummary? marketplace;
  final MobileMarketplacePlugin? entry;
  final MobilePluginSummary? installed;
  final bool hasUpdate;
  final String? displayNameOverride;
  final String? descriptionOverride;
  final String? iconUrl;
  final String? availableUpdateVersion;
  final VoidCallback? onMutated;

  static Future<bool?> showInstalled(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    required MobilePluginSummary plugin,
    String? displayNameOverride,
    String? descriptionOverride,
    String? iconUrl,
    String? availableUpdateVersion,
    VoidCallback? onMutated,
  }) {
    final title = (displayNameOverride?.trim().isNotEmpty ?? false)
        ? displayNameOverride!.trim()
        : plugin.displayName;
    return showMobileSheet<bool>(
      context,
      title: title,
      content: (_) => SliverToBoxAdapter(
        child: PluginDetailSheet(
          connectionListenable: connectionListenable,
          plugin: plugin,
          displayNameOverride: displayNameOverride,
          descriptionOverride: descriptionOverride,
          iconUrl: iconUrl,
          availableUpdateVersion: availableUpdateVersion,
          onMutated: onMutated,
        ),
      ),
    );
  }

  static Future<bool?> showMarketplace(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    required MobileMarketplaceSummary marketplace,
    required MobileMarketplacePlugin entry,
    MobilePluginSummary? installed,
    bool hasUpdate = false,
    VoidCallback? onMutated,
  }) => showMobileSheet<bool>(
    context,
    title: entry.localizedDisplayName,
    content: (_) => SliverToBoxAdapter(
      child: PluginDetailSheet.forMarketplace(
        connectionListenable: connectionListenable,
        marketplace: marketplace,
        entry: entry,
        installed: installed,
        hasUpdate: hasUpdate,
        onMutated: onMutated,
      ),
    ),
  );

  @override
  State<PluginDetailSheet> createState() => _PluginDetailSheetState();
}

class _PluginDetailSheetState extends State<PluginDetailSheet> {
  bool _working = false;

  bool get _isMarketplaceMode => widget.entry != null;

  String get _effectiveDisplayName {
    if (_isMarketplaceMode) return widget.entry!.localizedDisplayName;
    final override = widget.displayNameOverride?.trim();
    if (override != null && override.isNotEmpty) return override;
    return widget.plugin!.displayName;
  }

  Future<void> _updatePlugin(String pluginId) async {
    final conn = widget.connectionListenable.value;
    if (conn == null || _working) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    setState(() => _working = true);
    try {
      await conn.plugins.update(id: pluginId);
      if (!mounted) return;
      widget.onMutated?.call();
      navigator.pop(true);
      messenger?.showSnackBar(
        SnackBar(content: Text('已更新 $_effectiveDisplayName')),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _working = false);
      messenger?.showSnackBar(
        SnackBar(content: Text(pluginActionErrorMessage(error))),
      );
    }
  }

  Future<void> _installFromMarketplace() async {
    final conn = widget.connectionListenable.value;
    final market = widget.marketplace;
    final entry = widget.entry;
    if (conn == null || market == null || entry == null || _working) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    setState(() => _working = true);
    try {
      await conn.plugins.installFromMarketplace(
        marketplace: market.id,
        name: entry.name,
      );
      if (!mounted) return;
      widget.onMutated?.call();
      navigator.pop(true);
      messenger?.showSnackBar(
        SnackBar(content: Text('已安装 ${entry.localizedDisplayName}')),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _working = false);
      messenger?.showSnackBar(
        SnackBar(content: Text(pluginActionErrorMessage(error))),
      );
    }
  }

  Future<void> _uninstallPlugin(MobilePluginSummary plugin) async {
    if (plugin.builtin || _working) return;
    if (widget.connectionListenable.value == null) return;
    final confirmed = await _confirmUninstallDialog(context);
    if (!mounted || !confirmed) return;
    final conn = widget.connectionListenable.value;
    if (conn == null) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    setState(() => _working = true);
    try {
      await conn.plugins.uninstall(id: plugin.id);
      if (!mounted) return;
      widget.onMutated?.call();
      navigator.pop(true);
      messenger?.showSnackBar(
        SnackBar(content: Text('已卸载 $_effectiveDisplayName')),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _working = false);
      messenger?.showSnackBar(
        SnackBar(content: Text(pluginActionErrorMessage(error))),
      );
    }
  }

  Future<bool> _confirmUninstallDialog(BuildContext context) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final colors = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: const Text('卸载插件？'),
          content: const Text('卸载后将移除插件文件；如果它是当前默认 Agent，将自动恢复为自动选择'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              key: PluginDetailSheet.uninstallConfirmKey,
              style: FilledButton.styleFrom(
                backgroundColor: colors.error,
                foregroundColor: colors.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('确认卸载'),
            ),
          ],
        );
      },
    );
    return result == true;
  }

  @override
  Widget build(BuildContext context) =>
      ValueListenableBuilder<MobileConnection?>(
        valueListenable: widget.connectionListenable,
        builder: (context, connection, _) {
          final online = connection != null;
          return _isMarketplaceMode
              ? _buildMarketplaceBody(context, online: online)
              : _buildInstalledBody(context, online: online);
        },
      );

  Widget _buildInstalledBody(BuildContext context, {required bool online}) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final plugin = widget.plugin!;
    final description = (widget.descriptionOverride?.trim().isNotEmpty ?? false)
        ? widget.descriptionOverride!.trim()
        : plugin.description?.trim();
    final versionText = formatPluginVersion(plugin.version);
    final updateVersion = formatPluginVersion(widget.availableUpdateVersion);
    final hasConflict =
        plugin.conflict != null && plugin.conflict!.trim().isNotEmpty;
    final hasError =
        plugin.error != null &&
        plugin.error!.trim().isNotEmpty &&
        plugin.error!.trim() != plugin.conflict?.trim();

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 6),
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            PluginAvatar(
              seed: plugin.id,
              label: _effectiveDisplayName,
              iconUrl: widget.iconUrl,
              size: 48,
              borderRadius: 12,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 4,
                children: [
                  Text(
                    plugin.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.metaMonoStyle(colors.secondaryText),
                  ),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      if (versionText.isNotEmpty)
                        PluginStatusPill(
                          label: versionText,
                          background: colors.field,
                          foreground: colors.secondaryText,
                        ),
                      PluginStatusPill(
                        label: pluginKindLabel(plugin.kind),
                        background: colors.field,
                        foreground: colors.secondaryText,
                      ),
                      if (plugin.builtin)
                        PluginStatusPill(
                          label: '内置',
                          background: colors.field,
                          foreground: colors.muted,
                        ),
                      if (updateVersion.isNotEmpty)
                        PluginStatusPill(
                          label: '有更新 $updateVersion',
                          background: colors.running.withValues(alpha: 0.14),
                          foreground: colors.running,
                        ),
                      PluginStatusPill(
                        label: plugin.enabled ? '已启用' : '已停用',
                        background: plugin.enabled
                            ? colors.readyMark.withValues(alpha: 0.14)
                            : colors.field,
                        foreground: plugin.enabled
                            ? colors.online
                            : colors.muted,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
        if (hasError) ...[
          const SizedBox(height: 14),
          _DetailNoticeBanner(
            title: '插件加载异常',
            message: plugin.error!.trim(),
            background: colors.errorTint,
            foreground: colors.error,
            icon: Icons.error_outline,
          ),
        ],
        if (hasConflict) ...[
          const SizedBox(height: 14),
          _DetailNoticeBanner(
            title: '服务冲突',
            message: plugin.conflict!.trim(),
            background: colors.attentionTint,
            foreground: colors.attention,
            icon: Icons.warning_amber_rounded,
          ),
        ],
        if (description != null && description.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text(
            description,
            style: TimelineType.contentStyle(colors.secondaryText),
          ),
        ],
        const SizedBox(height: 16),
        _DetailInfoCard(
          rows: [
            _DetailInfoRow(label: '包名', value: plugin.name, mono: true),
            if (versionText.isNotEmpty)
              _DetailInfoRow(
                label: '版本',
                value: updateVersion.isNotEmpty
                    ? '$versionText → $updateVersion'
                    : versionText,
              ),
            _DetailInfoRow(label: '分类', value: pluginKindLabel(plugin.kind)),
            _DetailInfoRow(label: '来源', value: pluginOriginDisplay(plugin)),
          ],
        ),
        const SizedBox(height: 16),
        _DetailChipSection(
          title: '声明权限',
          items: plugin.permissions,
          emptyLabel: '未声明额外权限',
        ),
        if (plugin.provides.isNotEmpty) ...[
          const SizedBox(height: 14),
          _DetailChipSection(title: '提供项', items: plugin.provides),
        ],
        if (!online) ...[
          const SizedBox(height: 14),
          Text(
            '电脑连接已断开，重连后可执行更新或卸载操作。',
            style: TimelineType.metaStyle(colors.muted),
          ),
        ],
        const SizedBox(height: 18),
        if (plugin.canUpdate) ...[
          FilledButton(
            key: PluginDetailSheet.updateButtonKey,
            onPressed: online && !_working
                ? () => _updatePlugin(plugin.id)
                : null,
            child: _working
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                  )
                : Text(
                    updateVersion.isNotEmpty ? '更新插件（$updateVersion）' : '更新插件',
                  ),
          ),
          const SizedBox(height: 10),
        ],
        if (plugin.builtin)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: colors.field,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: colors.border),
            ),
            child: Text(
              '内置插件不能卸载，如需关闭请在列表中停用',
              style: TimelineType.metaStyle(colors.muted),
            ),
          )
        else
          OutlinedButton(
            key: PluginDetailSheet.uninstallButtonKey,
            style: OutlinedButton.styleFrom(
              foregroundColor: colors.error,
              side: BorderSide(
                color: online
                    ? colors.error.withValues(alpha: 0.45)
                    : colors.border,
              ),
            ),
            onPressed: online && !_working
                ? () => _uninstallPlugin(plugin)
                : null,
            child: _working
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                  )
                : const Text('卸载插件'),
          ),
      ],
    );
  }

  Widget _buildMarketplaceBody(BuildContext context, {required bool online}) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final market = widget.marketplace!;
    final entry = widget.entry!;
    final installed = widget.installed;
    final hasUpdate = widget.hasUpdate && installed != null;
    final versionText = formatPluginVersion(entry.version);
    final description = entry.localizedDescription?.trim();
    final sourceSummary =
        entry.sourceLabel.trim().isNotEmpty &&
            entry.sourceLabel.trim() != market.displayName
        ? '${market.displayName} · ${entry.sourceLabel.trim()}'
        : market.displayName;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 6),
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            PluginAvatar(
              seed: '${market.id}/${entry.name}',
              label: entry.localizedDisplayName,
              iconUrl: entry.iconUrl,
              size: 48,
              borderRadius: 12,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 4,
                children: [
                  Text(
                    entry.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.metaMonoStyle(colors.secondaryText),
                  ),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      if (versionText.isNotEmpty)
                        PluginStatusPill(
                          label: versionText,
                          background: colors.field,
                          foreground: colors.secondaryText,
                        ),
                      if (entry.publisherType ==
                          MobileMarketplacePublisherType.official)
                        PluginStatusPill(
                          label: '官方',
                          background: colors.field,
                          foreground: colors.secondaryText,
                        )
                      else if (entry.publisherType ==
                          MobileMarketplacePublisherType.community)
                        PluginStatusPill(
                          label: '社区',
                          background: colors.field,
                          foreground: colors.secondaryText,
                        ),
                      if (hasUpdate)
                        PluginStatusPill(
                          label: '有更新',
                          background: colors.running.withValues(alpha: 0.14),
                          foreground: colors.running,
                        )
                      else if (installed != null)
                        PluginStatusPill(
                          label: '已安装',
                          background: colors.field,
                          foreground: colors.muted,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
        if (description != null && description.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text(
            description,
            style: TimelineType.contentStyle(colors.secondaryText),
          ),
        ],
        const SizedBox(height: 16),
        _DetailInfoCard(
          rows: [
            _DetailInfoRow(label: '包名', value: entry.name, mono: true),
            if (versionText.isNotEmpty)
              _DetailInfoRow(label: '版本', value: versionText),
            if (entry.author != null && entry.author!.trim().isNotEmpty)
              _DetailInfoRow(label: '作者', value: entry.author!.trim()),
            _DetailInfoRow(label: '来源', value: sourceSummary),
            if (entry.category != null && entry.category!.trim().isNotEmpty)
              _DetailInfoRow(label: '分类', value: entry.category!.trim()),
          ],
        ),
        if (!online) ...[
          const SizedBox(height: 14),
          Text(
            '电脑连接已断开，重连后可执行安装或更新操作。',
            style: TimelineType.metaStyle(colors.muted),
          ),
        ],
        const SizedBox(height: 18),
        if (hasUpdate)
          FilledButton(
            key: PluginDetailSheet.updateButtonKey,
            onPressed: online && !_working
                ? () => _updatePlugin(installed.id)
                : null,
            child: _working
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                  )
                : Text(versionText.isNotEmpty ? '更新插件（$versionText）' : '更新插件'),
          )
        else if (installed != null)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: colors.field,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: colors.border),
            ),
            alignment: Alignment.center,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              spacing: 6,
              children: [
                Icon(Icons.check, size: 16, color: colors.muted),
                Text('已安装', style: TimelineType.metaStyle(colors.muted)),
              ],
            ),
          )
        else
          FilledButton(
            key: PluginDetailSheet.installButtonKey,
            onPressed: online && !_working ? _installFromMarketplace : null,
            child: _working
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                  )
                : const Text('安装'),
          ),
      ],
    );
  }
}

class _DetailNoticeBanner extends StatelessWidget {
  const _DetailNoticeBanner({
    required this.title,
    required this.message,
    required this.background,
    required this.foreground,
    required this.icon,
  });

  final String title;
  final String message;
  final Color background;
  final Color foreground;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: foreground.withValues(alpha: 0.25)),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 8,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(icon, size: 16, color: foreground),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 2,
            children: [
              Text(
                title,
                style: TimelineType.metaStyle(
                  foreground,
                  weight: FontWeight.w600,
                ),
              ),
              Text(message, style: TimelineType.metaStyle(foreground)),
            ],
          ),
        ),
      ],
    ),
  );
}

class _DetailInfoRow {
  const _DetailInfoRow({
    required this.label,
    required this.value,
    this.mono = false,
  });

  final String label;
  final String value;
  final bool mono;
}

class _DetailInfoCard extends StatelessWidget {
  const _DetailInfoCard({required this.rows});

  final List<_DetailInfoRow> rows;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Container(
      decoration: BoxDecoration(
        color: colors.field,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) Divider(height: 1, indent: 14, color: colors.divider),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 60,
                    child: Text(
                      rows[i].label,
                      style: TimelineType.metaStyle(colors.muted),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      rows[i].value,
                      textAlign: TextAlign.end,
                      style: rows[i].mono
                          ? TimelineType.metaMonoStyle(colors.foreground)
                          : TimelineType.metaStyle(colors.foreground),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _DetailChipSection extends StatelessWidget {
  const _DetailChipSection({
    required this.title,
    required this.items,
    this.emptyLabel,
  });

  final String title;
  final List<String> items;
  final String? emptyLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 8,
      children: [
        Text(
          title,
          style: TimelineType.metaStyle(
            colors.secondaryText,
            weight: FontWeight.w600,
          ),
        ),
        if (items.isEmpty)
          Text(emptyLabel ?? '无', style: TimelineType.metaStyle(colors.muted))
        else
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final item in items)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: colors.field,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: colors.border),
                  ),
                  child: Text(
                    item,
                    style: TimelineType.metaMonoStyle(colors.secondaryText),
                  ),
                ),
            ],
          ),
      ],
    );
  }
}
