import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'en-US',
  title: 'JaGate',
  description: 'A self-hosted human approval gateway for applications',
  base: '/JaGate/',
  lastUpdated: true,
  themeConfig: {
    siteTitle: 'JaGate',
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
    footer: { message: 'MIT licensed. JaGate coordinates approval; your application performs the action.' },
  },
});
