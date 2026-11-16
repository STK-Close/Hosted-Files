import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'chat-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** Stands for the engine: the session's start, the command list, the status line. */
function engine(on: On, said: string[] = []): string[] {
  mock.clock(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => {
    said.push(String(e.text))

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    said.push(String(e.text))

    return { value: undefined }
  })

  return said
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('the meter reads in plain words on every surface', async ($, on) => {
  mock.store(on)
  const said = engine(on)
  on('session.id', () => ({ value: 'chat-a' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 126000, window: 1000000, percent: 13 }, rateLimits: [] },
  }))

  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = await ui.find({ type: 'Text', text: /Chat/ })
    expect(line?.text).toBe('Chat 13% full (126K of 1.0M)')
    expect(await ui.find({ type: 'Text', text: /Getting full/ })).toBeUndefined()
    await ui.unmount()
  }

  expect(said).toContain('Chat 13% full (126K of 1.0M)')
  expect((await $.command.run({ command: 'meter' } as Parameters<typeof $.command.run>[0])).text).toBe(
    'Chat 13% full (126K of 1.0M)',
  )
})

test('before the first reply it says so, and past 75% it suggests a handoff', async ($, on) => {
  mock.store(on)
  const said = engine(on)
  on('session.id', () => ({ value: 'chat-a' }))
  let context: { tokens?: number; window: number } = { window: 200000 }
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits: [] } }))

  await $.session.start(START)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Chat/ }))?.text).toBe(
    'Chat usage appears after the first reply',
  )
  await ui.unmount()

  context = { tokens: 160000, window: 200000 }
  await $.session.start(START)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Chat/ }))?.text).toBe(
    'Chat 80% full (160K of 200K)',
  )
  expect((await ui.find({ type: 'Text', text: /Getting full/ }))?.text).toBe(
    'Getting full. Consider a handoff.',
  )
  await ui.unmount()
})

test('a handoff is summarized in one chat and brought into the next', async ($, on) => {
  mock.store(on)
  let chat = 'chat-a'
  let box = ''
  const asked: string[] = []
  const said = engine(on)
  on('session.id', () => ({ value: chat }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 900000, window: 1000000 }, rateLimits: [] },
  }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Plan the spring newsletter.', toolUses: [] },
      { role: 'assistant', text: 'Draft outline is ready.', toolUses: [] },
    ],
  }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: 'Goal: spring newsletter. Next steps: write the intro.',
        usage: USAGE,
      },
    }
  })
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  on('prompt.fill', (_, e) => {
    box += e.text

    return { isFilled: true }
  })

  // The chat being left.
  await $.session.start(START)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'handoff' })
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Person: Plan the spring newsletter.')
  expect((await ui.find({ type: 'Text', text: /Handoff saved/ }))?.text).toBe(
    'Handoff saved. Open a new chat to use it.',
  )
  expect(await ui.find({ key: 'bring' })).toBeUndefined()
  await ui.unmount()

  // A fresh chat.
  chat = 'chat-b'
  await $.session.start(START)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Handoff ready/ }))?.text).toBe(
    'Handoff ready from an earlier chat.',
  )
  await ui.press({ key: 'bring' })
  expect(box).toContain('Handoff from an earlier chat.')
  expect(box).toContain('Next steps: write the intro.')
  expect(await ui.find({ type: 'Text', text: /Handoff ready/ })).toBeUndefined()
  await ui.unmount()

  // Used once: a third chat is offered nothing.
  chat = 'chat-c'
  await $.session.start(START)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'bring' })).toBeUndefined()
  expect(await ui.find({ key: 'handoff' })).toBeDefined()
  await ui.unmount()
})

test('discarding a saved handoff takes two taps', async ($, on) => {
  mock.store(on, {
    handoff: { text: 'Handoff from an earlier chat.', from: 'chat-a', createdAt: 1 },
  })
  const said = engine(on)
  on('session.id', () => ({ value: 'chat-b' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))

  await $.session.start(START)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'discard' })
  expect(await ui.find({ key: 'discard-confirm' })).toBeDefined()
  await ui.unmount()

  // One tap deleted nothing: a restart still offers it.
  await $.session.start(START)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Handoff ready/ })).toBeDefined()
  await ui.press({ key: 'discard-cancel' })
  expect(await ui.find({ key: 'bring' })).toBeDefined()
  await ui.press({ key: 'discard' })
  await ui.press({ key: 'discard-confirm' })
  expect(await ui.find({ type: 'Text', text: /Handoff ready/ })).toBeUndefined()
  await ui.unmount()

  await $.session.start(START)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'bring' })).toBeUndefined()
  await ui.unmount()
})

test('a failed summary saves nothing and says so', async ($, on) => {
  mock.store(on)
  const said = engine(on)
  on('session.id', () => ({ value: 'chat-a' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Hello', toolUses: [] }] }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }))

  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'handoff' })
  expect(await ui.find({ key: 'discard' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /could not/ }))?.text).toBe(
    'The summary could not be written. Try again.',
  )
  await ui.unmount()
})

test('the chat gets a line each time it passes another tenth', async ($, on) => {
  mock.store(on)
  const rows = mock.session(on)
  engine(on)
  on('session.id', () => ({ value: 'chat-a' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 120000, window: 1000000 }, rateLimits: [] },
  }))
  const notices = () =>
    rows
      .appended()
      .map(row => row.message.content.map(b => ('text' in b ? b.text : '')).join(''))

  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start(START)
  expect(notices()).toEqual([])

  const measure = (tokens: number) =>
    $.session.measure({
      context: { tokens, window: 1000000 },
      rateLimits: [],
      changed: ['context'],
    })

  await measure(150000)
  expect(notices()).toEqual([])
  await measure(210000)
  expect(notices()).toEqual(['Chat 21% full (210K of 1.0M). Type /meter any time to check.'])
  await measure(230000)
  expect(notices().length).toBe(1)
  await measure(760000)
  expect(notices()[1]).toBe(
    'Chat 76% full (760K of 1.0M). Time for a handoff: type /handoff here, then type /handoff bring in a new chat.',
  )
})

test('a new chat is told once that a handoff waits, and what to type', async ($, on) => {
  mock.store(on, {
    handoff: { text: 'Handoff from an earlier chat.', from: 'chat-a', createdAt: 1 },
  })
  const rows = mock.session(on)
  engine(on)
  on('session.id', () => ({ value: 'chat-b' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 20000, window: 1000000 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const texts = () =>
    rows.appended().map(r => r.message.content.map(b => ('text' in b ? b.text : '')).join(''))

  await $.session.start(START)
  const measure = () =>
    $.session.measure({
      context: { tokens: 30000, window: 1000000 },
      rateLimits: [],
      changed: ['context'],
    })
  await measure()
  await measure()
  expect(texts()).toEqual([
    'A handoff from an earlier chat is ready. Type /handoff bring to use it, or /handoff discard to delete it.',
  ])
})

test('Claude is told the commands, so it can remind the person', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'Base.', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections.map(one => one.id)).toEqual(['base', 'chat-meter:guide'])
  expect(sections[1]?.text).toContain('/handoff bring')
})
