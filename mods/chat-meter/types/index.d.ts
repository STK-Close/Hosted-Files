// Copyright (c) 2026 Lumina Art House, LLC. All rights reserved.

/** The chat's fill, as the engine last measured it. */
export type Fill = { tokens?: number; window: number }

/** A summary waiting to be carried into a fresh chat. */
export type Handoff = { text: string; from: string; createdAt: number }

export type Phase = 'idle' | 'working' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'chat-meter': {
      fill: Fill | null
      handoff: Handoff | null
      phase: Phase
      isConfirmingDiscard: boolean
      sessionId: string
      lastStep: number
      hasReminded: boolean
    }
  }
}
