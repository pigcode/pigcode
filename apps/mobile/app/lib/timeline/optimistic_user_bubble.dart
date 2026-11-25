import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../attachments/image_viewer_page.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline_widgets.dart';
import '../workspace_icon.dart';
import 'timeline_tokens.dart';
import 'user_bubble.dart';

enum OptimisticMessageStatus { sending, unconfirmed, rejected, accepted }

/// 聊天式乐观上屏的用户消息：发送瞬间清空输入框并展示在时间线底部，
/// 失败或未确认时在气泡旁提供红色感叹号，支持点按重发（复用原 commandId）、查回执、放回输入框与删除。
class OptimisticUserMessage {
  const OptimisticUserMessage({
    required this.commandId,
    required this.text,
    required this.status,
    this.attachments = const [],
    this.errorText,
    this.runId,
    this.queuedMessageId,
    this.params,
  });

  final String commandId;
  final String text;
  final OptimisticMessageStatus status;
  final List<MobileAttachmentRef> attachments;
  final String? errorText;
  final String? runId;
  final String? queuedMessageId;
  final MobileStartRunParams? params;

  bool get actionable =>
      status == OptimisticMessageStatus.unconfirmed ||
      status == OptimisticMessageStatus.rejected;

  @override
  bool operator ==(Object other) =>
      other is OptimisticUserMessage &&
      other.commandId == commandId &&
      other.text == text &&
      other.status == status &&
      other.errorText == errorText &&
      other.runId == runId &&
      other.queuedMessageId == queuedMessageId &&
      other.attachments.length == attachments.length;

  @override
  int get hashCode => Object.hash(
    commandId,
    text,
    status,
    errorText,
    runId,
    queuedMessageId,
    attachments.length,
  );
}

class TimelineOptimisticUserBubble extends StatelessWidget {
  const TimelineOptimisticUserBubble({
    super.key,
    required this.message,
    required this.online,
    this.onTapAction,
    this.onMention,
    this.peekAttachmentThumb,
    this.loadAttachmentThumb,
    this.loadAttachmentFull,
  });

  static const failedBadgeKey = ValueKey('optimistic-bubble-failed-badge');
  static const sendingSpinnerKey = ValueKey('optimistic-bubble-sending');

  final OptimisticUserMessage message;
  final bool online;
  final VoidCallback? onTapAction;
  final Future<void> Function(String path)? onMention;
  final AttachmentThumbPeeker? peekAttachmentThumb;
  final AttachmentBytesLoader? loadAttachmentThumb;
  final AttachmentBytesLoader? loadAttachmentFull;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final disableAnimations = MediaQuery.disableAnimationsOf(context);

    final Widget? leadingStatus;
    final Widget? statusCaption;
    final double bubbleOpacity;

    switch (message.status) {
      case OptimisticMessageStatus.sending:
        bubbleOpacity = 0.86;
        leadingStatus = Padding(
          padding: const EdgeInsets.only(right: TimelineSpace.x4),
          child: Semantics(
            label: '正在发送',
            child: SizedBox.square(
              key: sendingSpinnerKey,
              dimension: TimelineIcon.meta,
              child: CircularProgressIndicator(
                strokeWidth: 1.6,
                color: colors.faint,
                value: disableAnimations ? 0.72 : null,
              ),
            ),
          ),
        );
        statusCaption = null;
      case OptimisticMessageStatus.unconfirmed:
      case OptimisticMessageStatus.rejected:
        bubbleOpacity = 1.0;
        leadingStatus = Tooltip(
          message: '查看发送选项',
          child: Semantics(
            button: true,
            label: message.status == OptimisticMessageStatus.rejected
                ? '消息发送失败，点按重试或处理'
                : '消息发送未确认，点按重试或处理',
            child: GestureDetector(
              key: failedBadgeKey,
              behavior: HitTestBehavior.opaque,
              onTap: onTapAction,
              child: SizedBox.square(
                dimension: timelineTouchHeight(context),
                child: Center(
                  child: Container(
                    width: 22,
                    height: 22,
                    decoration: BoxDecoration(
                      color: colors.error,
                      shape: BoxShape.circle,
                    ),
                    alignment: Alignment.center,
                    child: Icon(
                      Icons.priority_high_rounded,
                      size: 14,
                      color: colors.onError,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        final captionText = switch (message.status) {
          OptimisticMessageStatus.rejected =>
            message.errorText?.trim().isNotEmpty == true
                ? message.errorText!
                : '发送失败 · 点按重发',
          OptimisticMessageStatus.unconfirmed =>
            online ? '未确认发送 · 点按处理' : '离线未发送 · 点按处理',
          _ => '',
        };
        statusCaption = GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTapAction,
          child: Padding(
            padding: const EdgeInsets.only(right: TimelineSpace.x1),
            child: Text(
              captionText,
              style: TimelineType.microStyle(
                message.status == OptimisticMessageStatus.rejected
                    ? colors.error
                    : colors.muted,
              ),
            ),
          ),
        );
      case OptimisticMessageStatus.accepted:
        bubbleOpacity = 1.0;
        leadingStatus = null;
        statusCaption = null;
    }

    final displayText =
        message.text.trim().isNotEmpty || message.attachments.isNotEmpty
        ? message.text
        : '[图片]';

    return Padding(
      padding: const EdgeInsets.only(
        top: TimelineSpace.x7,
        bottom: TimelineSpace.x4,
      ),
      child: TimelineUserBubble(
        text: displayText,
        showActions: false,
        leadingStatus: leadingStatus,
        statusCaption: statusCaption,
        bubbleOpacity: bubbleOpacity,
        onBubbleTap: message.actionable ? onTapAction : null,
        onMention: onMention,
        attachments: message.attachments,
        peekAttachmentThumb: peekAttachmentThumb,
        loadAttachmentThumb: loadAttachmentThumb,
        loadAttachmentFull: loadAttachmentFull,
      ),
    );
  }
}

enum OptimisticMessageAction { resend, checkReceipt, restoreToInput, copy, delete }

/// 点按失败/未确认气泡或感叹号弹出的聊天式处理菜单。
Future<void> showOptimisticMessageActionsSheet(
  BuildContext context, {
  required OptimisticUserMessage message,
  required bool online,
  VoidCallback? onResend,
  VoidCallback? onCheckReceipt,
  VoidCallback? onRestoreToInput,
  VoidCallback? onDelete,
}) async {
  final isRejected = message.status == OptimisticMessageStatus.rejected;
  final subtitle = isRejected
      ? (message.errorText?.trim().isNotEmpty == true
            ? message.errorText!
            : '电脑端未能接收这条消息。')
      : online
      ? '重发会复用原编号，不会重复触发两轮回复。'
      : '当前电脑离线，连上后可重试发送或查回执。';

  final actions = <(WorkspaceGlyph?, IconData?, String, OptimisticMessageAction, bool)>[
    if (onResend != null && online)
      (null, Icons.refresh_rounded, '重新发送', OptimisticMessageAction.resend, false),
    if (!isRejected && onCheckReceipt != null && online)
      (
        null,
        Icons.fact_check_outlined,
        '检查是否已送达',
        OptimisticMessageAction.checkReceipt,
        false,
      ),
    if (message.text.trim().isNotEmpty && onRestoreToInput != null)
      (
        WorkspaceGlyph.compose,
        null,
        '放回输入框编辑',
        OptimisticMessageAction.restoreToInput,
        false,
      ),
    if (message.text.isNotEmpty)
      (null, Icons.copy_rounded, '复制文字', OptimisticMessageAction.copy, false),
    if (onDelete != null)
      (
        null,
        Icons.delete_outline_rounded,
        '删除这条未发消息',
        OptimisticMessageAction.delete,
        true,
      ),
  ];

  final chosen = await showMobileSheet<OptimisticMessageAction>(
    context,
    title: isRejected ? '消息未发送' : '消息发送未确认',
    content: (sheet) {
      final colors = Theme.of(sheet).brightness == Brightness.dark
          ? pigcodeDark
          : pigcodeLight;
      return SliverList(
        delegate: SliverChildListDelegate([
          Padding(
            padding: const EdgeInsets.only(bottom: TimelineSpace.x5),
            child: Text(
              subtitle,
              style: TimelineType.metaStyle(colors.muted),
            ),
          ),
          for (var i = 0; i < actions.length; i++)
            MobileSheetAction(
              glyph: actions[i].$1,
              icon: actions[i].$2,
              label: actions[i].$3,
              destructive: actions[i].$5,
              dividerAbove: true,
              onTap: () => Navigator.pop(sheet, actions[i].$4),
            ),
        ]),
      );
    },
  );
  if (chosen == null) return;
  switch (chosen) {
    case OptimisticMessageAction.resend:
      onResend?.call();
    case OptimisticMessageAction.checkReceipt:
      onCheckReceipt?.call();
    case OptimisticMessageAction.restoreToInput:
      onRestoreToInput?.call();
    case OptimisticMessageAction.copy:
      await Clipboard.setData(ClipboardData(text: message.text));
    case OptimisticMessageAction.delete:
      onDelete?.call();
  }
}
