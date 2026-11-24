/// 时间线里的相对时间：刚刚、N 分钟、N 小时、昨天、N 天，再久显示日期。
String timelineRelativeTime(String? iso, {DateTime? now}) {
  if (iso == null) return '';
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return '';
  final local = parsed.toLocal();
  final current = (now ?? DateTime.now()).toLocal();
  final diff = current.difference(local);
  if (diff.isNegative || diff.inSeconds < 45) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟';
  if (diff.inHours < 24) return '${diff.inHours} 小时';
  final start = DateTime(current.year, current.month, current.day);
  final day = DateTime(local.year, local.month, local.day);
  final days = start.difference(day).inDays;
  if (days == 1) return '昨天';
  if (days < 7) return '$days 天';
  if (local.year == current.year) return '${local.month}月${local.day}日';
  return '${local.year}年${local.month}月${local.day}日';
}
