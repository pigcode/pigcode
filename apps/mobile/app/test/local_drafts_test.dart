import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_mobile/local_drafts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
    'replaying a withdrawal receipt preserves newer edits and appends once',
    () async {
      final initial = ThreadDraftStorage('a', 'thread');
      await initial.save('原草稿');
      final first = await initial.restoreWithdrawal(
        'receipt',
        '撤回的原文',
        fallback: '',
      );
      expect(first, (text: '原草稿\n撤回的原文', appended: true));
      await initial.save('更新过的草稿', previous: '原草稿');
      for (var i = 0; i < localDraftLimit; i++) {
        await ThreadDraftStorage('a', 'other-$i').save('后写的草稿 $i');
      }

      final restarted = ThreadDraftStorage('a', 'thread');
      final repeated = await restarted.restoreWithdrawal(
        'receipt',
        '撤回的原文',
        fallback: '',
      );
      expect(repeated, (text: '更新过的草稿\n撤回的原文', appended: false));
      await restarted.finishWithdrawal('receipt');
      expect(await restarted.read(), '更新过的草稿\n撤回的原文');
    },
  );

  test(
    'stores the thirty most recently edited drafts across computers',
    () async {
      final a = ThreadDraftStorage('a', 'shared');
      final b = ThreadDraftStorage('b', 'shared');
      await a.save('甲电脑的草稿');
      await b.save('乙电脑的草稿');
      for (var i = 0; i < 28; i++) {
        await ThreadDraftStorage('a', 'draft-$i').save('草稿 $i');
      }
      await a.save('甲电脑最近修改');
      await ThreadDraftStorage('b', 'another').save('新草稿');
      expect(await ThreadDraftStorage('a', 'shared').read(), '甲电脑最近修改');
      expect(await ThreadDraftStorage('b', 'shared').read(), isEmpty);

      final clearing = clearComputerDrafts('a');
      await a.save('旧界面的迟到草稿');
      await clearing;
      expect(await ThreadDraftStorage('a', 'shared').read(), isEmpty);
      expect(await ThreadDraftStorage('b', 'another').read(), '新草稿');
    },
  );
}
