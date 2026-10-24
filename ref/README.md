# Reference files

- `wbgt_ref.c`, `wbgt_ref.h`: Liljegren WBGT v1.1 C code (UChicago Argonne licence), in the doubles/C99 revision by Max Lieblich (MIT), from github.com/mdljts/wbgt `src/`. Used to check the JavaScript port in `src/wbgt.mjs` line by line. The app ships the port, not this copy.
- `liljegren-oracle.json` (not in this repository): 418 cases with the original C code's outputs, from the Afuera project (github.com/Afuera-CAC-FL09/Afuera, `engine/test/fixtures/liljegren-oracle.json`). That repository has no licence, so the file is used only as a local test oracle and is never published. Without it, `tests/` skips the oracle comparison.
