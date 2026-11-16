# Chat meter

Chat meter shows how full the current chat is, in plain words, for example
"Chat 13% full (126K of 1.0M)". It sits in a slim row above the typing box and
in the status line, and updates after each reply. At 75% full it suggests a
handoff.

Type `/meter` at any time to print the same line. Use it where your app does
not show the row, such as some cloud sessions viewed on the web or phone.

Each time the chat passes another tenth of full (10%, 20%, 30% and so on),
a short line is added to the chat itself, so you see it on every app,
including phones. Claude does not read these lines.

## Handoff

Press **Handoff** (or type `/handoff`) to save a short summary of the chat:
the goal, what is done, decisions, and next steps. Open a new chat and press
**Bring it in** (or type `/handoff bring`) to place the summary in the typing
box. **Discard** (or `/handoff discard`) deletes a saved summary and takes two
taps.

## Cost and privacy

The meter costs nothing. Each handoff makes one small Claude request, which
counts toward your normal usage. The summary is kept in the mod's own storage
and is not sent anywhere else.

## Install

In the Claude desktop app: click + next to the prompt box, then Plugins, then
Add marketplace. Enter `STK-Close/Hosted-Files`, then choose Add plugin.

In Claude Code in a terminal, type this at the prompt, then answer `y` and
press Enter:

```
/plugin install chat-meter --marketplace STK-Close/Hosted-Files
```

## Legal

Copyright (c) 2026 Lumina Art House, LLC. All rights reserved.
