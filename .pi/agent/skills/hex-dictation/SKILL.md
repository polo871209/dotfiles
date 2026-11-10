---
name: hex-dictation
description: Teach Hex a word it mistranscribes, such as "Cloud MD" for AGENTS.md.
disable-model-invocation: true
---

The user names the intended word, and sometimes the misheard text. Hex is `/Applications/Hex.app/Contents/MacOS/hex`.

1. Find every spelling Hex produced for the word in the `Raw:` lines of `hex history --since today --raw --limit 30`. Keep each case variant as its own spelling.
2. In `/Users/polo/dotfiles/hex/settings.json`, add the spellings to the word's `sounds_like` in `vocabulary`, and create the term if it is missing. Then add one `{ "matched_phrase": <spelling>, "output": <word> }` per spelling to `dictation_processing.default_mode.replacements`. Keep both lists grouped by term, terms and spellings in alphabetical order.
3. Run `node --test /Users/polo/dotfiles/hex/settings.test.mjs` until it passes.
4. Run `hex restart`, because Hex reads `settings.json` only at startup.
5. Ask the user to dictate the word once. Done when the newest `hex history --raw --limit 3` entry shows the misheard `Raw:` text and the word as the final text.
