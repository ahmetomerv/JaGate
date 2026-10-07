import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const base = '/JaGate/';

export default defineConfig({
  lang: 'en-US',
  title: 'JaGate',
  description: 'A self-hosted human approval gateway for applications',
  base,
  vite: { publicDir: fileURLToPath(new URL('../../assets/', import.meta.url)) },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#142C45' }],
  ],
  lastUpdated: true,
  themeConfig: {
    siteTitle: 'JaGate',
    logo: '/logo.svg',
    nav: [
      { text: 'Get started', link: '/guide/getting-started' },
      { text: 'API', link: '/API' },
      { text: 'Architecture', link: '/ARCHITECTURE' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Get started locally', link: '/guide/getting-started' },
          { text: 'Scenario guides', link: '/guide/scenarios' },
          { text: 'Local playground', link: '/guide/playground' },
          { text: 'Docker Compose', link: '/guide/docker' },
          { text: 'Configuration and clients', link: '/guide/configuration' },
          { text: 'TypeScript client', link: '/guide/typescript' },
          { text: 'Security and recovery', link: '/guide/security' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'HTTP API', link: '/API' },
          { text: 'Architecture and schema', link: '/ARCHITECTURE' },
          { text: 'Contributing and docs', link: '/guide/contributing' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/ahmetomerv/JaGate' }],
    editLink: { pattern: 'https://github.com/ahmetomerv/JaGate/edit/main/docs/:path' },
    footer: {
      message: 'MIT licensed. JaGate coordinates approval; your application performs the action.',
    },
  },
});
