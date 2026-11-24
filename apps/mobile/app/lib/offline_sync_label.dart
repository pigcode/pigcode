import 'package:flutter/material.dart';

String offlineSyncLabel(DateTime syncedAt) {
  final local = syncedAt.toLocal();
  final now = DateTime.now();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  final time = '$hour:$minute';
  if (DateUtils.isSameDay(local, now)) return '上次同步 $time';
  final year = local.year == now.year ? '' : '${local.year}年';
  return '上次同步 $year${local.month}月${local.day}日 $time';
}
