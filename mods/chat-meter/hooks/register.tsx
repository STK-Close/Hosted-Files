// Copyright (c) 2026 Lumina Art House, LLC. All rights reserved.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fill, Handoff, Phase } from '../types'

const STORE_KEY = 'handoff'
const PANE = 'chat-meter'
const PANE_TITLE = 'Chat meter'
const HINT_AT = 75
const HEAD_CHARS = 4000
const TAIL_CHARS = 40000

const fill = atom({ plugin: 'chat-meter', key: 'fill' } as const, null)
const handoff = atom({ plugin: 'chat-meter', key: 'handoff' } as const, null)
const phase = atom({ plugin: 'chat-meter', key: 'phase' } as const, 'idle')
const isConfirmingDiscard = atom(
  { plugin: 'chat-meter', key: 'isConfirmingDiscard' } as const,
  false,
)
const lastStep = atom({ plugin: 'chat-meter', key: 'lastStep' } as const, -1)
const hasReminded = atom({ plugin: 'chat-meter', key: 'hasReminded' } as const, false)
const sessionId = atom({ plugin: 'chat-meter', key: 'sessionId' } as const, '')

const SYSTEM = [
  'You write a handoff note so a fresh chat can continue this work.',
  'Use plain language, about 150 words, no em dashes.',
  'Use exactly these four short sections, each a label followed by a colon:',
  'Goal, Done so far, Decisions, Next steps.',
  'Include names, file paths and numbers that matter. Leave out small talk.',
  'Write only the note.',
].join(' ')

const GUIDE = [
  'The person has the Chat meter mod. It adds these typed commands:',
  '/meter shows how full this chat is.',
  '/handoff saves a short summary of this chat for a new chat.',
  '/handoff bring, typed in the new chat, puts the saved summary in the typing box.',
  '/handoff discard deletes a saved summary.',
  'The person may forget these. When they ask how full the chat is, how to start fresh,',
  'or how to carry work into a new chat, tell them the exact command to type.',
].join(' ')

export function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`

  return String(n)
}

export function percentOf(f: Fill): number {
  return Math.min(100, Math.round(((f.tokens ?? 0) / f.window) * 100))
}

export function meterText(f: Fill | null): string {
  if (f === null || f.tokens === undefined || f.window <= 0) {
    return 'Chat usage appears after the first reply'
  }

  return `Chat ${percentOf(f)}% full (${short(f.tokens)} of ${short(f.window)})`
}

function isGettingFull(f: Fill | null): boolean {
  return f !== null && f.tokens !== undefined && percentOf(f) >= HINT_AT
}

function asHandoff(value: unknown): Handoff | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  return typeof v.text === 'string' &&
    typeof v.from === 'string' &&
    typeof v.createdAt === 'number'
    ? { text: v.text, from: v.from, createdAt: v.createdAt }
    : null
}

function asFill(context: { tokens?: number; window: number }): Fill {
  return context.tokens === undefined
    ? { window: context.window }
    : { tokens: context.tokens, window: context.window }
}

/** In a new chat, says once that a saved handoff is waiting and what to type. */
async function remind($: EngineInterface): Promise<void> {
  const saved = await read($, handoff)
  const here = await read($, sessionId)

  if (saved === null || saved.from === here || (await read($, hasReminded))) return

  await update($, hasReminded, () => true)
  await $.session.append({
    message: {
      type: 'system',
      content: [
        {
          type: 'text',
          text: 'A handoff from an earlier chat is ready. Type /handoff bring to use it, or /handoff discard to delete it.',
        },
      ],
    },
  })
}

async function refresh($: EngineInterface, f: Fill): Promise<void> {
  await update($, fill, () => f)
  $.ui.status(
    isGettingFull(f)
      ? `${meterText(f)}. Getting full. Consider a handoff.`
      : meterText(f),
  )
}

async function loadSaved($: EngineInterface): Promise<void> {
  const saved = asHandoff(await $.store.get(STORE_KEY))
  await update($, handoff, () => saved)
}

async function setPhase($: EngineInterface, p: Phase): Promise<void> {
  await update($, phase, () => p)
}

function transcriptOf(rows: readonly { role: string; text: string }[]): string {
  const all = rows
    .filter(row => row.text.trim() !== '')
    .map(row => `${row.role === 'user' ? 'Person' : 'Claude'}: ${row.text}`)
    .join('\n\n')

  if (all.length <= HEAD_CHARS + TAIL_CHARS) return all

  return `${all.slice(0, HEAD_CHARS)}\n\n[middle of the chat left out]\n\n${all.slice(-TAIL_CHARS)}`
}

/** Writes the summary, saves it and copies it. Returns what to tell the person. */
async function makeHandoff($: EngineInterface): Promise<string> {
  if ((await read($, phase)) === 'working') {
    return 'A handoff summary is already being written.'
  }

  const transcript = transcriptOf(await $.session.messages())

  if (transcript === '') {
    return 'Nothing to hand off yet. Send a message first, then try again.'
  }

  await setPhase($, 'working')

  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `Here is the chat so far:\n\n${transcript}\n\nWrite the handoff note.`,
      maxTokens: 600,
      effort: 'low',
      timeoutMs: 60000,
    })

    if (!reply.isAnswered || reply.text.trim() === '') {
      await setPhase($, 'failed')

      return 'The summary could not be written. Nothing was saved. Try again in a moment.'
    }

    const text = `Handoff from an earlier chat. Please read it, then continue from the next steps.\n\n${reply.text.trim()}`
    const made: Handoff = {
      text,
      from: await $.session.id(),
      createdAt: await $.clock.now(),
    }
    await $.store.set(STORE_KEY, made)
    await update($, handoff, () => made)
    await update($, isConfirmingDiscard, () => false)
    await setPhase($, 'idle')

    const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))

    return [
      copied.isCopied
        ? 'Handoff saved and copied to your clipboard.'
        : 'Handoff saved.',
      'Next: open a new chat and type /handoff bring.',
      '',
      text,
    ].join('\n')
  } catch {
    await setPhase($, 'failed')

    return 'The summary could not be written. Nothing was saved. Try again in a moment.'
  }
}

/** Puts the saved summary in the typing box. Returns what to tell the person. */
async function bringIn($: EngineInterface): Promise<string> {
  const saved = asHandoff(await $.store.get(STORE_KEY))

  if (saved === null) {
    await update($, handoff, () => null)

    return 'No handoff is saved. In the chat you want to leave, type /handoff first.'
  }

  const filled = await $.prompt
    .fill({ text: saved.text, mode: 'append' })
    .catch(() => ({ isFilled: false }))

  if (!filled.isFilled) {
    return `The typing box could not be filled here. Copy the summary below into your first message.\n\n${saved.text}`
  }

  await $.store.delete(STORE_KEY)
  await update($, handoff, () => null)
  await update($, isConfirmingDiscard, () => false)

  return 'The handoff is in the typing box. Review it, then send.'
}

async function discard($: EngineInterface): Promise<string> {
  await $.store.delete(STORE_KEY)
  await update($, handoff, () => null)
  await update($, isConfirmingDiscard, () => false)

  return 'Handoff discarded.'
}

/** Opens the side panel where a surface can place one. */
async function openPanel($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
}

function stepOf(f: Fill): number {
  return f.tokens === undefined ? -1 : Math.floor(percentOf(f) / 10)
}

/** Adds a line to the chat each time it passes another tenth of full. */
async function announce($: EngineInterface, f: Fill): Promise<void> {
  const step = stepOf(f)
  const before = await read($, lastStep)
  await update($, lastStep, () => step)

  if (step <= before || step < 1) return

  const line = isGettingFull(f)
    ? `${meterText(f)}. Time for a handoff: type /handoff here, then type /handoff bring in a new chat.`
    : `${meterText(f)}. Type /meter any time to check.`
  await $.session.append({
    message: { type: 'system', content: [{ type: 'text', text: line }] },
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'handoff',
        description:
          'Save a short summary of this chat for a fresh chat. Add "bring" to use a saved one, or "discard" to delete it.',
      })
      await $.command.register({
        name: 'meter',
        description: 'Show how full this chat is.',
      })
      const id = await $.session.id()
      await update($, sessionId, () => id)
      await loadSaved($)
      const now = asFill((await $.session.usage()).context)
      await refresh($, now)
      await update($, lastStep, () => stepOf(now))
    } catch {
      // The meter fills in at the first measurement.
    }

    void openPanel($)

    return next(e)
  })

  // Claude knows the commands, so it can remind the person what to type.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [
        ...composed.sections,
        { id: 'chat-meter:guide', text: GUIDE, scope: 'session' },
      ],
    }
  })

  // A phone or desktop app that joins later gets the panel too.
  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    void openPanel($)

    return joined
  })

  on('session.measure', async ($, e, next) => {
    try {
      await refresh($, asFill(e.context))
      await announce($, asFill(e.context))
      const id = await $.session.id()
      await update($, sessionId, () => id)
      await loadSaved($)
      await remind($)
    } catch {
      // Keep the last reading.
    }

    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => {
    void openPanel($)
    const f = asFill((await $.session.usage()).context)
    await refresh($, f)

    return {
      text: isGettingFull(f)
        ? `${meterText(f)}. Getting full. Consider a handoff.`
        : meterText(f),
    }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()

    void $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)

    if (word === 'bring') return { text: await bringIn($) }
    if (word === 'discard') return { text: await discard($) }
    if (word === '') return { text: await makeHandoff($) }

    return {
      text: 'Type /handoff to save a summary, /handoff bring to use it in a new chat, or /handoff discard to delete it.',
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) =>
    e.props.hasSurvey ? next(e) : draw($, $.ui.resolve(e)),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    draw($, $.ui.resolve(e)),
  )
}

type Table = ReturnType<EngineInterface['ui']['resolve']>

async function draw($: EngineInterface, { Box, Button, Text }: Table) {
    const f = await read($, fill)
    const saved = await read($, handoff)
    const now = await read($, phase)
    const isConfirming = await read($, isConfirmingDiscard)
    const here = await read($, sessionId)
    const isFromOtherChat = saved !== null && saved.from !== here

    const say = (text: string) => $.ui.toast(text.split('\n')[0] ?? text)

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={2}>
          <Text>{meterText(f)}</Text>
          {isGettingFull(f) && <Text bold>Getting full. Consider a handoff.</Text>}
          {now === 'working' ? (
            <Text dimColor>Writing the handoff summary...</Text>
          ) : (
            saved === null && (
              <Button
                key="handoff"
                label="Handoff"
                onPress={async () => say(await makeHandoff($))}
              />
            )
          )}
          {now === 'failed' && (
            <Text>The summary could not be written. Try again.</Text>
          )}
        </Box>
        {saved !== null && now !== 'working' && (
          <Box flexWrap="wrap" columnGap={2}>
            <Text>
              {isFromOtherChat
                ? 'Handoff ready from an earlier chat.'
                : 'Handoff saved. Open a new chat to use it.'}
            </Text>
            {isFromOtherChat && !isConfirming && (
              <Button
                key="bring"
                label="Bring it in"
                variant="primary"
                onPress={async () => say(await bringIn($))}
              />
            )}
            {isConfirming ? (
              <Box columnGap={2}>
                <Button
                  key="discard-confirm"
                  label="Tap again to discard"
                  onPress={async () => say(await discard($))}
                />
                <Button
                  key="discard-cancel"
                  label="Keep"
                  onPress={() => update($, isConfirmingDiscard, () => false)}
                />
              </Box>
            ) : (
              <Button
                key="discard"
                label="Discard"
                dimColor
                onPress={() => update($, isConfirmingDiscard, () => true)}
              />
            )}
          </Box>
        )}
      </Box>
    )
}
