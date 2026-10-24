# Running the preview screenshots in a sandbox

`npm run preview:ui` serves the review harness on `http://localhost:4173` and
needs no browser. `scripts/preview/screenshots.mjs` drives that harness with
Playwright to capture the dialog states, and Playwright's own browser download
is blocked in this environment. The workaround below is sandbox-local; nothing
in it ships with the app.

1. **Chromium binary.** The `@sparticuz/chromium` npm package carries an
   x86-64 build; inflating it writes `/tmp/chromium` (also the path the script
   defaults to):

   ```bash
   npm i --no-save @sparticuz/chromium
   node -e "require('@sparticuz/chromium').default.executablePath().then(console.log)"
   ```

2. **Missing shared libraries.** That build is dynamically linked against
   NSS/NSPR, which this image does not ship:

   ```
   libnspr4.so  libnss3.so  libnssutil3.so
   ```

   `libnss3.so` and `libnssutil3.so` came from a GitHub mirror of the NSS
   libraries (`melon-gg/libnss3.so`), `libnspr4.so` was built from the NSPR
   source (`mozilla/nspr`, `--enable-64bit`). Both live in `/tmp/nsslibs`, so:

   ```bash
   LD_LIBRARY_PATH=/tmp/nsslibs node scripts/preview/screenshots.mjs
   ```

   `ldd /tmp/chromium | grep "not found"` must print nothing before the script
   can run.

3. **Launch flags.** `--no-sandbox --disable-dev-shm-usage --single-process
--no-zygote` — the usual container set.

Everything in `/tmp` is ephemeral: after a sandbox restart, repeat steps 1–2.
The script fails loudly (`executable doesn't exist`) rather than silently
producing blank images if the binary is gone.
