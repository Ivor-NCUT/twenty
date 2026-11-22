/** Identifies a hiring-mailbox reply and the candidate clues already present on the message. */

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i;
const GENERIC_NAME_PARTS = new Set([
  '简历投递',
  '求职',
  '应聘',
  '咨询',
  '合作',
  '实习生',
  '实习',
  '简历',
  '附件',
  '投递',
  '老师',
  '您好',
  '你好',
  '回复',
  '泛函',
  '合作团队',
  '全栈工程师',
  '体验运营',
  '产品运营',
  '视觉策划',
  '项目合作',
  'harness',
  'memu',
  'agent',
]);

export const normalizeEmail = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().toLowerCase().match(EMAIL_RE);
  return match ? match[0].toLowerCase() : undefined;
};

const walkAddresses = (entry: unknown, out: Set<string>) => {
  if (entry == null) return;
  if (typeof entry === 'string') {
    for (const match of entry.toLowerCase().match(new RegExp(EMAIL_RE, 'g')) ??
      [])
      out.add(match);
    return;
  }
  if (Array.isArray(entry)) {
    for (const item of entry) walkAddresses(item, out);
    return;
  }
  if (typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    walkAddresses(record.address, out);
    walkAddresses(record.email, out);
    walkAddresses(record.value, out);
    walkAddresses(record.text, out);
    walkAddresses(record.from, out);
    walkAddresses(record.sender, out);
    walkAddresses(record.replyTo, out);
  }
};

export const collectAddresses = (value: unknown) => {
  const out = new Set<string>();
  walkAddresses(value, out);
  return [...out];
};

export const senderEmailsFromMetadata = (meta: unknown) => {
  if (!meta || typeof meta !== 'object') return [];
  const record = meta as Record<string, unknown>;
  return [
    ...new Set([
      ...collectAddresses(record.from),
      ...collectAddresses(record.sender),
      ...collectAddresses(record.replyTo),
    ]),
  ];
};

export const normalizeMessageId = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/[<>\s]/g, '')
    .trim()
    .toLowerCase();
  return normalized || undefined;
};

const addMessageIds = (value: unknown, ids: Set<string>) => {
  if (typeof value === 'string') {
    for (const part of value.split(/[\s,]+/)) {
      const id = normalizeMessageId(part);
      if (id) ids.add(id);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addMessageIds(item, ids);
  }
};

export const collectMessageIds = (meta: unknown) => {
  if (!meta || typeof meta !== 'object') return [];
  const record = meta as Record<string, unknown>;
  const ids = new Set<string>();
  addMessageIds(record.messageId, ids);
  addMessageIds(record.inReplyTo, ids);
  addMessageIds(record.references, ids);
  return [...ids];
};

export const isReplyMail = (meta: unknown) => {
  if (!meta || typeof meta !== 'object') return false;
  const record = meta as Record<string, unknown>;
  const subject = typeof record.subject === 'string' ? record.subject : '';
  if (/^\s*(re|回复|答复|答覆)\s*[:：]/i.test(subject)) return true;
  if (
    typeof record.inReplyTo === 'string' &&
    normalizeMessageId(record.inReplyTo)
  )
    return true;
  if (
    Array.isArray(record.references) &&
    record.references.some(
      (item) => typeof item === 'string' && normalizeMessageId(item),
    )
  )
    return true;
  if (
    typeof record.references === 'string' &&
    normalizeMessageId(record.references)
  )
    return true;
  return false;
};

const stripReplyPrefix = (subject: string) => {
  let value = subject.trim();
  let previous: string;
  do {
    previous = value;
    value = value
      .replace(/^\s*((re|fw|fwd|回复|答复|答覆)\s*[:：]\s*)+/i, '')
      .trim();
  } while (value !== previous);
  return value;
};

export const extractNamesFromMail = (meta: unknown) => {
  if (!meta || typeof meta !== 'object') return [];
  const subject =
    typeof (meta as { subject?: unknown }).subject === 'string'
      ? (meta as { subject: string }).subject
      : '';
  if (!subject) return [];
  const names = new Set<string>();
  const parts = stripReplyPrefix(subject)
    .split(/[-－—–_|｜/、，,]+/)
    .map((part) =>
      part
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/(老师|同学)$/u, '')
        .trim(),
    )
    .filter(Boolean);
  for (const part of parts) {
    if (GENERIC_NAME_PARTS.has(part.toLowerCase())) continue;
    if (/^[\u4e00-\u9fff]{2,4}$/u.test(part)) names.add(part);
    if (
      /^[A-Za-z][A-Za-z.'’\-]+(?:\s+[A-Za-z][A-Za-z.'’\-]+){1,3}$/.test(part) &&
      part.length <= 40
    )
      names.add(part);
  }
  return [...names];
};

export const mailMetadataFromIntake = (mail: unknown) => {
  if (!mail || typeof mail !== 'object') return {};
  const record = mail as Record<string, unknown>;
  if (record.metadata && typeof record.metadata === 'object')
    return record.metadata as Record<string, unknown>;
  return record;
};
