# AI tools used

The brief asks for this list, and says I should be able to defend every important decision. Both
parts are answered below.

## What I used

**Claude (Anthropic), via Claude Code** — used throughout, as a pair-programming environment with
shell, file and browser access. Concretely it was used for:

- Scaffolding the monorepo, configs and boilerplate.
- Writing implementation and test code from my design decisions.
- Running the test suite, the evaluation harness and the servers, and iterating on failures.
- Driving Chrome to walk the guest journey and catch UI defects.
- Drafting this documentation.

No other AI tools (Copilot, Cursor, ChatGPT, Codex) were used on this project.

## What the AI did not decide

The decisions the brief asks me to defend were made deliberately, and most of them were made
*against* the obvious default:

- **Lexical BM25 retrieval instead of embeddings.** The reflexive answer for "RAG" is a vector
  store. For 47 curated facts that adds a network call per turn, makes tests non-deterministic and
  kills the offline mode, in exchange for recall a synonym table provides for free. The A/B in
  [EVALUATION.md](./EVALUATION.md) is deliberately reported as *no accuracy difference, 2.4× fewer
  tokens* rather than dressed up as an accuracy win.
- **Citation validation as the actual guardrail.** Prompt instructions and retrieval only improve
  the odds. Enforcing `sourceIds` server-side, and discarding answers that fail, is the part that
  holds — including the stricter rule that citing a real-but-not-retrieved fact is still a violation.
- **The AI/deterministic split.** Dates, pricing, GST slabs and occupancy are computed in ordinary
  code and never asked of the model; the engine's numbers reach the UI without passing through it.
- **Degradation over failure.** The knowledge base lives outside the model, so a model outage
  returns a real cited answer with `degraded: true` rather than a 500.
- **The offline mock provider.** Built so the repo is runnable and testable with no API key — and
  documented as a pipeline test, not evidence about model behaviour.
- **UX choices**: badging refusals so they cannot be mistaken for answers, showing rooms that were
  ruled out with reasons, staged loading labels, and two always-available routes to entering dates.

## Bugs the AI introduced that testing caught

Worth recording, because it is the honest version of "I used AI to build this":

1. **Client-disconnect handling was wrong.** The first version aborted on the *request* stream's
   `close` event, which fires as soon as the body is read — it would have cancelled live model calls
   mid-turn. Fixed to watch the response and check `writableEnded`.
2. **"close" grouped with "nearby" in the synonym table**, so *"what time does the spa close"*
   returned the list of nearby attractions. Caught by the retrieval battery.
3. **Split compounds never matched.** *"is there somewhere to work out"* tokenised to "work" + "out"
   and hit *check-out*. Fixed with query-side bigram joining.
4. **Coverage was measured against the top-K slice**, so widening `topK` made out-of-scope questions
   look answerable — backwards. Fixed to measure against the whole corpus.
5. **Conversation history hijacked short questions.** *"What is the cancellation policy?"* inherited
   "breakfast" from the previous turn and returned the **wrong answer**. Found by walking the UI in
   a browser, not by any test that existed at the time.
6. **The composer was `disabled` while sending**, which blurred it and silently dropped the next
   message. Also found in the browser.
7. **The booking-form path did not call the availability tool.** With dates in the message the model
   called `check_availability` correctly; with the same dates supplied as structured `context` from
   the form, `gpt-4o-mini` asked the guest to re-enter dates they had just picked. Caught only by
   `npm run eval -- --live`, which scored 12/16 while the offline suite was fully green.
8. **A rejected stay was labelled `fallback`**, which the UI badges *Not in our records* — wrong,
   since the records are fine and the guest's dates are not. Also caught live.

Numbers 5 and 6 are one lesson: the unit and integration suites were green throughout, and only
driving the real interface found them. Numbers 7 and 8 are the sharper version of the same lesson —
a deterministic offline provider proves the *pipeline* works and proves nothing about whether a real
model behaves. Both are now covered by regression tests that use a stub provider deliberately
misbehaving the way the live model did.
