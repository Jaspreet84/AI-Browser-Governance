# AGENTS.md

All agent guidance for this repository lives in [CLAUDE.md](CLAUDE.md) — architecture, commands,
enforced invariants, and the security properties that must not regress. Read it in full before
making changes; it is written for any coding agent, not only Claude.

The short version: `npm run check` must pass before every commit, `src/core/` stays free of
`chrome.*`, content scripts cannot use ES module syntax, and the approval dialog's trusted-event
gate is the load-bearing security control of the whole extension.
