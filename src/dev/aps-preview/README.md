# APS letter review preview

Run `npm run preview:aps` and open `/workspaces/aps/letters`. This is a local,
review-only harness around the actual APS components and Supabase query hooks.
Its Vite aliases replace authentication, capabilities, branding and the
Supabase transport with fictional, in-memory fixtures. It does not connect to a
real project and must not be treated as a test of authentication, PostgREST or
RLS. No data from this harness is intended for production.

The banner's scenario selector exercises an empty list, a simulated denial, a
network failure and denied directory access. Snapshot names remain visible in
the latter scenario, without a directory read. Filters and detail navigation use
the same screens and hooks as the application. The preview is separate from the
normal app build.

After installing the Playwright Chromium browser, `npm run test:e2e:aps-preview`
starts this harness and runs browser checks without Supabase or authentication
state. These synthetic tests do not replace the real Supabase E2E suite.
Screenshots for review are in `docs/reviews/aps-letters-snapshot/`.
