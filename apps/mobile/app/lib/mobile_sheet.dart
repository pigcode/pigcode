import 'package:flutter/material.dart';

Future<T?> showMobileSheet<T>(
  BuildContext context, {
  required String title,
  required WidgetBuilder builder,
}) => showModalBottomSheet<T>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  useSafeArea: true,
  sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
      ? AnimationStyle.noAnimation
      : const AnimationStyle(
          duration: Duration(milliseconds: 260),
          reverseDuration: Duration(milliseconds: 200),
        ),
  builder: (sheet) => LayoutBuilder(
    builder: (context, constraints) => ConstrainedBox(
      constraints: BoxConstraints(maxHeight: constraints.maxHeight * .88),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 20, end: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(
                              fontSize: 17,
                              fontWeight: FontWeight.w500,
                            ),
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭弹层',
                    onPressed: () => Navigator.pop(sheet),
                    icon: const Icon(Icons.close, size: 20),
                  ),
                ],
              ),
            ),
            Flexible(child: builder(sheet)),
          ],
        ),
      ),
    ),
  ),
);
