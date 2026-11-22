import 'package:flutter/material.dart';

String offlineSyncLabel(BuildContext context, DateTime syncedAt) {
  final local = syncedAt.toLocal();
  final format = MaterialLocalizations.of(context);
  final time = format.formatTimeOfDay(TimeOfDay.fromDateTime(local));
  return '上次同步 ${DateUtils.isSameDay(local, DateTime.now()) ? time : '${format.formatShortDate(local)} $time'}';
}
