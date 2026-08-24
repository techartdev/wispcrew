# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository, or contact a maintainer directly.

Please include what you found, how to reproduce it, and what an attacker could
achieve. If you have a proof of concept, that helps — but a clear description is
enough to get started.

You can expect an acknowledgement within a few days. We will keep you updated
as we investigate, and we are happy to credit you in the release notes unless
you would rather stay anonymous.

## Supported versions

GhostBot is pre-1.0. Fixes land on the `main` branch and in the next release.
There are no long-term support branches yet.

## Threat model

Understanding what GhostBot *is* makes it clearer what counts as a
vulnerability.

**GhostBot deliberately runs code on your machine.** An agent can execute shell
commands and write files — that is the product. The security boundary is not
"the agent cannot act", it is:

1. **You approve dangerous actions.** By default, reading is free but writing or
   executing requires explicit approval. An agent set to `readonly` must never
   write or execute; an agent set to `auto` runs unattended *because you asked
   it to*.
2. **File tools stay in the workspace.** Path traversal outside the configured
   workspace root is rejected.
3. **Model output is data, never code.** The renderer builds React elements
   rather than HTML, so a model response cannot inject markup or script. Only
   `http(s)` links are clickable.
4. **The renderer is sandboxed.** No Node integration, no direct `ipcRenderer`,
   and a strict CSP that forbids remote and inline script and outbound
   connections. The UI reaches the main process only through an enumerated set
   of named methods.
5. **Keys stay out of the renderer and off disk in plaintext.** API keys are
   encrypted with the OS keychain and are never sent to the UI.

### In scope

- Bypassing the approval gate (running a command or writing a file that should
  have prompted)
- Escaping the workspace root through a file tool
- Executing script in the renderer, or escaping the sandbox
- Leaking an API key — to the renderer, to a log, to disk in plaintext, or to
  any endpoint other than the configured provider
- An MCP server or tool result escalating beyond its intended reach
- Anything that sends user data somewhere the user did not choose

### Out of scope

- **The agent doing something you approved.** If you approve `rm -rf`, it runs.
- **Prompt injection changing what the agent *says*.** Untrusted content in a
  web page or file can influence model output; that is inherent to LLMs. It
  *is* in scope if it causes an action to bypass the approval gate.
- **`auto` approval policy being dangerous.** It is documented as such.
- Vulnerabilities in a model provider's own API.
- Anything requiring an attacker to already have code execution on the machine
  as your user.

## Hardening tips

- Keep the default **Ask every time** policy unless you are working in a
  disposable directory.
- Set a **workspace folder** per agent rather than pointing at your home
  directory.
- Use **read-only** agents for anything that touches untrusted content — a
  summarizer pointed at the web has no business writing files.
- Treat MCP servers like any other software you install: they are local
  processes with your permissions.
