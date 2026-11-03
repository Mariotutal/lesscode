import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
    title: 'LessCode',
    description:
      'Install and use the shared review engine, MCP, portable skill and private workers. Interpret patch gates and bounded factual verification separately.',
    base: '/lesscode/',
    themeConfig: {
      nav: [
        { text: 'Home', link: '/' },
        { text: 'Install', link: '/install' },
        { text: 'Use', link: '/run' },
        { text: 'Integrate', link: '/consumers' },
        { text: 'Architecture', link: '/architecture' },
        { text: 'Providers', link: '/providers' },
        { text: 'Validation', link: '/validation' },
      ],
      sidebar: [
        {
          text: 'Get started',
          items: [
            { text: 'Install, update and uninstall', link: '/install' },
            { text: 'Run and interpret results', link: '/run' },
            { text: 'Providers and credentials', link: '/providers' },
            { text: 'MCP and portable skills', link: '/consumers' },
          ],
        },
        {
          text: 'Operate and understand',
          items: [
            { text: 'Architecture', link: '/architecture' },
            { text: 'Factual verification', link: '/factual-review-verification' },
            { text: 'Validation and limits', link: '/validation' },
            { text: 'Private hosted deployment', link: '/hosted-deployment' },
            { text: 'Hardening roadmap', link: '/architecture-hardening-plan' },
            { text: 'Legacy simplify interfaces', link: '/simplify-tool' },
          ],
        },
        {
          text: 'History and evidence',
          items: [
            { text: 'Historical live measurements', link: '/eval-live-runs' },
            { text: 'Development log', link: '/development' },
            { text: 'Original PR load proposal', link: '/pull-request-load-spec' },
            { text: 'Withdrawn external audit', link: '/external-audit-findings' },
          ],
        },
      ],
      search: {
        provider: 'local',
      },
    },
  }),
)
