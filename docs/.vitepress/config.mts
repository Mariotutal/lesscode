import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
    title: 'LessCode',
    description:
      'LessCode reviews a JavaScript or TypeScript change and returns two things: a cited note, and a patch only when the checks still match that edit.',
    base: '/lesscode/',
    // docs/development.md links to the repo README at ../README.md, outside the docs root.
    ignoreDeadLinks: [/README/],
    themeConfig: {
      nav: [
        { text: 'Home', link: '/' },
        { text: 'Run', link: '/run' },
        { text: 'Architecture', link: '/architecture' },
        { text: 'Measurements', link: '/eval-live-runs' },
      ],
      sidebar: [
        {
          text: 'More',
          items: [
            { text: 'Simplify tool', link: '/simplify-tool' },
            { text: 'Development log', link: '/development' },
          ],
        },
      ],
      search: {
        provider: 'local',
      },
    },
  }),
)
