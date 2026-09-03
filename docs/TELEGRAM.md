# Telegram

The only channel that reaches you away from the computer running WispCrew.
**You create the bot**, so nothing passes through a WispCrew service and only
your own agents can write to it.

This document covers what it does, how to set it up, and — at the end — the
parts that are deliberately limited and the ones that are simply not built.

## Setting it up

The order matters, and the panel now enforces it rather than explaining it:
each step is disabled until the one before it is done.

1. Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Paste the token it gives you into **Settings → Notifications → Bot token**
   and press **Save**. Until a token is stored, the rest is greyed out.
3. Send your new bot any message.
4. Press **Find my chat**. It reads the chat id from the bot's own update
   feed and fills it in. Press **Save** again.
5. Tick **Telegram** under "How agents reach you".

The token is a bearer credential and is stored **only** in
`~/.wispcrew/wispcrew-secrets.enc`. `writeSettings` refuses outright to write
it to the settings file, which is plaintext JSON somebody might paste into a
bug report. That refusal exists because it happened.

**If Find my chat cannot help, it says why.** A rejected token, a webhook or
another program already reading the bot, an unreachable API, and "no recent
messages" are four different situations with four different answers.
Telegram also drops updates older than about a day, so a message sent
yesterday will not be found.

## Talking to a conversation

Binding happens from inside the chat, because the endpoint *is* wherever you
typed the command — nothing to identify by hand, and it works inside a forum
topic, which a settings form makes awkward.

| Command | Effect |
|---|---|
| `/connect` | Lists the conversations you can attach |
| `/connect <name>` | Attaches this chat to the one whose title contains `<name>` (case-insensitive) |
| `/who` or `/here` | Says which conversation this is, and — in a room — every member with their handle |
| `/disconnect` | Detaches. Nothing here reaches WispCrew afterwards |

`/who` exists because addressing an agent needs its **handle**, and handles
are shown in the desktop's room panel — the one place somebody on a phone
cannot look:

```
This is "OpenClaw AddOn Dev & OpenClaw Dev Version".

In this room:
@openclaw-addon-prod-version — OpenClaw AddOn Prod Version
@openclaw-addon-dev-version — OpenClaw AddOn Dev Version

Tag one to address them, or @all for everyone.
```

A one-to-one chat gets no roster: one agent, no addressing to do.

## What crosses, in each direction

**From Telegram**, a message runs a real turn in the bound conversation. It
is recorded with `via: 'telegram'`, the desktop shows it as *YOU · VIA
TELEGRAM*, and the model is told `[via telegram]` — which matters for the
answer, not just the record. Somebody on a phone wants a short reply, not
four hundred words of markdown with paths they cannot click.

Because Telegram has no streaming, a placeholder is sent as soon as work
begins and **edited** as it progresses — "Working…", then the tools being
run, then the reply, in one message that never scrolls away. Edits are
coalesced, because Telegram throttles them to roughly one every few seconds
and an agent making twenty tool calls in ten seconds would trip that
immediately.

**From the desktop**, what is said in the room is mirrored out to the
connected chat: your messages, and each agent's final reply. Tool cards,
approval notices, room events and streaming fragments are **not** — a busy
agent makes dozens of those, and a phone that buzzes for every shell command
is a phone with notifications switched off by the evening.

Nothing is echoed back where it came from. Your own message is already on
your screen because you typed it, and the answer to a Telegram-initiated turn
is delivered by editing its placeholder; mirroring either would show it
twice.

A reply longer than Telegram's 4096-character limit is **split**, not
truncated — Telegram rejects an over-length message outright rather than
trimming it, so the alternative is that a long answer never arrives. The
split prefers a blank line, then a line end, then a space.

The desktop's room panel says **"Also reachable from — Telegram"** so a
conversation that can be read from elsewhere looks different from one that
cannot.

## Approvals from a phone

An agent set to `auto` does **not** inherit that when the request arrives
from Telegram: a chat anyone could compromise is not the same risk as the
keyboard in front of you, so `auto` is reduced to `ask`. The room says why,
because "it asked me again" is otherwise indistinguishable from a bug.

The approval itself is a card in the chat with **✅ Allow** and **✖ Deny**
buttons.

To stop being asked for a particular agent, set **Configure → that agent →
"When asked from Telegram"** to `auto`. That is a deliberate grant of remote
autonomy rather than something you can drift into.

**Standing "always allow" grants are made at the desktop only.** The Telegram
card offers a one-off decision. That is the same reasoning as the downgrade:
whoever controls the chat should not be able to grant a permission that
outlives the compromise. Whether the friction is worth it is an open question
— see gap 6 in [STATUS.md](STATUS.md).

## Security notes

- The bot token is a bearer credential. Anyone holding it can send as your
  bot. It lives encrypted at rest and never in the settings file.
- The bot answers only the configured chat, or a chat already bound to a
  conversation. A stranger who finds the bot gets silence.
- A message from Telegram is attributed to you, and every entry records the
  channel it came through.
- Punctuation-heavy agent output is escaped for MarkdownV2 and verified
  against the real API — an unescaped `_` or `*` makes Telegram reject the
  whole message.

## Limits

- **A group chat cannot bootstrap its own binding.** The bot accepts the
  configured chat or an already-bound one, so `/connect` typed in a fresh
  group is refused for want of a binding. To use a group, make it the
  configured chat first. This is a real gap rather than a decision.
- **One conversation per chat.** A second `/connect` re-points it. Forum
  **topics** are separate endpoints, so a single group can hold several
  rooms, one per topic.
- **Telegram forgets.** Updates older than roughly a day are dropped, which
  is why Find my chat needs a recent message.
- **One reader per bot.** Telegram answers a second poller with 409, so
  WispCrew starts a listener only in the daemon — never also in the desktop,
  which would fight it for every message.
