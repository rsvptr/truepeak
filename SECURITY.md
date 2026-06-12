# Security

TruePeak is a client-only web app: audio is read, decoded, and analyzed entirely in the browser. There is no backend, no database, no account system, and no upload path — the only server-side work is reading a theme cookie. That shapes the threat model below.

## Threat model

Untrusted input reaches the app in three ways:

1. **Audio files** the user opens or drops (WAV, RF64, AIFF/AIFC, and compressed formats). Parsed by hand-written binary parsers, the browser's decoder, or a locally served copy of ffmpeg.wasm.
2. **Session files** (`.truepeak.json`) the user imports, which may come from someone else.
3. **The URL query string and localStorage**, which hold workspace state and preferences.

There is no cross-user data flow: nothing a hostile file does can affect anyone but the person who opened it. The interesting attacker goals are therefore running script in the app's origin (XSS), crashing or hanging the tab (DoS), and supply-chain substitution of the code the app ships.

## Protections in place

**Input validation**

- The WAV/AIFF parsers bound every allocation by the actual buffer size, track only the chunk IDs they read (a chunk-flood file cannot balloon memory), stop scanning once required chunks are found, and reject non-finite sample rates (the AIFF 80-bit float can encode NaN/Infinity).
- Session imports are rebuilt field-by-field from a whitelist with type checks, length caps, count caps (1000 jobs, 500k timeline points, 64 MB file size), and scheme-checked URLs. Unknown fields and wrong-typed values never reach React or the exporters.
- Folder drops and file intake are capped (2000 files, directory depth 12).
- CSV exports neutralize spreadsheet formula injection (`=`, `+`, `-`, `@`, tabs/newlines) and escape quoting correctly.
- All untrusted strings render through React text interpolation (no `dangerouslySetInnerHTML` for user data; the single inline script is a static theme snippet).

**Fuzzing**

`npm run test:fuzz` runs a deterministic, seeded fuzz suite (~1,360 cases) over every untrusted-input parser — WAV, AIFF, container sniffing, the main-thread FLAC STREAMINFO reader, and the session importer — asserting clean failures, output invariants, and per-case time budgets. It runs in CI on every push.

**Headers**

Responses carry a Content-Security-Policy (production: no `unsafe-eval`; `wasm-unsafe-eval` only for ffmpeg.wasm; all external script/connect/style origins blocked), `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, and a minimal Permissions-Policy.

**Isolation**

Decoding and analysis run in dedicated workers; a hostile file that crashes a worker takes down only its own lane, which is reset automatically. ffmpeg.wasm runs inside a worker with same-origin assets only.

**Supply chain**

- The ffmpeg.wasm runtime served to users is verified against pinned SHA-256 hashes at build time (`scripts/prepare-ffmpeg-assets.mjs`); a substituted package fails the build.
- Dependencies are locked via `package-lock.json`; CI fails on `npm audit` findings of high severity or above.

## Accepted risks

- `script-src 'unsafe-inline'` remains in the CSP because Next.js App Router bootstraps with inline scripts; removing it requires nonce middleware. External script origins are still blocked, which closes the common XSS exfiltration path.
- `style-src 'unsafe-inline'` remains for framework-injected styles.
- `npm audit` reports moderate advisories for the PostCSS copy bundled inside Next.js's build tooling. It processes only this repo's own trusted CSS at build time and is not reachable at runtime; the only offered remediation is a major Next downgrade.
- Browsers without `navigator.deviceMemory` fall back to conservative parallelism heuristics rather than hard guarantees.

## Reporting

Please report suspected vulnerabilities privately via GitHub security advisories on this repository rather than public issues. Include the file or input that triggers the problem if you can — the fuzz suite's seed-based reproduction makes fixes fast to verify.
