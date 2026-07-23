import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextVitals,
  {
    ignores: [".next/**", "out/**", "test-results/**", "playwright-report/**", "public/vendor/**"],
  },
  {
    // eslint-plugin-react-hooks v6 ships React Compiler advisory rules. This project
    // does not enable the React Compiler (no experimental.reactCompiler in next.config.ts),
    // and intentionally uses manual memoization (stable callbacks keep the memoized queue
    // rows from re-rendering during analysis) plus a couple of legitimate state-syncing
    // effects (e.g. mirroring the URL search param into the search box). Turn off the two
    // optimizer advisories that flag those patterns; keep the rules that catch real bugs —
    // rules-of-hooks, exhaustive-deps, and refs (no ref access during render).
    rules: {
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default config;
