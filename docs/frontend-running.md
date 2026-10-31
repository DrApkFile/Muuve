# Run the Muuve frontend

The Next.js application is in `apps/web`. The package manifest, pnpm lockfile and
shared dependencies live at the repository root. `apps/web` has no separate
`package.json`. Use the pinned pnpm version and run installation from the root.

## Local development with the hosted API

```sh
cd /home/kingghidorah/Documents/projects/bounties/Muuve
pnpm install --frozen-lockfile
MUUVE_API_URL=https://muuve.onrender.com pnpm dev
```

Open `http://127.0.0.1:3000`. If port 3000 is occupied, use the address printed by
Next.js. The homepage is `app/(marketing)/page.tsx`; the parenthesized folder is a
route group, so its public URL is `/`.

The explicit `MUUVE_API_URL` is important: the current `dev` script sets
`APP_BASE_URL=http://127.0.0.1:3000`, which otherwise selects the in-process backend.
Using the hosted API avoids needing local database/provider/operator credentials
for the frontend. The `/api` route (`lib/server/forward.ts`) handles API calls and cookies on the
server. Do not copy backend secret files into the frontend application.

The previous missing `@tailwindcss/postcss` error was caused by frontend dependencies
not being installed locally. The plugin and Tailwind are already declared and
pinned. Do not add a duplicate dependency manifest in `apps/web`, mix npm installs
with the pnpm workspace, or replace the lockfile to fix it.

## Vercel frontend settings

Use the existing Render API; this is a separate frontend deployment. In Vercel:

| Setting                                                       | Value                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Root Directory                                                | `apps/web`                                                                   |
| Framework Preset                                              | **Next.js**                                                                  |
| Include source files outside Root Directory in the Build Step | Enabled; root dependencies and `packages/shared` are needed                  |
| Install Command                                               | `cd ../.. && pnpm install --frozen-lockfile`                                 |
| Build Command                                                 | `cd ../.. && pnpm build`                                                     |
| Output Directory                                              | Framework default `.next`; remove static `public`, `dist` or `out` overrides |
| Node.js                                                       | 24.x, compatible with the current local runtime and package requirements     |

`apps/web/vercel.json` sets the framework, `.next` output and install/build commands. Root Directory
and external-source inclusion are project settings that must still be correct.
There is no separate Vercel start command or static export for this app; Next.js
server actions and dynamic routes need framework deployment support.

Set this **server-side** Vercel environment variable for the intended environments:

```dotenv
MUUVE_API_URL=https://muuve.onrender.com
```

Do not prefix it with `NEXT_PUBLIC_`.

**Render must then use the Vercel address as `APP_BASE_URL`** (for example
`https://muuve-web.vercel.app`, no trailing slash) and be redeployed. The `/api` route
forwards the page's origin, the API checks it against `APP_BASE_URL`, and the wallet
login message names that host. Phantom refuses to sign a login message whose domain
differs from the page, so with Render's own address there, wallet sign-in on Vercel
fails. Only one address can be the sign-in address at a time. Keep claim/cashout gates off until their actual
hosted verification is complete. `NEXT_PUBLIC_CLAIMS_ENABLED` is a build-time flag;
recipient keep remains disabled until legitimate Privy enrollment is verified.

Save settings and redeploy the intended commit. If stale output persists, redeploy
without the existing build cache. A successful build with `404 NOT_FOUND` can still
indicate a framework/output/domain mismatch; the settings above need verification
against the actual deployment, not just the Git checkout.

References: [Vercel build settings](https://vercel.com/docs/builds/configure-a-build),
[external monorepo sources](https://vercel.com/docs/monorepos/monorepo-faq),
[404 diagnosis](https://vercel.com/kb/guide/how-to-debug-404-errors).
