// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { UserModelProjection, UserModelSelection } from '@deepseek-ai/dsh-user-model/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { SubagentModelSelect } from '../src/client/SubagentModelSelect.tsx'
import { UserModelSelect } from '../src/client/UserModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    subagentCurrent: null,
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('SubagentModelSelect', () => {
  it('shows the inherit default and submits a subagent route through selectSubagent', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const selectSubagent = vi.fn(async (selection: ModelSelection | null) => {
      directory.set(state({ subagentCurrent: selection }))
      return true
    })
    render(<SubagentModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      selectSubagent={selectSubagent}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择子代理模型，当前 跟随会话模型' })
    fireEvent.click(trigger)
    // The inherit row is the checked default; catalog models follow.
    const options = screen.getAllByRole('menuitemradio')
    expect(options.map(item => item.textContent))
      .toEqual(['跟随会话模型委派的子代理使用会话当前模型', 'DeepSeek-V4-Flash'])
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    await waitFor(() => {
      expect(selectSubagent).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      expect(trigger.getAttribute('aria-label')).toBe('选择子代理模型，当前 DeepSeek-V4-Flash')
    })
  })

  it('clears an override through the inherit row', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      subagentCurrent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }))
    const selectSubagent = vi.fn(async (selection: ModelSelection | null) => {
      directory.set(state({ subagentCurrent: selection }))
      return true
    })
    render(<SubagentModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      selectSubagent={selectSubagent}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: '选择子代理模型，当前 DeepSeek-V4-Flash' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /跟随会话模型/ }))
    await waitFor(() => {
      expect(selectSubagent).toHaveBeenCalledWith(null)
    })
  })

  it('names the override by its catalog id when the model is unadvertised, and renders nothing when unavailable', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      subagentCurrent: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const { unmount } = render(<SubagentModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      selectSubagent={vi.fn().mockResolvedValue(true)}
      t={t}
    />)
    expect(screen.getByRole('button', { name: '选择子代理模型，当前 removed-model' })).toBeTruthy()
    unmount()

    render(<SubagentModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      selectSubagent={vi.fn().mockResolvedValue(false)}
      t={t}
    />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('UserModelSelect', () => {
  /**
   * A mutable armed value behind a stub useProjection: arm/disarm fakes
   * assign it, and the settle path's close re-render reads the fresh value,
   * mirroring how the real projection frame lands between selection and the
   * seat's next render.
   */
  function harness(initial: UserModelProjection) {
    let armed: UserModelProjection = initial
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const selectUserModel = vi.fn(async (selection: UserModelSelection | null) => {
      armed = selection
      return true
    })
    const useProjection = ((key: string) => (key === 'userModel' ? armed : undefined)) as UseProjection
    const view = render(<UserModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      selectUserModel={selectUserModel}
      useProjection={useProjection}
      t={t}
    />)
    return { armed: () => armed, directory, selectUserModel, ...view }
  }

  it('arms through the goal editor and the catalog, then disarms from the armed menu', async () => {
    const { selectUserModel } = harness(null)

    fireEvent.click(screen.getByRole('button', { name: '选择用户模型' }))
    // No goal yet: the hint shows and every model row stays disabled.
    expect(screen.getByText('先描述目标，再选择模型')).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByRole('textbox', { name: '用户模型目标' }), {
      target: { value: '  让智能体修好失败的测试  ' },
    })
    const row = screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })
    expect(row).toHaveProperty('disabled', false)
    fireEvent.click(row)
    await waitFor(() => {
      expect(selectUserModel).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        prompt: '让智能体修好失败的测试',
      })
    })

    // Armed now: the trigger names the model, and the menu swaps the catalog
    // for the armed summary plus the disarm row.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择用户模型，当前 DeepSeek-V4-Flash' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '选择用户模型，当前 DeepSeek-V4-Flash' }))
    expect(screen.getByText('已启用：DeepSeek-V4-Flash')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /停用用户模型/ }))
    await waitFor(() => {
      expect(selectUserModel).toHaveBeenLastCalledWith(null)
    })
  })

  it('names an unadvertised armed route by id and hides the seat when the capability is absent', () => {
    const { unmount } = harness({ provider: 'gone', model: 'removed-model', prompt: 'p' })
    fireEvent.click(screen.getByRole('button', { name: '选择用户模型，当前 removed-model' }))
    expect(screen.getByText('已启用：removed-model')).toBeTruthy()
    unmount()

    let absent: UserModelProjection | undefined
    const useProjection = (() => absent) as UseProjection
    render(<UserModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      selectUserModel={vi.fn().mockResolvedValue(true)}
      useProjection={useProjection}
      t={t}
    />)
    expect(absent).toBeUndefined()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('announces a rejected arming as a transient toast that unmounts itself', async () => {
    // Fake timers from the start so the banner's hold+fade timeout is the
    // clock this test advances.
    vi.useFakeTimers()
    try {
      const directory = createSnapshotStore<ModelDirectoryState>(state())
      const selectUserModel = vi.fn(async () => {
        directory.set(state({ status: 'error', error: 'model-unavailable: no adapter registered' }))
        return false
      })
      const useProjection = (() => null) as UseProjection
      render(<UserModelSelect
        locked={false}
        available
        directory={directory}
        load={vi.fn()}
        selectUserModel={selectUserModel}
        useProjection={useProjection}
        t={t}
      />)

      fireEvent.click(screen.getByRole('button', { name: '选择用户模型' }))
      fireEvent.change(screen.getByRole('textbox', { name: '用户模型目标' }), { target: { value: 'goal' } })
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
      await act(async () => {})
      const toast = screen.getByRole('alert')
      expect(toast.textContent).toContain('模型操作失败：model-unavailable: no adapter registered')

      await act(async () => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays silent when the host rejects without an error message, and settles after unmount', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    let resolveArm: ((accepted: boolean) => void) | undefined
    const selectUserModel = vi.fn(() => new Promise<boolean>((resolve) => { resolveArm = resolve }))
    const useProjection = (() => null) as UseProjection
    const view = render(<UserModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      selectUserModel={selectUserModel}
      useProjection={useProjection}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: '选择用户模型' }))
    fireEvent.change(screen.getByRole('textbox', { name: '用户模型目标' }), { target: { value: 'goal' } })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    await act(async () => { resolveArm?.(false) })
    expect(screen.queryByRole('alert')).toBeNull()
    // A rejection leaves the menu (and the goal editor) open for another try.
    expect(screen.getByRole('menu')).toBeTruthy()

    // An arming accepted after the seat unmounted settles without touching
    // the (gone) trigger.
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    view.unmount()
    await act(async () => { resolveArm?.(true) })
  })

  it('renders the load, error, warning, and empty strips over the catalog', async () => {
    const load = vi.fn()
    const useProjection = (() => null) as UseProjection
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', description: '快速模型' }],
      }],
      failures: [{ id: 'broken', name: 'Broken', message: 'timeout' }],
      status: 'error',
      error: 'session-models-failed: boom',
    }))
    render(<UserModelSelect
      locked={false}
      available
      directory={directory}
      load={load}
      selectUserModel={vi.fn().mockResolvedValue(true)}
      useProjection={useProjection}
      t={t}
    />)

    // Opening reloads; the failure lands in the in-menu strip (with Retry)
    // because the last action was a load, not a selection.
    fireEvent.click(screen.getByRole('button', { name: '选择用户模型' }))
    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/模型操作失败：session-models-failed: boom/)).toBeTruthy()
    expect(screen.getByText(/Broken.*timeout/)).toBeTruthy()
    expect(screen.getByText('快速模型')).toBeTruthy()
    const retries = screen.getAllByRole('button', { name: '重试' })
    expect(retries.length).toBe(2)
    fireEvent.click(retries[0]!)
    expect(load).toHaveBeenCalledTimes(2)

    directory.set(state({ groups: [], status: 'loading', error: null, failures: [] }))
    await waitFor(() => { expect(screen.getByText(zh['status.loading'])).toBeTruthy() })
    directory.set(state({ groups: [], failures: [] }))
    await waitFor(() => { expect(screen.getByText(zh['empty.models'])).toBeTruthy() })
  })

  it('closes on Escape and outside press, and roves focus with arrows', async () => {
    const { directory } = harness(null)

    const trigger = screen.getByRole('button', { name: '选择用户模型' })
    // Keys other than Escape do nothing while the menu is closed.
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger)
    // Clicking the trigger again toggles the menu closed.
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })

    fireEvent.click(trigger)
    fireEvent.change(screen.getByRole('textbox', { name: '用户模型目标' }), { target: { value: 'goal' } })
    const row = screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })
    row.focus()
    // A non-arrow key leaves the focus alone; ArrowUp wraps to the same row.
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(document.activeElement).toBe(row)
    fireEvent.keyDown(row, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(row)
    // Arrow keys inside the goal editor stay with the editor.
    const editor = screen.getByRole('textbox', { name: '用户模型目标' })
    editor.focus()
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(editor)

    // With no catalog rows the roving walk is a no-op.
    act(() => { directory.set(state({ groups: [] })) })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.queryByRole('menuitemradio')).toBeNull()

    // A press inside the menu keeps it open; one outside closes it.
    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(screen.queryByRole('menu')).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    // Focus leaving the card closes the menu too.
    fireEvent.click(trigger)
    fireEvent.blur(trigger, { relatedTarget: document.body })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
