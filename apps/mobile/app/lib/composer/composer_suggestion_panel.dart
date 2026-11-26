import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../attachments/image_compressor.dart';
import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'composer_mentions.dart';
import 'composer_tokens.dart';
import 'mention_editing_controller.dart';

/// `+` 插入底部菜单的可选动作。
enum ComposerAttachAction { pickPhotos, takePhoto, mention, command, skill }

/// 手机端工具栏左下角灰色圆底 `+` 插入按钮（视觉圆 32px，触区 >= 44/48px）。
class MobileComposerAttachButton extends StatelessWidget {
  const MobileComposerAttachButton({
    super.key,
    required this.onSelectTrigger,
    this.enabled = true,
    this.offline = false,
    this.active = false,
    this.showMentions = true,
    this.showAttachments = false,
    this.attachmentCount = 0,
    this.onPickPhotos,
    this.onTakePhoto,
  });

  static const buttonKey = ValueKey('composer-attach-button');
  static const galleryOptionKey = ValueKey('composer-attach-gallery');
  static const cameraOptionKey = ValueKey('composer-attach-camera');
  static const mentionOptionKey = ValueKey('composer-attach-mention');
  static const commandOptionKey = ValueKey('composer-attach-command');
  static const skillOptionKey = ValueKey('composer-attach-skill');

  final ValueChanged<ComposerTriggerKind> onSelectTrigger;
  final bool enabled;
  final bool offline;
  final bool active;
  final bool showMentions;
  final bool showAttachments;
  final int attachmentCount;
  final VoidCallback? onPickPhotos;
  final VoidCallback? onTakePhoto;

  Future<void> _openSheet(BuildContext context) async {
    final chosen = await showMobileComposerAttachMenu(
      context,
      showMentions: showMentions,
      showAttachments: showAttachments,
      attachmentCount: attachmentCount,
    );
    switch (chosen) {
      case null:
        return;
      case ComposerAttachAction.pickPhotos:
        onPickPhotos?.call();
      case ComposerAttachAction.takePhoto:
        onTakePhoto?.call();
      case ComposerAttachAction.mention:
        onSelectTrigger(ComposerTriggerKind.mention);
      case ComposerAttachAction.command:
        onSelectTrigger(ComposerTriggerKind.command);
      case ComposerAttachAction.skill:
        onSelectTrigger(ComposerTriggerKind.skill);
    }
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final touch = timelineTouchHeight(context);

    return SizedBox.square(
      dimension: touch,
      child: IconButton(
        key: buttonKey,
        onPressed: enabled ? () => unawaited(_openSheet(context)) : null,
        tooltip: '添加内容',
        padding: EdgeInsets.zero,
        icon: DecoratedBox(
          decoration: BoxDecoration(
            color: ComposerSurface.attachFill(brightness, offline: offline),
            shape: BoxShape.circle,
          ),
          child: SizedBox.square(
            dimension: ComposerControl.attachDiameter,
            child: Center(
              child: IconTheme(
                data: IconThemeData(
                  color: ComposerSurface.attachIcon(
                    brightness,
                    enabled: enabled,
                    active: active,
                  ),
                ),
                child: const WorkspaceIcon(
                  WorkspaceGlyph.plus,
                  size: ComposerControl.attachIcon,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 弹出手机端 `+` 插入菜单（仅触发符号的兼容包装）。
Future<ComposerTriggerKind?> showMobileComposerAttachSheet(
  BuildContext context,
) async {
  final action = await showMobileComposerAttachMenu(
    context,
    showMentions: true,
    showAttachments: false,
  );
  return switch (action) {
    ComposerAttachAction.mention => ComposerTriggerKind.mention,
    ComposerAttachAction.command => ComposerTriggerKind.command,
    ComposerAttachAction.skill => ComposerTriggerKind.skill,
    _ => null,
  };
}

/// 弹出手机端 `+` 插入菜单：
/// - 电脑支持 `composer.attachments` 时，在顶部展示「相册选图」与「拍照」（达 6 张上限时禁用）；
/// - 旧版电脑未声明 `composer.attachments` 时自动隐藏图片项；
/// - 在线且支持提及时展示 `@`、`/`、`$`。
Future<ComposerAttachAction?> showMobileComposerAttachMenu(
  BuildContext context, {
  bool showMentions = true,
  bool showAttachments = false,
  int attachmentCount = 0,
}) {
  final atLimit = attachmentCount >= mobileMaxMessageAttachments;
  final galleryMeta = atLimit
      ? '已达上限'
      : attachmentCount > 0
      ? '$attachmentCount/$mobileMaxMessageAttachments'
      : '';
  final cameraMeta = atLimit ? '已达上限' : '';
  return showMobileSheet<ComposerAttachAction>(
    context,
    title: '添加到消息',
    content: (sheetContext) {
      final rows = <Widget>[];
      if (showAttachments) {
        rows.add(
          _AttachOptionRow(
            key: MobileComposerAttachButton.galleryOptionKey,
            glyph: WorkspaceGlyph.image,
            label: '相册选图',
            trigger: galleryMeta,
            dividerAbove: false,
            onTap: atLimit
                ? null
                : () => Navigator.pop(
                    sheetContext,
                    ComposerAttachAction.pickPhotos,
                  ),
          ),
        );
        rows.add(
          _AttachOptionRow(
            key: MobileComposerAttachButton.cameraOptionKey,
            glyph: WorkspaceGlyph.camera,
            label: '拍照',
            trigger: cameraMeta,
            dividerAbove: true,
            onTap: atLimit
                ? null
                : () => Navigator.pop(
                    sheetContext,
                    ComposerAttachAction.takePhoto,
                  ),
          ),
        );
      }
      if (showMentions) {
        rows.addAll([
          _AttachOptionRow(
            key: MobileComposerAttachButton.mentionOptionKey,
            glyph: WorkspaceGlyph.atSign,
            label: '引用文件或会话',
            trigger: '@',
            dividerAbove: rows.isNotEmpty,
            onTap: () =>
                Navigator.pop(sheetContext, ComposerAttachAction.mention),
          ),
          _AttachOptionRow(
            key: MobileComposerAttachButton.commandOptionKey,
            glyph: WorkspaceGlyph.slash,
            label: '运行命令',
            trigger: '/',
            dividerAbove: true,
            onTap: () =>
                Navigator.pop(sheetContext, ComposerAttachAction.command),
          ),
          _AttachOptionRow(
            key: MobileComposerAttachButton.skillOptionKey,
            glyph: WorkspaceGlyph.dollarSign,
            label: '使用 Skill',
            trigger: r'$',
            dividerAbove: true,
            onTap: () =>
                Navigator.pop(sheetContext, ComposerAttachAction.skill),
          ),
        ]);
      }
      return SliverList.list(children: rows);
    },
  );
}

class _AttachOptionRow extends StatelessWidget {
  const _AttachOptionRow({
    super.key,
    required this.glyph,
    required this.label,
    required this.trigger,
    required this.dividerAbove,
    required this.onTap,
  });

  final WorkspaceGlyph glyph;
  final String label;
  final String trigger;
  final bool dividerAbove;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = ComposerSurface.palette(theme.brightness);
    final enabled = onTap != null;
    final minHeight = math.max(
      ComposerControl.attachOptionMinHeight,
      timelineTouchHeight(context),
    );
    final semanticsLabel = trigger.isEmpty ? label : '$label（$trigger）';
    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticsLabel,
      child: Opacity(
        opacity: enabled ? 1.0 : ComposerControl.disabledOpacity,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: dividerAbove
                    ? Border(
                        top: BorderSide(
                          color: colors.divider,
                          width: ComposerBorder.regular,
                        ),
                      )
                    : null,
              ),
              child: Padding(
                padding: ComposerSpace.attachOptionPadding,
                child: Row(
                  spacing: ComposerSpace.attachOptionGap,
                  children: [
                    IconTheme(
                      data: IconThemeData(color: colors.secondaryText),
                      child: WorkspaceIcon(
                        glyph,
                        size: ComposerControl.attachOptionIcon,
                      ),
                    ),
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ComposerType.attachOptionTitle(
                          colors.foreground,
                          theme.platform,
                        ),
                      ),
                    ),
                    if (trigger.isNotEmpty)
                      Text(
                        trigger,
                        style: ComposerType.attachOptionMeta(colors.muted),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 紧贴输入框正上方渲染的实时联想面板，支持 `@`（会话+文件分组）、`/`（命令）与 `$`（Skill）。
class MobileComposerSuggestionPanel extends StatelessWidget {
  const MobileComposerSuggestionPanel({
    super.key,
    required this.triggerKind,
    required this.items,
    required this.loading,
    required this.onSelect,
    required this.onClose,
  });

  static const panelKey = ValueKey('composer-suggestion-panel');
  static const closeButtonKey = ValueKey('composer-suggestion-close');

  final ComposerTriggerKind triggerKind;
  final List<ComposerSuggestionItem> items;
  final bool loading;
  final ValueChanged<ComposerSuggestionItem> onSelect;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);
    final media = MediaQuery.of(context);
    final usableHeight =
        media.size.height - media.viewInsets.bottom - media.padding.vertical;
    final maxHeight = math.min(
      ComposerControl.suggestionMaxHeight,
      math.max(
        ComposerControl.suggestionMinHeight,
        usableHeight * ComposerControl.suggestionMaxHeightFactor,
      ),
    );

    final hasThreads = items.any(
      (item) => item.kind == ComposerSuggestionKind.thread,
    );
    final title = switch (triggerKind) {
      ComposerTriggerKind.mention => hasThreads ? '引用' : '文件',
      ComposerTriggerKind.command => '命令',
      ComposerTriggerKind.skill => 'Skill',
    };
    final emptyText = switch (triggerKind) {
      ComposerTriggerKind.mention => '没有匹配的文件或会话',
      ComposerTriggerKind.command => '没有匹配的命令',
      ComposerTriggerKind.skill => '没有匹配的 Skill',
    };

    final grouped = triggerKind == ComposerTriggerKind.mention && hasThreads;
    final rows = <_PanelRow>[];
    ComposerSuggestionKind? lastKind;
    for (final item in items) {
      if (grouped && item.kind != lastKind) {
        rows.add(
          _PanelRow.group(
            item.kind == ComposerSuggestionKind.thread ? '会话' : '文件',
          ),
        );
        lastKind = item.kind;
      }
      rows.add(_PanelRow.item(item));
    }

    final radius = BorderRadius.circular(ComposerRadius.suggestionPanel);

    return Padding(
      padding: ComposerSpace.suggestionPanelMargin,
      child: MobileGlassSurface(
        key: panelKey,
        borderRadius: radius,
        blurSigma: 20,
        tintOpacity: brightness == Brightness.dark ? 0.76 : 0.84,
        shadows: ComposerSurface.suggestionShadow(brightness),
        child: ClipRRect(
          borderRadius: radius,
          child: Material(
            type: MaterialType.transparency,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxHeight: maxHeight),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: ComposerSpace.suggestionHeaderPadding,
                    child: Row(
                      children: [
                        Expanded(
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            spacing: ComposerSpace.suggestionHeaderGap,
                            children: [
                              Flexible(
                                child: Text(
                                  title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ComposerType.suggestionTitle(
                                    colors.muted,
                                  ),
                                ),
                              ),
                              if (loading)
                                SizedBox.square(
                                  dimension:
                                      ComposerControl.suggestionSpinnerSize,
                                  child: CircularProgressIndicator(
                                    strokeWidth:
                                        ComposerControl.suggestionSpinnerStroke,
                                    color: colors.muted,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        SizedBox.square(
                          dimension: touch,
                          child: IconButton(
                            key: closeButtonKey,
                            tooltip: '关闭联想',
                            padding: EdgeInsets.zero,
                            onPressed: onClose,
                            icon: IconTheme(
                              data: IconThemeData(color: colors.muted),
                              child: const WorkspaceIcon(
                                WorkspaceGlyph.close,
                                size: ComposerControl.suggestionCloseIcon,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Divider(
                    height: ComposerBorder.hairline,
                    thickness: ComposerBorder.hairline,
                    color: colors.divider,
                  ),
                  if (items.isEmpty && !loading)
                    Padding(
                      padding: ComposerSpace.suggestionEmptyPadding,
                      child: Center(
                        child: Text(
                          emptyText,
                          textAlign: TextAlign.center,
                          style: ComposerType.suggestionDetail(colors.muted),
                        ),
                      ),
                    )
                  else if (items.isEmpty && loading)
                    Padding(
                      padding: ComposerSpace.suggestionEmptyPadding,
                      child: Center(
                        child: Text(
                          '正在查找…',
                          textAlign: TextAlign.center,
                          style: ComposerType.suggestionDetail(colors.muted),
                        ),
                      ),
                    )
                  else
                    Flexible(
                      child: ListView.builder(
                        shrinkWrap: true,
                        padding: ComposerSpace.suggestionPanelPadding,
                        itemCount: rows.length,
                        itemBuilder: (context, index) {
                          final row = rows[index];
                          if (row.groupTitle case final heading?) {
                            return Padding(
                              padding: ComposerSpace.suggestionGroupPadding,
                              child: Text(
                                heading,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: ComposerType.suggestionGroup(
                                  colors.muted,
                                ),
                              ),
                            );
                          }
                          final item = row.item!;
                          return _SuggestionItemRow(
                            item: item,
                            onTap: () => onSelect(item),
                          );
                        },
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PanelRow {
  const _PanelRow.group(this.groupTitle) : item = null;
  const _PanelRow.item(this.item) : groupTitle = null;

  final String? groupTitle;
  final ComposerSuggestionItem? item;
}

class _SuggestionItemRow extends StatelessWidget {
  const _SuggestionItemRow({required this.item, required this.onTap});

  final ComposerSuggestionItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);
    final radius = BorderRadius.circular(ComposerRadius.suggestionRow);
    final detail = item.detail;
    final hint = item.hint;
    final tag = item.tag;

    return Semantics(
      button: true,
      label: [
        item.label,
        if (hint != null && hint.isNotEmpty) hint,
        if (detail != null && detail.isNotEmpty) detail,
        if (tag != null && tag.isNotEmpty) tag,
      ].join(' '),
      child: InkWell(
        key: ValueKey('composer-suggestion-${item.id}'),
        onTap: onTap,
        borderRadius: radius,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: touch),
          child: Padding(
            padding: ComposerSpace.suggestionRowPadding,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              spacing: ComposerSpace.suggestionRowGap,
              children: [
                IconTheme(
                  data: IconThemeData(color: colors.secondaryText),
                  child: WorkspaceIcon(
                    item.glyph,
                    size: ComposerControl.suggestionIcon,
                  ),
                ),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    spacing: ComposerSpace.suggestionSubtitleGap,
                    children: [
                      Row(
                        spacing: ComposerSpace.suggestionTitleGap,
                        children: [
                          Flexible(
                            child: Text(
                              item.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ComposerType.suggestionLabel(
                                colors.foreground,
                              ),
                            ),
                          ),
                          if (hint != null && hint.isNotEmpty)
                            Flexible(
                              child: Text(
                                hint,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: ComposerType.suggestionHint(
                                  colors.faint,
                                ),
                              ),
                            ),
                        ],
                      ),
                      if (detail != null && detail.isNotEmpty)
                        Text(
                          detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ComposerType.suggestionDetail(colors.faint),
                        ),
                    ],
                  ),
                ),
                if (tag != null && tag.isNotEmpty)
                  DecoratedBox(
                    decoration: ComposerSurface.suggestionTag(brightness),
                    child: Padding(
                      padding: ComposerSpace.suggestionTagPadding,
                      child: Text(
                        tag,
                        maxLines: 1,
                        style: ComposerType.suggestionTag(colors.muted),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 已有会话（`RunComposer`）与新会话草稿（`NewThreadDraft`）共用的提及联想协调宿主：
/// 统一托管 `+` 按钮、触发识别、防抖 RPC、防乱序回写、内置命令执行与面板展示。
class MobileComposerMentionHost extends StatefulWidget {
  const MobileComposerMentionHost({
    super.key,
    required this.connection,
    required this.online,
    required this.controller,
    required this.focusNode,
    required this.builder,
    this.enabled = true,
    this.projectId,
    this.threadId,
    this.instanceId,
    this.projects = const [],
    this.threads = const [],
    this.supportsPlanMode = false,
    this.permissionModes = const [],
    this.canOpenModelPicker = false,
    this.onOpenModelPicker,
    this.onTogglePlanMode,
    this.onSelectPermissionMode,
    this.onTextChanged,
    this.externalLeading,
    this.supportsAttachments,
    this.attachmentCount = 0,
    this.onPickPhotos,
    this.onTakePhoto,
    this.searchDebounce = const Duration(milliseconds: 120),
  });

  final MobileConnection? connection;
  final bool online;
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;
  final String? projectId;
  final String? threadId;
  final String? instanceId;
  final List<MobileProjectSummary> projects;
  final List<MobileThreadSummary> threads;
  final bool supportsPlanMode;
  final List<MobileDraftPermission> permissionModes;
  final bool canOpenModelPicker;
  final VoidCallback? onOpenModelPicker;
  final VoidCallback? onTogglePlanMode;
  final ValueChanged<MobileDraftPermission>? onSelectPermissionMode;
  final ValueChanged<String>? onTextChanged;
  final Widget? externalLeading;
  final bool? supportsAttachments;
  final int attachmentCount;
  final VoidCallback? onPickPhotos;
  final VoidCallback? onTakePhoto;
  final Duration searchDebounce;
  final Widget Function(BuildContext context, Widget? leading) builder;

  @override
  State<MobileComposerMentionHost> createState() =>
      _MobileComposerMentionHostState();
}

class _MobileComposerMentionHostState extends State<MobileComposerMentionHost> {
  ComposerTriggerMatch? _trigger;
  ({ComposerTriggerKind kind, int start, int end, String text})? _dismissed;

  Timer? _pathDebounce;
  int _pathRequestSeq = 0;
  bool _loadingPaths = false;
  List<MobilePathEntry> _paths = const [];
  String? _lastPathScope;
  String? _lastPathQuery;

  int _commandRequestSeq = 0;
  bool _loadingCommands = false;
  List<MobileAgentCommand> _agentCommands = const [];
  String? _loadedCommandKey;

  bool get _mentionsEnabled =>
      widget.online && connectionSupportsComposerMentions(widget.connection);

  String? get _pathScope {
    if (widget.threadId case final id? when id.isNotEmpty) return 't:$id';
    if (widget.projectId case final id? when id.isNotEmpty) return 'p:$id';
    return null;
  }

  String? get _commandScope {
    final instanceId = widget.instanceId;
    if (instanceId == null || instanceId.isEmpty) return null;
    final scope = _pathScope ?? '';
    return '$instanceId|$scope';
  }

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_handleControllerChanged);
    _syncTrigger(fromController: false);
  }

  @override
  void didUpdateWidget(covariant MobileComposerMentionHost oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      oldWidget.controller.removeListener(_handleControllerChanged);
      widget.controller.addListener(_handleControllerChanged);
    }
    final becameDisabled = !_mentionsEnabled || !widget.enabled;
    if (becameDisabled) {
      _resetAllState(notify: false);
      return;
    }
    final connectionChanged = !identical(
      oldWidget.connection,
      widget.connection,
    );
    final scopeChanged =
        oldWidget.threadId != widget.threadId ||
        oldWidget.projectId != widget.projectId;
    final instanceChanged = oldWidget.instanceId != widget.instanceId;

    if (connectionChanged || scopeChanged) {
      _pathDebounce?.cancel();
      _pathRequestSeq++;
      _paths = const [];
      _loadingPaths = false;
      _lastPathScope = null;
      _lastPathQuery = null;
    }
    if (connectionChanged || scopeChanged || instanceChanged) {
      _commandRequestSeq++;
      _agentCommands = const [];
      _loadingCommands = false;
      _loadedCommandKey = null;
    }
    _syncTrigger(fromController: false);
  }

  @override
  void dispose() {
    _pathDebounce?.cancel();
    widget.controller.removeListener(_handleControllerChanged);
    super.dispose();
  }

  void _handleControllerChanged() {
    _syncTrigger(fromController: true);
  }

  void _resetAllState({required bool notify}) {
    _pathDebounce?.cancel();
    _pathRequestSeq++;
    _commandRequestSeq++;
    final hadActive =
        _trigger != null ||
        _loadingPaths ||
        _loadingCommands ||
        _paths.isNotEmpty;
    _trigger = null;
    _dismissed = null;
    _paths = const [];
    _loadingPaths = false;
    _lastPathScope = null;
    _lastPathQuery = null;
    _agentCommands = const [];
    _loadingCommands = false;
    _loadedCommandKey = null;
    if (notify && hadActive && mounted) {
      setState(() {});
    }
  }

  void _syncTrigger({required bool fromController}) {
    if (!_mentionsEnabled || !widget.enabled) {
      if (_trigger != null) {
        _resetAllState(notify: fromController);
      }
      return;
    }

    final value = widget.controller.value;
    final detected = detectComposerTrigger(value);

    // 若用户刚点过关闭且触发位置与文本未发生变化，保持隐藏。
    if (detected != null && _dismissed != null) {
      final d = _dismissed!;
      if (d.kind == detected.kind &&
          d.start == detected.start &&
          d.end == detected.end &&
          d.text == value.text) {
        return;
      }
      _dismissed = null;
    } else if (detected == null) {
      _dismissed = null;
    }

    final previous = _trigger;
    final exited = previous != null && detected == null;
    final kindChanged = previous?.kind != detected?.kind;

    if (exited || kindChanged) {
      if (previous?.kind == ComposerTriggerKind.mention) {
        _pathDebounce?.cancel();
        _pathRequestSeq++;
        _loadingPaths = false;
        _paths = const [];
        _lastPathQuery = null;
        _lastPathScope = null;
      }
      if (previous?.kind == ComposerTriggerKind.command ||
          previous?.kind == ComposerTriggerKind.skill) {
        // 退出 `/` 或 `$` 后重置缓存，下次重新打开再刷新（对齐 GLOSSARY 规范）。
        if (detected?.kind != ComposerTriggerKind.command &&
            detected?.kind != ComposerTriggerKind.skill) {
          _commandRequestSeq++;
          _loadingCommands = false;
          _agentCommands = const [];
          _loadedCommandKey = null;
        }
      }
    }

    _trigger = detected;

    if (detected != null) {
      switch (detected.kind) {
        case ComposerTriggerKind.mention:
          _requestPaths(
            detected.query,
            immediate: previous?.kind != ComposerTriggerKind.mention,
          );
        case ComposerTriggerKind.command || ComposerTriggerKind.skill:
          _requestCommandsIfNeeded();
      }
    }

    if (fromController && mounted) {
      setState(() {});
    }
  }

  void _requestPaths(String query, {required bool immediate}) {
    final connection = widget.connection;
    final scope = _pathScope;
    if (connection == null || !_mentionsEnabled || scope == null) {
      _loadingPaths = false;
      _paths = const [];
      return;
    }
    if (_lastPathScope == scope && _lastPathQuery == query) {
      return;
    }
    _lastPathScope = scope;
    _lastPathQuery = query;
    _pathDebounce?.cancel();
    final seq = ++_pathRequestSeq;
    _loadingPaths = true;

    Future<void> run() async {
      final normalizedQuery = query.length > mobileSearchPathsQueryLimit
          ? query.substring(0, mobileSearchPathsQueryLimit)
          : query;
      try {
        final result = await connection.mentions.searchPaths(
          threadId: widget.threadId,
          projectId: widget.threadId == null ? widget.projectId : null,
          query: normalizedQuery,
          limit: mobileSearchPathsDefaultLimit,
        );
        if (!mounted ||
            seq != _pathRequestSeq ||
            _trigger?.kind != ComposerTriggerKind.mention) {
          return;
        }
        setState(() {
          _paths = result.entries;
          _loadingPaths = false;
        });
      } catch (_) {
        if (!mounted || seq != _pathRequestSeq) return;
        setState(() {
          _paths = const [];
          _loadingPaths = false;
        });
      }
    }

    if (immediate || widget.searchDebounce <= Duration.zero) {
      unawaited(run());
    } else {
      _pathDebounce = Timer(widget.searchDebounce, () => unawaited(run()));
    }
  }

  void _requestCommandsIfNeeded() {
    final connection = widget.connection;
    final instanceId = widget.instanceId;
    final scopeKey = _commandScope;
    if (connection == null ||
        !_mentionsEnabled ||
        instanceId == null ||
        instanceId.isEmpty ||
        scopeKey == null) {
      _loadingCommands = false;
      return;
    }
    if (_loadedCommandKey == scopeKey) return;
    _loadedCommandKey = scopeKey;
    final seq = ++_commandRequestSeq;
    _loadingCommands = true;

    unawaited(
      connection.mentions
          .agentCommands(
            instanceId: instanceId,
            threadId: widget.threadId,
            projectId: widget.threadId == null ? widget.projectId : null,
            refresh: true,
          )
          .then<void>(
            (result) {
              if (!mounted || seq != _commandRequestSeq) return;
              setState(() {
                _agentCommands = result.commands;
                _loadingCommands = false;
              });
            },
            onError: (Object _) {
              if (!mounted || seq != _commandRequestSeq) return;
              setState(() {
                _loadingCommands = false;
              });
            },
          ),
    );
  }

  void _handleInsertTrigger(ComposerTriggerKind kind) {
    if (!_mentionsEnabled || !widget.enabled) return;
    _dismissed = null;
    final nextValue = insertComposerTriggerCharacter(
      widget.controller.value,
      kind,
    );
    widget.controller.value = nextValue;
    widget.onTextChanged?.call(nextValue.text);
    widget.focusNode.requestFocus();
  }

  void _handleDismiss() {
    final active = _trigger;
    if (active == null) return;
    setState(() {
      _dismissed = (
        kind: active.kind,
        start: active.start,
        end: active.end,
        text: widget.controller.text,
      );
      _trigger = null;
    });
  }

  void _handleSelectItem(ComposerSuggestionItem item) {
    final active = _trigger;
    if (active == null) return;
    final controller = widget.controller;

    switch (item.kind) {
      case ComposerSuggestionKind.thread:
        final ref = item.threadReference;
        if (ref == null) return;
        if (controller is ComposerTextEditingController) {
          controller.recordThreadReference(ref);
        }
        final next = applyComposerTriggerInsertion(
          controller.value,
          active,
          '@${ref.title} ',
        );
        controller.value = next;
        widget.onTextChanged?.call(next.text);
        widget.focusNode.requestFocus();
      case ComposerSuggestionKind.file:
        final path = item.filePath;
        if (path == null) return;
        if (controller is ComposerTextEditingController) {
          controller.recordFileMention(path);
        }
        final next = applyComposerTriggerInsertion(
          controller.value,
          active,
          '@$path ',
        );
        controller.value = next;
        widget.onTextChanged?.call(next.text);
        widget.focusNode.requestFocus();
      case ComposerSuggestionKind.command:
        if (item.builtinCommand case final builtin?) {
          final next = applyComposerTriggerInsertion(
            controller.value,
            active,
            '',
          );
          controller.value = next;
          widget.onTextChanged?.call(next.text);
          switch (builtin.actionKind) {
            case ComposerBuiltinActionKind.openModelPicker:
              widget.onOpenModelPicker?.call();
            case ComposerBuiltinActionKind.togglePlanMode:
              widget.onTogglePlanMode?.call();
            case ComposerBuiltinActionKind.setPermissionMode:
              if (builtin.permissionMode case final mode?) {
                widget.onSelectPermissionMode?.call(mode);
              }
          }
          return;
        }
        if (item.agentCommand case final remote?) {
          final next = applyComposerTriggerInsertion(
            controller.value,
            active,
            '${remote.text} ',
          );
          controller.value = next;
          widget.onTextChanged?.call(next.text);
          widget.focusNode.requestFocus();
        }
      case ComposerSuggestionKind.skill:
        final skill = item.agentCommand;
        if (skill == null) return;
        final next = applyComposerTriggerInsertion(
          controller.value,
          active,
          '${skill.text} ',
        );
        controller.value = next;
        widget.onTextChanged?.call(next.text);
        widget.focusNode.requestFocus();
    }
  }

  List<ComposerSuggestionItem> _buildItems(ComposerTriggerMatch trigger) {
    switch (trigger.kind) {
      case ComposerTriggerKind.mention:
        final threads = matchComposerThreads(
          threads: widget.threads,
          projects: widget.projects,
          currentProjectId: widget.projectId,
          currentThreadId: widget.threadId,
          query: trigger.query,
        );
        return buildMentionSuggestions(threads: threads, paths: _paths);
      case ComposerTriggerKind.command:
        final builtins = buildComposerBuiltinCommands(
          canOpenModelPicker:
              widget.canOpenModelPicker && widget.onOpenModelPicker != null,
          supportsPlanMode:
              widget.supportsPlanMode && widget.onTogglePlanMode != null,
          permissionModes: widget.onSelectPermissionMode != null
              ? widget.permissionModes
              : const [],
        );
        return buildSlashCommandSuggestions(
          builtins: builtins,
          agentCommands: _agentCommands,
          query: trigger.query,
        );
      case ComposerTriggerKind.skill:
        return buildSkillSuggestions(
          agentCommands: _agentCommands,
          query: trigger.query,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final active = _mentionsEnabled && widget.enabled ? _trigger : null;
    final showAttachments =
        (widget.supportsAttachments ??
            connectionSupportsAttachments(widget.connection)) &&
        (widget.onPickPhotos != null || widget.onTakePhoto != null);
    final showAttachButton = _mentionsEnabled || showAttachments;
    final Widget? leading =
        widget.externalLeading ??
        (showAttachButton
            ? MobileComposerAttachButton(
                enabled: widget.enabled,
                offline: !widget.online,
                active: active != null,
                showMentions: _mentionsEnabled,
                showAttachments: showAttachments,
                attachmentCount: widget.attachmentCount,
                onSelectTrigger: _handleInsertTrigger,
                onPickPhotos: widget.onPickPhotos,
                onTakePhoto: widget.onTakePhoto,
              )
            : null);

    final composer = widget.builder(context, leading);
    if (active == null) return composer;

    final items = _buildItems(active);
    final loading = active.kind == ComposerTriggerKind.mention
        ? _loadingPaths
        : _loadingCommands;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MobileComposerSuggestionPanel(
          triggerKind: active.kind,
          items: items,
          loading: loading,
          onSelect: _handleSelectItem,
          onClose: _handleDismiss,
        ),
        composer,
      ],
    );
  }
}
