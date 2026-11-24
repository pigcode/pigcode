import 'package:pigcode_client/pigcode_client.dart';

String threadStatusText(MobileThreadStatus status) => switch (status) {
  MobileThreadStatus.idle => '还没运行',
  MobileThreadStatus.queued => '排队中',
  MobileThreadStatus.running => '运行中',
  MobileThreadStatus.waitingApproval => '等你处理',
  MobileThreadStatus.completed => '已完成',
  MobileThreadStatus.failed => '失败',
  MobileThreadStatus.interrupted => '已停下',
};

bool needsAttention(MobileThreadSummary thread) =>
    thread.status == MobileThreadStatus.waitingApproval || thread.unread;

String waitingThreadLabel(MobileThreadSummary thread) =>
    switch (thread.pendingKind) {
      MobileThreadPendingKind.approval => '等你确认',
      MobileThreadPendingKind.question => '等你回答',
      null => threadStatusText(MobileThreadStatus.waitingApproval),
    };

String? threadMarker(MobileThreadSummary thread) => switch (thread.status) {
  MobileThreadStatus.failed => '出错',
  MobileThreadStatus.waitingApproval => waitingThreadLabel(thread),
  MobileThreadStatus.queued ||
  MobileThreadStatus.running => threadStatusText(thread.status),
  _ => thread.unread ? '未读' : null,
};
