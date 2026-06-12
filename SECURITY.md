<div align="center">
  <img src="./public/logo.png" alt="TruePeak logo" width="120" />
  <h1>Security</h1>
  <p>How TruePeak handles untrusted input, what protects the app and your data, what risks are accepted on purpose, and how to report a problem.</p>

  <p>
    <a href="https://github.com/rsvptr/truepeak/actions/workflows/ci.yml">
      <img src="https://img.shields.io/github/actions/workflow/status/rsvptr/truepeak/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI status" />
    </a>
    <img src="https://img.shields.io/badge/Checks-96_fixed_+_1362_fuzz-0f9684?style=for-the-badge" alt="96 fixed checks plus 1362 fuzz cases" />
    <img src="https://img.shields.io/badge/ffmpeg.wasm-integrity_pinned-654FF0?style=for-the-badge&logo=webassembly&logoColor=white" alt="ffmpeg.wasm integrity pinned" />
  </p>
</div>

> **Note**
>
> TruePeak is a client-only app. Your audio is read, decoded, and analyzed in your own browser. There is no upload path, no backend database, and no account system, so there is no server-side audio or user data to steal in the first place. The security work below is about the inputs the app does accept, and about making sure the code you run is the code that was reviewed.

The short version: every parser that touches untrusted bytes is bounded, validated, and fuzzed; the pages ship with a strict Content-Security-Policy and friends; the one large third-party binary is fingerprint-pinned at build time; and CI re-proves all of it on every push. The rest of this document walks through each layer, then states the accepted risks plainly.

## Contents

- [The security model](#the-security-model)
- [What an attacker could try](#what-an-attacker-could-try)
- [How untrusted input is handled](#how-untrusted-input-is-handled)
- [Limits on untrusted input](#limits-on-untrusted-input)
- [Headers the pages ship with](#headers-the-pages-ship-with)
- [What is stored where](#what-is-stored-where)
- [Supply chain](#supply-chain)
- [Continuous verification](#continuous-verification)
- [Check it yourself](#check-it-yourself)
- [Accepted risks](#accepted-risks)
- [Reporting a vulnerability](#reporting-a-vulnerability)

## The security model

Everything interesting happens on your machine. The only server-side work in the whole app is reading a theme cookie so the first paint uses the right colors. That shapes the threat model in a useful way: there is no cross-user data flow, so nothing a hostile file does can affect anyone except the person who opened it.

What is worth defending, then, is the browser session itself: an attacker should not be able to run script in the app's origin, crash or hang the tab, quietly corrupt your stored results, or swap the code the app ships for something unreviewed.

## What an attacker could try

Untrusted input reaches TruePeak in three ways, and each one goes through its own validation layer before anything else sees it:

```mermaid
flowchart LR
    A["Audio files (drop or picker)"] --> P["Bounded binary parsers in worker lanes"]
    B["Session files (.truepeak.json)"] --> W["Whitelist rebuild with caps"]
    C["Restored results (IndexedDB)"] --> W
    D["URL query + localStorage"] --> E["Enum and shape allowlists"]
    P --> F["Analyzer"]
    W --> G["React text rendering"]
    E --> G
    F --> G
```

1. **Audio files** you open or drop: WAV, RF64, AIFF, AIFC, and compressed formats. These hit hand-written binary parsers, the browser's own decoder, or a locally served copy of ffmpeg.wasm.
2. **Session files** (`.truepeak.json`) you import, which may have been produced by someone else — and the app's own persisted results read back from IndexedDB, which are deliberately treated with the same suspicion.
3. **The URL query string and localStorage**, which hold workspace state and preferences.

The realistic attacker goals are running script in the app's origin (XSS), denial of service against the tab (hangs, memory exhaustion, crashes), and substituting the shipped code (supply chain). Each section below maps to one of those.

## How untrusted input is handled

**Audio files.** The WAV and AIFF parsers bound every allocation by the actual size of the buffer they were handed, so a header that declares an absurd size cannot cause an absurd allocation. The chunk scanners track only the chunk IDs they actually read and stop scanning once those are found, which closes off a real attack we fixed during review: a file made of millions of tiny junk chunks used to balloon memory before a single audio byte was parsed. Format fields are checked for the values binary formats can smuggle past naive checks — the AIFF sample rate is an 80-bit float that can encode NaN and Infinity, both of which sail through a `<= 0` comparison and are now rejected explicitly. Anything that fails parses into a plain error message; the rest of the batch keeps going.

**Worker isolation.** Decoding and analysis run in Web Workers, one independent decoder-and-analyzer pair per active file. A file that manages to crash a worker takes down only its own lane, which is terminated and replaced automatically — it cannot touch a neighbouring file's work or the page itself. ffmpeg.wasm runs inside one of those workers and loads only same-origin assets.

**Session files and restored results.** Imports are not trusted-then-checked; they are rebuilt. Every field the app will ever read is type-checked, length-capped, count-capped, and copied into a fresh object — unknown fields and wrong-typed values simply never exist on the other side. URLs embedded in a session file are kept only if they are plain `http(s)`. The same validator runs on the app's own IndexedDB records when a session is restored after a refresh: IndexedDB is same-origin, but treating stored bytes as trusted is how corruption turns into a crash, so they get the full rebuild too. A malformed file is rejected with a clear message rather than a broken screen.

**The URL and localStorage.** Workspace state in the query string (active tab, filters, sort, and so on) is matched against fixed allowlists — an unknown value falls back to a default rather than reaching any logic. Preferences read from localStorage are validated the same way, and stored history entries are shape-checked before use.

**Rendering and exports.** Untrusted strings only ever render through React text interpolation, which escapes them; the app uses no `dangerouslySetInnerHTML` for user data (the single inline script in the page is a static theme snippet with no inputs). On the way out, the CSV export escapes quotes, commas, and line breaks and neutralizes anything a spreadsheet would treat as a formula (`=`, `+`, `-`, `@`, tabs, newlines), so a hostile filename cannot become an executing cell in Excel.

## Limits on untrusted input

Caps keep a hostile or simply enormous input from becoming a memory problem. These are the enforced numbers, straight from the source:

| Input | Limit |
| --- | --- |
| Session file size | 64 MB per import |
| Jobs per session file | 1,000 |
| Timeline points per result | 500,000 |
| Short strings (names, labels) | 512 characters |
| Long strings (notes, descriptions) | 2,000 characters |
| Notes and warnings per result | 64 entries |
| Files accepted per add | 2,000 |
| Folder-drop traversal depth | 12 levels |

When a cap truncates something, the app says so in a notice instead of pretending it covered everything.

## Headers the pages ship with

Every response carries a defensive header set. The Content-Security-Policy is the load-bearing one: it blocks every external script, style, and connection origin, which closes the common exfiltration path even if markup injection were ever found.

| Header | Value (production) | What it prevents |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'` with `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:`, workers/media/connect restricted to `'self' blob:`, `object-src 'none'`, `frame-ancestors 'none'`, `upgrade-insecure-requests` | Loading script or sending data anywhere external |
| `X-Frame-Options` / `frame-ancestors` | `DENY` / `'none'` | Clickjacking inside an iframe |
| `X-Content-Type-Options` | `nosniff` | MIME-type confusion |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Leaking URLs to other sites |
| `Cross-Origin-Opener-Policy` | `same-origin` | Window-handle attacks from popups |
| `Permissions-Policy` | camera, microphone, geolocation, payment, USB all disabled; screen wake lock allowed for the app itself | Quiet use of powerful browser features |

Production drops `'unsafe-eval'` entirely — `'wasm-unsafe-eval'` is just enough for ffmpeg.wasm to compile, and that exact path is exercised in testing under the production policy. Development keeps `'unsafe-eval'` for the bundler's hot reload and nothing else.

## What is stored where

Nothing leaves your machine; this is what stays on it, and how to remove it.

| Store | What lives there | Cleared by |
| --- | --- | --- |
| Cookie (`truepeak-theme`) | Light or dark, one year, `SameSite=Lax`, `Secure` over HTTPS | Switching themes or clearing cookies |
| localStorage | UI preferences, and the optional history summaries (off by default, most recent 20) | The Clear History control or clearing site data |
| IndexedDB | Completed results for the live session, so a refresh doesn't lose a finished batch | Removing files, Clear Session, or clearing site data |

## Supply chain

The largest piece of third-party code the app serves to users is the ffmpeg.wasm runtime, so it gets the strictest treatment: the build copies it from the installed package only after verifying its SHA-256 fingerprints against values pinned in [`scripts/prepare-ffmpeg-assets.mjs`](./scripts/prepare-ffmpeg-assets.mjs). A package that does not match — a hijacked release, a tampered tarball, an unreviewed version — fails the build loudly with both fingerprints printed, rather than reaching anyone's browser. Upgrading it is a deliberate ritual: install, review, run the script with `--print-hashes`, pin the new values.

Around that sit the usual guards: `package-lock.json` pins the whole dependency tree, Dependabot proposes routine updates weekly (with `@ffmpeg/core` deliberately excluded, since an automated bump can only ever produce a red build until a human re-pins it), and CI fails any push whose dependencies carry a known high-severity advisory.

## Continuous verification

Security claims rot unless something re-checks them. Two things do.

**The fuzzer.** `npm run test:fuzz` runs roughly 1,360 deterministic cases against every parser that touches untrusted bytes: mutated WAV files across three encodings, mutated AIFF files, raw noise into every binary parser, mutated FLAC headers (that parser runs on the main thread, so it gets fuzzed directly), mutated session JSON, and two targeted regression cases for the exact memory-exhaustion and NaN-sample-rate bugs found during review. Every case must either parse into sane output or fail with a clean error inside a 250 ms budget — no hangs, no non-Error throws, no runaway memory. The seed is fixed, so any failure reproduces exactly, anywhere.

**The CI gate.** Every push and pull request runs install (which executes the ffmpeg integrity check), lint, all six validation suites — the DSP reference signals, the EBU compliance cases, session round-trips, adversarial robustness, export escaping, and the fuzzer — then a production build and `npm audit --audit-level=high`. The badge at the top of this page is that pipeline's current verdict. The full suite breakdown lives in the [README's testing section](./README.md#testing).

## Check it yourself

None of the above needs to be taken on faith. From a checkout:

```bash
npm install          # runs the ffmpeg integrity check as a postinstall step
npm test             # all six suites: 96 fixed checks + ~1,360 fuzz cases
npm run test:fuzz    # just the fuzzer
node scripts/prepare-ffmpeg-assets.mjs --print-hashes   # current ffmpeg fingerprints
```

And against the live deployment:

```bash
curl -sI https://true-peak.vercel.app/ | grep -iE "content-security|frame|referrer|permissions|opener|content-type-options"
```

## Accepted risks

Stated plainly, with the reasoning, so nobody has to rediscover them:

- **`'unsafe-inline'` stays in `script-src`.** Next.js App Router bootstraps with inline scripts; removing this requires nonce middleware. External script origins are still fully blocked, which is the part that defeats the common XSS exfiltration playbook.
- **`'unsafe-inline'` stays in `style-src`** for framework-injected styles. Style injection without script execution is a minor vector here.
- **`npm audit` reports moderate advisories for the PostCSS copy bundled inside Next.js's own build tooling.** It processes only this repository's trusted CSS at build time, is unreachable at runtime, and the only offered remediation is a major Next.js downgrade.
- **Browsers without `navigator.deviceMemory`** (Safari, Firefox) fall back to conservative parallelism heuristics rather than hard memory guarantees; the heavy-file gate still applies.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub security advisories](https://github.com/rsvptr/truepeak/security/advisories/new) on this repository rather than a public issue. If you can, include the file or input that triggers the problem — the fuzzer's fixed-seed design means a reproducing input usually turns into a regression test in the same change that fixes it.
