/** Manages the shared recruiting categories from the workspace header. */
import { useState } from 'react';
import { t } from '@lingui/core/macro';
import { IconTrash } from 'twenty-ui/icon';

import { Button, Dialog, Input } from '@/recruiting/shadcn/compat';
import { recruitingRequest } from '@/recruiting/shared/api/request';
import { useRecruitingQuery } from '@/recruiting/shared/hooks/useRecruitingQuery';
import { recruitingDialogClass } from '@/recruiting/shared/styles';

type Category = { id: string; name: string };

export const RecruitingSettingsDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const query = useRecruitingQuery<Category[]>('categories', undefined, open);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const save = async (action: { name: string } | { id: string }) => {
    setPending(true);
    setError('');
    try {
      const categories = await recruitingRequest<Category[]>('categories', {
        method: 'POST',
        body: JSON.stringify(action),
      });
      query.updateData(() => categories);
      if ('name' in action) setName('');
    } catch (error) {
      setError(error instanceof Error ? error.message : t`保存分类失败`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <div className={recruitingDialogClass}>
            <Dialog.Popup size="xl">
              <Dialog.Header className="flex-row items-center justify-between">
                <Dialog.Title>{t`招聘设置`}</Dialog.Title>
                <Dialog.Close asChild>
                  <Button variant="ghost">{t`关闭`}</Button>
                </Dialog.Close>
              </Dialog.Header>
              <div className="flex min-h-64 flex-col gap-4 p-4 sm:flex-row">
                <nav aria-label={t`设置分类`} className="shrink-0 sm:w-36">
                  <Button variant="secondary" aria-current="page">
                    {t`分类管理`}
                  </Button>
                </nav>
                <section
                  aria-label={t`分类管理`}
                  className="flex min-w-0 flex-1 flex-col gap-3 sm:border-l sm:pl-4"
                >
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (name.trim() && !pending && query.data)
                        void save({ name: name.trim() });
                    }}
                  >
                    <Input
                      aria-label={t`分类名称`}
                      placeholder={t`输入分类名称`}
                      maxLength={40}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <Button
                      type="submit"
                      disabled={pending || !query.data || !name.trim()}
                    >
                      {t`添加`}
                    </Button>
                  </form>
                  {query.loading && <p>{t`正在读取分类…`}</p>}
                  {(error || query.error) && (
                    <p role="alert">{error || query.error}</p>
                  )}
                  {query.data?.length === 0 && <p>{t`暂无分类`}</p>}
                  <ul className="max-h-64 overflow-y-auto">
                    {query.data?.map((category) => (
                      <li
                        key={category.id}
                        className="group flex items-center justify-between gap-2 border-b py-1"
                      >
                        <span className="truncate">{category.name}</span>
                        <div className="pointer-fine:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                          <Button
                            variant="ghost"
                            aria-label={t`删除分类 ${category.name}`}
                            className="hover:bg-destructive hover:text-white focus-visible:bg-destructive focus-visible:text-white"
                            disabled={pending}
                            onClick={() => void save({ id: category.id })}
                          >
                            <IconTrash size={16} />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </Dialog.Popup>
          </div>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
