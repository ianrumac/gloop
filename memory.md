# gloop-effect Tweet Options

## Option 1 — The pitch

> We rebuilt our agent loop on Effect-TS primitives.
>
> `@hypen-space/gloop-effect` gives you:
> • TaggedError unions — `catchTag` narrows precisely
> • Stream events via PubSub — backpressure for free
> • Fiber interrupts — no more AbortController
> • Layer DI — swap providers/memory/IO at the root
> • Spans everywhere — plug in OTel, get full traces per turn
>
> Same Form ADT. Same tools. Just Effect all the way down.

## Option 2 — Shorter, punchier

> gloop-effect: an Effect-TS native agent loop.
>
> Typed errors. Streamed events. Structured concurrency. Layer-based DI. OpenTelemetry spans on every turn, tool call, and provider request — zero config.
>
> Your agent runtime, but it composes like a program should.
>
> github.com/hypen-space/gloop

## Option 3 — The SICP energy

> What if your agent loop was a well-typed program instead of a bag of callbacks?
>
> gloop-effect: Effect-TS primitives powering the actor shell. PubSub for events. Fibers for concurrency. Layers for DI. TaggedErrors for failures. Schemas for everything.
>
> Plug in OTel. Get traces. Ship it.

## Option 4 — Thread-starter (tweet + reply)

> **Tweet:** We open-sourced `@hypen-space/gloop-effect` — an Effect-TS native agent loop. Typed errors, observable streams, structured concurrency, and OpenTelemetry traces on every operation. No callbacks. No stringly-typed anything.
>
> **Reply 1:** Tools are plain objects with `execute: () => Effect<string, YourError>`. Permission gates return `Option.some(reason)` to pause for confirmation. Failures fold into the model context — it sees the error and decides what to do.
>
> **Reply 2:** Events stream via PubSub — 17 discriminated variants. Subscribe before sending, filter by tag, merge streams, get backpressure. Late subscribers miss nothing they care about if they use `sendSync`.
>
> **Reply 3:** Wire `@effect/opentelemetry` at the root. Every `Agent.send`, `Interpreter.dispatchCall`, `Conversation.stream` — already spans. Full trace per turn. Zero code change in your app.
