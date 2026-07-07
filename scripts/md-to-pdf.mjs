import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import puppeteer from 'puppeteer';

const [,, mdPath, pdfPath] = process.argv;
if (!mdPath || !pdfPath) {
  console.error('Usage: node md-to-pdf.mjs <input.md> <output.pdf>');
  process.exit(1);
}

const md = readFileSync(mdPath, 'utf8');
const bodyHtml = execSync('npx --yes -p marked@latest marked --gfm', { input: md }).toString();

const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }
  h1 { font-size: 20pt; margin-top: 0; }
  h2 { font-size: 15pt; margin-top: 1.4em; border-bottom: 1px solid #ccc; padding-bottom: 0.2em; }
  h3 { font-size: 12pt; margin-top: 1.2em; }
  h4 { font-size: 11pt; margin-top: 1em; }
  p, ul, ol { margin: 0.5em 0; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f4; padding: 0.05em 0.3em; border-radius: 3px; }
  pre { background: #f4f4f4; padding: 0.8em; border-radius: 4px; overflow-x: auto; font-size: 9.5pt; }
  pre code { background: transparent; padding: 0; }
  table { border-collapse: collapse; margin: 0.6em 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  blockquote { border-left: 3px solid #ccc; margin: 0.6em 0; padding: 0.2em 0 0.2em 0.9em; color: #444; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.4em 0; }
  a { color: #0a58ca; text-decoration: none; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({
  path: pdfPath,
  format: 'A4',
  margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
  printBackground: true,
});
await browser.close();
console.log('Wrote', pdfPath);
