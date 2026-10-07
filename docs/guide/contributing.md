# Contributing and documentation

The source repository is [ahmetomerv/JaGate](https://github.com/ahmetomerv/JaGate). Read the [contribution guide](https://github.com/ahmetomerv/JaGate/blob/main/CONTRIBUTING.md) and [changelog](https://github.com/ahmetomerv/JaGate/blob/main/CHANGELOG.md) before submitting changes. Use Node.js 24.21.0.

Documentation lives in `docs/` and is built with VitePress. From the repository root:

```sh
npm ci
npm run docs:dev       # local documentation server
npm run docs:build     # static site and link check
npm run docs:preview   # preview the built site
npm run verify         # typecheck, tests, lint, app build, docs build
```

The site uses base path `/JaGate/` because the repository is published as a GitHub Pages project site at `https://ahmetomerv.github.io/JaGate/`. The same base path appears in local dev and preview URLs. Generated `.vitepress/cache` and `.vitepress/dist` files are ignored by Git.

The public website is deployed from the VitePress build artifact. Documentation files and generated website assets are excluded from the npm package, whose README links to the site.

Whenever code, configuration, or behavior changes, update the relevant guide, API reference, architecture page, and examples in the same change. The Pages workflow builds and checks the docs on pull requests and on every push to `main`; it deploys the built site after a successful `main` push. To activate the first deployment, select **Settings → Pages → Build and deployment → Source: GitHub Actions** in the repository. No bot token or client key is needed to build the public docs site.
