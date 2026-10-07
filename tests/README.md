# bun-react-tailwind-shadcn-template

> **Agent fixture — do not fix the bugs here.**
> `src/pizza-delivery.ts` is intentionally broken (5 of its 30 tests fail).
> `packages/gloop-loop/test/integration.test.ts` points a real agent at it,
> asserts the tests fail first, lets the agent fix them, and restores the file
> afterwards. Repairing the module by hand breaks that test in CI. The root
> `bunfig.toml` keeps this directory out of the repo-wide `bun test` run.

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run for production:

```bash
bun start
```

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
