import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_mobile/timeline_widgets.dart';

const _summary = '''完成了，格式化逻辑已经抽到 `src/format.ts`：

### 改动

| 文件 | 改动 |
| --- | --- |
| `src/format.ts` | 新建，导出 `formatAnswer` |
| `src/index.ts` | 改用 `formatAnswer` |
| `src/format.test.ts` | 新增 2 条测试 |

```ts
export function formatAnswer(value: number): string {
  return `The answer is \${value}`
}
```

- [x] lint 通过
- [x] 5 个测试全部通过
- [ ] README 的用法说明留到下一步

> 参考了 [Vitest 文档](https://vitest.dev/guide/) 里内联快照的写法。''';

void main() {
  testWidgets('renders the showcase markdown answer', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TimelineAnswer(text: _summary, padding: EdgeInsets.zero),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
