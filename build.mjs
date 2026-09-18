import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: { main: 'src/main.js', 'main-style': 'src/main.css' },
  entryNames: '[name]',
  bundle: true,
  outdir: 'public/assets',
  format: 'esm',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: 'chrome120',
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  logLevel: 'info',
});
await ctx.rebuild();
// esbuild names the CSS bundle after its entry; index.html expects main.css
fs.renameSync('public/assets/main-style.css', 'public/assets/main.css');
fs.copyFileSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'public/assets/pdf.worker.min.mjs');
if (watch) await ctx.watch(); else await ctx.dispose();
