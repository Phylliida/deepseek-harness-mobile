/**
 * SubagentModelSelect: the composer seat's subagent-model trigger, rendered
 * beside the session model seat over the SAME per-session ModelDirectory. One
 * flat menu: an inherit row (children follow the session model — the default)
 * plus the shared provider-grouped catalog. Selection submits through the
 * directory's selectSubagent verb (`session.selectSubagentModel`), so the
 * host-reported override is the single fact the trigger echoes. Failure
 * surfaces mirror the model seat: catalog loads keep the in-menu strip with
 * Retry, a rejected selection announces through the transient Toast.
 */
import {
  useEffect, useId, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/**
 * Render the composer subagent-model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the inherit row plus model list.
 */
export function SubagentModelSelect(
  { locked, available, directory, load, selectSubagent, t }:
  Pick<ModelSelectInjected, 'available' | 'directory' | 'load' | 'selectSubagent'>
  & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  // See ModelSelect: the strip serves catalog loads, the toast selections.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const current = state.subagentCurrent
  const currentEntry = current === null || current === undefined
    ? undefined
    : state.groups
      .find(group => group.id === current.provider)
      ?.models.find(model => model.id === current.model)
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const show = (): void => {
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection | null): void => {
    const unchanged = selection === null
      ? current === null
      : current?.provider === selection.provider && current.model === selection.model
    if (unchanged) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void selectSubagent(selection).then(settleSelection)
  }

  const valueLabel = current === undefined
    ? undefined
    : current === null
      ? t('subagent.inherit')
      : currentEntry?.name ?? current.model
  const triggerAria = valueLabel === undefined
    ? t('subagent.trigger.selectAria')
    : t('subagent.trigger.aria', { model: valueLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={valueLabel === undefined
          ? t('subagent.trigger.label')
          : `${t('subagent.trigger.label')}: ${valueLabel}`}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerEffort}>{t('subagent.trigger.label')}</span>
        {valueLabel !== undefined && <span className={css.triggerLabel}>{valueLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('subagent.menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {state.status === 'loading' && (
            <div className={css.status}>{t('status.loading')}</div>
          )}
          {state.error !== null && lastActionRef.current === 'load' && (
            <div className={css.error}>
              <span>{t('error.action', { message: state.error })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
          ))}
          <div className={clsx(css.groups, 'scrollable')}>
            <button
              ref={itemRef()}
              type="button"
              role="menuitemradio"
              aria-checked={current === null}
              className={clsx(css.option, current === null && css.selected)}
              disabled={busy}
              onClick={() => { choose(null) }}
            >
              <span className={css.optionCopy}>
                <span className={css.modelName}>{t('subagent.inherit')}</span>
                <span className={css.description}>{t('subagent.inherit.description')}</span>
              </span>
              <span className={css.check}>
                {current === null ? <IconCheckOutline16 /> : null}
              </span>
            </button>
            {state.groups.map((group) => {
              const headingId = `${id}-${group.id}`
              return (
                <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                  <div className={css.groupTitle} id={headingId}>{group.name}</div>
                  {group.models.map((model) => {
                    const selected = current?.provider === group.id && current.model === model.id
                    return (
                      <button
                        ref={itemRef()}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={clsx(css.option, selected && css.selected)}
                        key={model.id}
                        title={model.name}
                        disabled={busy}
                        onClick={() => { choose({ provider: group.id, model: model.id }) }}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{model.name}</span>
                          {model.description !== undefined && (
                            <span className={css.description}>{model.description}</span>
                          )}
                        </span>
                        <span className={css.check}>
                          {selected ? <IconCheckOutline16 /> : null}
                        </span>
                      </button>
                    )
                  })}
                </section>
              )
            })}
          </div>
          {state.status === 'ready' && state.groups.length === 0 && (
            <div className={css.empty}>{t('empty.models')}</div>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
