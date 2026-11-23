import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Domicile loads the shell as one ES module and never a stylesheet, so every
 * CSS asset vite extracts (ours, driver.js's, Domicile's component library)
 * is moved into the entry as a `<style>`. From
 * `@domicile-desktop/component-library/vite-shell`, which ships as TypeScript
 * Node won't load from node_modules.
 */
const cssInTheModule = (): Plugin => ({
  name: 'cwm:css-in-the-module',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const styles = Object.entries(bundle).flatMap(([name, out]) =>
      out.type === 'asset' && name.endsWith('.css') ? [{ name, css: String(out.source) }] : [],
    )
    const entry = Object.values(bundle).find((out) => out.type === 'chunk' && out.isEntry)
    if (!styles.length || !entry || entry.type !== 'chunk') return
    for (const s of styles) delete bundle[s.name]
    const css = JSON.stringify(styles.map((s) => s.css).join('\n'))
    entry.code = `(() => { const s = document.createElement("style"); s.textContent = ${css}; document.head.append(s) })();\n${entry.code}`
  },
})

// The app as a Domicile desktop shell: `dist-shell/shell.js`, whose `Shell` export Domicile calls.
export default defineConfig({
  plugins: [react(), cssInTheModule()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist-shell',
    // Fonts travel with the CSS that names them; a relative URL would resolve against the page.
    assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? true : undefined),
    rollupOptions: {
      input: 'src/domicile/shell.tsx',
      output: { entryFileNames: 'shell.js', inlineDynamicImports: true },
      // Keep `Shell`: an app build drops the entry's exports.
      preserveEntrySignatures: 'exports-only',
    },
    sourcemap: true,
  },
})
