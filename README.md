# github-core-clone-02

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/habibtjiu/github-core-clone-02/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/habibtjiu/github-core-clone-02/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process. No UI, no outside service, no git binary, no dependencies — just the Node standard library and an in-memory store. It serves four surfaces from one store, so a repository created over REST can be pushed to over git, read over GraphQL, and managed over MCP.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=51j2tt3j&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Surfaces

- **Git smart HTTP** — `git-upload-pack` protocol v2 (`ls-refs`, `fetch`, shallow clones, thin packs) and v0 advertisement, plus `git-receive-pack` v0 pushes with fast-forward checks, delta resolution, and sideband reporting.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels, issues, pull requests (including three-way squash merges), and git refs.
- **GraphQL** at `/api/graphql` — viewer, repositories, issues, pull requests, cursored connections, introspection of the implemented schema, and mutations that act on the same store.
- **MCP** at `/mcp` — JSON-RPC over Streamable HTTP with six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Lifecycle

`main.ts` binds an ephemeral port, registers it with the trial environment at `$MAKEFUN_ENV_URL`, serves until the environment reports done, and exits 0. Without `MAKEFUN_ENV_URL` it exits 1. The API surfaces require `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` takes no auth.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | Trial lifecycle: bind, register, poll done, exit. |
| `app.ts` | HTTP server, auth, routing, uniform headers. |
| `store.ts` | In-memory store: repos, objects, refs, issues, PRs, merges. |
| `gitobj.ts` | Object model, packfiles, deltas, pkt-lines, reachability. |
| `gitproto.ts` | Git smart HTTP: advertisements, ls-refs, fetch, receive-pack. |
| `rest.ts` | REST v3 endpoints and serializers. |
| `graphql.ts` | GraphQL parser, mini-schema, executor, resolvers. |
| `mcp.ts` | MCP endpoint and tools. |
| `httputil.ts` | Shared request/response, JSON, and pagination helpers. |

## Determinism

State is a pure function of the request sequence: timestamps come from a fixed epoch plus a monotonic counter, never from the wall clock, and nothing scored uses randomness. Two runs over the same requests leave identical state.

## License

MIT. See `LICENSE`.
