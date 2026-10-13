/**
 * UserModelSelect: the composer seat's user-model trigger, rendered beside
 * the session and subagent model seats over the SAME per-session
 * ModelDirectory. Arming takes a goal prompt plus a model from the shared
 * provider-grouped catalog and submits through the directory's selectUserModel
 * verb (`session.selectUserModel`); the live armed value is the host-folded
 * `userModel` projection, not client-side state, so a disarm arriving from
 * anywhere (the driver, another client) is what this trigger echoes next.
 * Failure surfaces mirror the model seat: catalog loads keep the in-menu
 * strip with Retry, a rejected selection announces through the transient
 * Toast.
 */
import {
  useEffect, useId, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconChevronDownOutline14, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/**
 * Render the composer user-model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard kit's projection hook + the standard locale seat.
 * @returns the trigger and, while open, the goal editor plus model list —
 * or, while armed, the armed summary plus the disarm row.
 */
export function UserModelSelect(
  { locked, available, directory, load, selectUserModel, useProjection, t }:
  Pick<ModelSelectInjected, 'available' | 'directory' | 'load' | 'selectUserModel'>
  & { locked: boolean; useProjection: UseProjection } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  // Undefined means the host composes no user-model capability at all; the
  // seat stays out of the chrome in that case.
  const armed = useProjection('userModel')
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState('')
  // See ModelSelect: the strip serves catalog loads, the toast selections.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const currentEntry = armed === null || armed === undefined
    ? undefined
    : state.groups
      .find(group => group.id === armed.provider)
      ?.models.find(model => model.id === armed.model)
  const busy = state.status === 'selecting'
  const goalReady = goal.trim().length > 0

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

  if (!available || armed === undefined) return null

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
    // The goal editor owns its own arrow keys; menu roving skips it.
    if (event.target instanceof HTMLTextAreaElement) return
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

  // The row is disabled until the goal is non-empty, so no re-check here.
  const arm = (provider: string, model: string): void => {
    lastActionRef.current = 'select'
    void selectUserModel({ provider, model, prompt: goal.trim() }).then(settleSelection)
  }

  const disarm = (): void => {
    lastActionRef.current = 'select'
    void selectUserModel(null).then(settleSelection)
  }

  const valueLabel = armed === null ? undefined : currentEntry?.name ?? armed.model
  const triggerAria = valueLabel === undefined
    ? t('usermodel.trigger.selectAria')
    : t('usermodel.trigger.aria', { model: valueLabel })
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
          ? t('usermodel.trigger.label')
          : `${t('usermodel.trigger.label')}: ${valueLabel}`}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerEffort}>{t('usermodel.trigger.label')}</span>
        {valueLabel !== undefined && <span className={css.triggerLabel}>{valueLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('usermodel.menu.aria')}
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
          {armed !== null
            ? (
              <div className={clsx(css.groups, 'scrollable')}>
                <div className={css.armed}>
                  <span className={css.modelName}>
                    {t('usermodel.armed', { model: currentEntry?.name ?? armed.model })}
                  </span>
                  <span className={css.armedGoal} title={armed.prompt}>{armed.prompt}</span>
                </div>
                <button
                  ref={itemRef()}
                  type="button"
                  role="menuitemradio"
                  aria-checked={false}
                  className={css.option}
                  disabled={busy}
                  onClick={disarm}
                >
                  <span className={css.optionCopy}>
                    <span className={css.modelName}>{t('usermodel.disarm')}</span>
                    <span className={css.description}>{t('usermodel.disarm.description')}</span>
                  </span>
                </button>
              </div>
            )
            : (
              <>
                <textarea
                  className={css.goal}
                  aria-label={t('usermodel.goal.aria')}
                  placeholder={t('usermodel.goal.placeholder')}
                  value={goal}
                  rows={3}
                  onChange={(event) => { setGoal(event.target.value) }}
                />
                {!goalReady && (
                  <div className={css.status}>{t('usermodel.goal.hint')}</div>
                )}
                <div className={clsx(css.groups, 'scrollable')}>
                  {state.groups.map((group) => {
                    const headingId = `${id}-${group.id}`
                    return (
                      <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                        <div className={css.groupTitle} id={headingId}>{group.name}</div>
                        {group.models.map(model => (
                          <button
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={false}
                            className={css.option}
                            key={model.id}
                            title={model.name}
                            disabled={busy || !goalReady}
                            onClick={() => { arm(group.id, model.id) }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>{model.name}</span>
                              {model.description !== undefined && (
                                <span className={css.description}>{model.description}</span>
                              )}
                            </span>
                          </button>
                        ))}
                      </section>
                    )
                  })}
                </div>
                {state.status === 'ready' && state.groups.length === 0 && (
                  <div className={css.empty}>{t('empty.models')}</div>
                )}
              </>
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
