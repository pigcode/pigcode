import 'package:flutter/material.dart';

enum SidebarGrouping { project, time, status }

enum SidebarSort { recent, status, title }

enum SidebarCategory { attention, error, unread, working, done }

const sidebarCategoryLabels = {
  SidebarCategory.attention: '需要处理',
  SidebarCategory.error: '出错',
  SidebarCategory.unread: '未读',
  SidebarCategory.working: '进行中',
  SidebarCategory.done: '已完成',
};

typedef SidebarArrangement = ({
  SidebarGrouping grouping,
  SidebarSort sort,
  Set<SidebarCategory> filters,
  bool archived,
});

const defaultSidebarArrangement = (
  grouping: SidebarGrouping.project,
  sort: SidebarSort.recent,
  filters: {...SidebarCategory.values},
  archived: false,
);

Future<bool?> showSidebarOptions(
  BuildContext context, {
  required SidebarArrangement current,
  required ValueChanged<SidebarArrangement> onChanged,
  required bool canMarkAllRead,
}) {
  var arrangement = current;
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (sheet) => StatefulBuilder(
      builder: (context, setState) {
        void change({
          SidebarGrouping? grouping,
          SidebarSort? sort,
          Set<SidebarCategory>? filters,
          bool? archived,
        }) {
          setState(() {
            arrangement = (
              grouping: grouping ?? arrangement.grouping,
              sort: sort ?? arrangement.sort,
              filters: filters ?? arrangement.filters,
              archived: archived ?? arrangement.archived,
            );
          });
          onChanged(arrangement);
        }

        return SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('分组'),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final (value, label) in const [
                      (SidebarGrouping.project, '项目'),
                      (SidebarGrouping.time, '更新时间'),
                      (SidebarGrouping.status, '状态'),
                    ])
                      ChoiceChip(
                        label: Text(label),
                        selected: arrangement.grouping == value,
                        onSelected: (_) => change(grouping: value),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                const Text('排序'),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final (value, label) in const [
                      (SidebarSort.recent, '更新时间'),
                      (SidebarSort.status, '状态'),
                      (SidebarSort.title, '按名称'),
                    ])
                      ChoiceChip(
                        label: Text(label),
                        selected: arrangement.sort == value,
                        onSelected: (_) => change(sort: value),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                const Text('筛选'),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final category in SidebarCategory.values)
                      FilterChip(
                        label: Text(sidebarCategoryLabels[category]!),
                        selected: arrangement.filters.contains(category),
                        onSelected: arrangement.archived
                            ? null
                            : (selected) {
                                final next = {...arrangement.filters};
                                if (selected) {
                                  next.add(category);
                                } else {
                                  next.remove(category);
                                }
                                change(
                                  filters: next.isEmpty
                                      ? defaultSidebarArrangement.filters
                                      : next,
                                );
                              },
                      ),
                  ],
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('只看已归档'),
                  value: arrangement.archived,
                  onChanged: (value) => change(archived: value),
                ),
                TextButton(
                  onPressed: canMarkAllRead
                      ? () => Navigator.pop(sheet, true)
                      : null,
                  child: const Text('全部标为已读'),
                ),
              ],
            ),
          ),
        );
      },
    ),
  );
}
