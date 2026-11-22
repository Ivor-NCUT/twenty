/** Locks the reply clues used by the production mailreply1 patch. */
import {
  collectMessageIds,
  extractNamesFromMail,
  isReplyMail,
  normalizeEmail,
  senderEmailsFromMetadata,
} from './mail-reply';

it('reads an address out of a display name', () => {
  expect(normalizeEmail('张三 <Zhang.San@Example.TEST>')).toBe(
    'zhang.san@example.test',
  );
  expect(normalizeEmail('不是邮箱')).toBeUndefined();
});

it('treats reply subjects and message references as replies', () => {
  expect(isReplyMail({ subject: '回复：实习申请' })).toBe(true);
  expect(isReplyMail({ subject: 'Re: backend' })).toBe(true);
  expect(isReplyMail({ subject: '实习申请' })).toBe(false);
  expect(isReplyMail({ inReplyTo: '<ABC@mail>' })).toBe(true);
  expect(isReplyMail({ references: ['<first@mail>', '<second@mail>'] })).toBe(
    true,
  );
});

it('collects thread ids without brackets and drops generic subject words', () => {
  expect(
    collectMessageIds({
      messageId: '<New@Mail>',
      inReplyTo: '<Old@Mail>',
      references: '<Old@Mail> <Older@Mail>',
    }),
  ).toEqual(['new@mail', 'old@mail', 'older@mail']);
  expect(
    extractNamesFromMail({ subject: '回复：李雷 - 简历投递 - Ada Lovelace' }),
  ).toEqual(['李雷', 'Ada Lovelace']);
  expect(extractNamesFromMail({ subject: '回复：老师' })).toEqual([]);
});

it('keeps sender, from and reply-to addresses', () => {
  expect(
    senderEmailsFromMetadata({
      from: '甲 <a@example.test>',
      replyTo: [{ address: 'b@example.test' }],
    }),
  ).toEqual(['a@example.test', 'b@example.test']);
});
