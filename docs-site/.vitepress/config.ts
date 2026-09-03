import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitepress'

interface SiteManifest {
  projects: { name: string; domains: { name: string; slug: string }[] }[]
}

const manifestPath = path.join(__dirname, '../manifest.json')
const manifest: SiteManifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  : { projects: [] }

const sidebar: Record<string, { text: string; link: string }[]> = {}
const nav: { text: string; link: string }[] = []

for (const project of manifest.projects) {
  nav.push({ text: project.name, link: `/${project.name}/` })
  sidebar[`/${project.name}/`] = project.domains.map((domain) => ({
    text: domain.name,
    link: `/${project.name}/${domain.slug}`,
  }))
}

export default defineConfig({
  title: 'Architecture',
  description: 'Auto-generated module/function map of the app',
  base: '/docs/',
  themeConfig: {
    nav,
    sidebar,
    search: { provider: 'local' },
  },
})
