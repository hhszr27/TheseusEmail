import type { CalendarEventScope } from '../../shared/ipc';

/**
 * 重复事件的范围选择（删除 / 修改）。
 *
 * 删除给全 6 种范围；修改只给 3 种 —— 「修改之前的时间」没有公认语义
 * （Outlook / Google 在修改重复事件时同样只提供 仅此 / 此及后续 / 全部）。
 */
interface CalendarScopeDialogProps {
  mode: 'delete' | 'edit';
  /** 事件标题，让用户确认操作对象。 */
  summary: string;
  onPick(scope: CalendarEventScope): void;
  onClose(): void;
}

const DELETE_OPTIONS: { scope: CalendarEventScope; label: string }[] = [
  { scope: 'this', label: '仅删除这个' },
  { scope: 'thisAndFuture', label: '删除这个和之后的' },
  { scope: 'future', label: '删除之后的' },
  { scope: 'past', label: '删除之前的' },
  { scope: 'pastAndThis', label: '删除之前和这个' },
  { scope: 'all', label: '删除全部' },
];

const EDIT_OPTIONS: { scope: CalendarEventScope; label: string }[] = [
  { scope: 'this', label: '仅修改这个' },
  { scope: 'thisAndFuture', label: '修改这个和之后的' },
  { scope: 'all', label: '修改全部（整个系列）' },
];

export function CalendarScopeDialog({
  mode,
  summary,
  onPick,
  onClose,
}: CalendarScopeDialogProps): JSX.Element {
  const options = mode === 'delete' ? DELETE_OPTIONS : EDIT_OPTIONS;

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(mouseEvent) => mouseEvent.target === mouseEvent.currentTarget && onClose()}
    >
      <div
        className="modal calendar-scope-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-scope-title"
      >
        <div className="modal-header">
          <h2 className="modal-title" id="calendar-scope-title">
            {mode === 'delete' ? '删除重复事件' : '修改重复事件'}
          </h2>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
        </div>

        <div className="modal-body calendar-scope-body">
          <p className="hint">「{summary || '该事件'}」是重复事件，请选择范围：</p>
          <div className="calendar-scope-list">
            {options.map((option) => (
              <button
                key={option.scope}
                type="button"
                className={`btn calendar-scope-option${option.scope === 'all' ? ' calendar-scope-all' : ''}`}
                onClick={() => onPick(option.scope)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
