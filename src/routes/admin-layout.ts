// src/routes/admin-layout.ts
// Shared HTML page shell matching the admin dashboard look (Fraunces/Manrope +
// the :root design tokens used across admin.ts). Use renderAdminPage() so new
// admin subpages render consistently without duplicating the whole <head>/<style>.

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600;0,9..144,700;1,9..144,300&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">`;

// Design tokens + base element styles copied from admin.ts, plus a small set of
// shared components (buttons, badges, message bubbles, compose form).
const BASE_CSS = `
:root {
  --color-cream: #faf8f5; --color-sand: #f4f1ed; --color-stone: #e8e4df;
  --color-charcoal: #2a2a2a; --color-warm-gray: #6b6560;
  --color-forest: #2d5a3d; --color-forest-light: #3d7a52;
  --color-terracotta: #c75b3c; --color-amber: #d4a574; --color-sage: #8a9a7b;
  --color-red: #c44536; --color-red-dark: #a13828;
  --font-display: 'Fraunces', serif; --font-body: 'Manrope', sans-serif;
  --shadow-sm: 0 2px 8px rgba(42,42,42,0.04); --shadow-md: 0 4px 16px rgba(42,42,42,0.08);
  --shadow-lg: 0 8px 32px rgba(42,42,42,0.12);
  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--font-body); background: var(--color-cream);
  padding: clamp(20px, 4vw, 48px); line-height: 1.65; color: var(--color-charcoal);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
.container { max-width: 860px; margin: 0 auto; }
h1 {
  font-family: var(--font-display); font-weight: 700; font-size: clamp(30px, 4vw, 46px);
  line-height: 1.1; color: var(--color-charcoal); margin-bottom: 8px; letter-spacing: -0.02em;
}
h3 {
  font-family: var(--font-body); font-weight: 600; font-size: 13px; color: var(--color-warm-gray);
  margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.08em;
}
a { color: var(--color-forest); }
.section {
  background: white; padding: clamp(20px, 3vw, 32px); margin-bottom: 24px;
  border-radius: var(--radius-lg); box-shadow: var(--shadow-md); border: 1px solid var(--color-stone);
}
.subtitle { color: var(--color-warm-gray); margin-bottom: 28px; }
.back-link { display: inline-block; margin-bottom: 20px; font-weight: 600; font-size: 14px; text-decoration: none; }
.back-link:hover { text-decoration: underline; }
.count-pill {
  display: inline-block; background: var(--color-forest); color: #fff; border-radius: 999px;
  padding: 3px 14px; font-family: var(--font-body); font-size: 15px; font-weight: 600;
  vertical-align: middle; margin-left: 10px;
}
.badge {
  display: inline-block; background: var(--color-sand); color: var(--color-warm-gray);
  border: 1px solid var(--color-stone); border-radius: 6px; padding: 2px 9px;
  font-size: 12px; font-weight: 600; text-transform: capitalize;
}
.thread-list { list-style: none; }
.thread-list li { border-bottom: 1px solid var(--color-stone); }
.thread-list li:last-child { border-bottom: none; }
.thread-list a {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px 8px; text-decoration: none; color: var(--color-charcoal);
  border-radius: var(--radius-sm); transition: background 0.15s ease;
}
.thread-list a:hover { background: var(--color-sand); }
.thread-name { font-weight: 600; }
.thread-meta { color: var(--color-warm-gray); font-size: 13px; display: flex; gap: 12px; align-items: center; white-space: nowrap; }
.msg { padding: 12px 16px; border-radius: var(--radius-md); margin-bottom: 12px; max-width: 82%; box-shadow: var(--shadow-sm); }
.msg .meta { font-size: 12px; color: var(--color-warm-gray); margin-bottom: 5px; font-weight: 600; }
.msg .body { white-space: pre-wrap; }
.msg.inbound { background: var(--color-sand); border: 1px solid var(--color-stone); margin-right: auto; }
.msg.outbound { background: var(--color-forest); color: #fff; margin-left: auto; }
.msg.outbound .meta { color: rgba(255,255,255,0.75); }
.msg.system { background: transparent; border: 1px dashed var(--color-stone); color: var(--color-warm-gray); font-size: 13px; max-width: 100%; text-align: center; }
.btn {
  font-family: var(--font-body); font-weight: 600; font-size: 14px; border: none;
  border-radius: var(--radius-sm); padding: 12px 22px; cursor: pointer; transition: background 0.15s ease, transform 0.1s ease;
}
.btn:active { transform: translateY(1px); }
.btn-primary { background: var(--color-forest); color: #fff; }
.btn-primary:hover { background: var(--color-forest-light); }
.btn-danger { background: transparent; color: var(--color-red); border: 1px solid var(--color-stone); }
.btn-danger:hover { background: #faeae8; border-color: var(--color-red); }
.btn-ghost { background: var(--color-sand); color: var(--color-warm-gray); border: 1px solid var(--color-stone); }
.btn-ghost:hover { background: var(--color-stone); }
textarea {
  width: 100%; font-family: var(--font-body); font-size: 15px; line-height: 1.6; padding: 14px;
  border: 1px solid var(--color-stone); border-radius: var(--radius-md); background: var(--color-cream);
  color: var(--color-charcoal); resize: vertical;
}
textarea:focus { outline: none; border-color: var(--color-forest); box-shadow: 0 0 0 3px rgba(45,90,61,0.12); }
.draft-preview {
  background: var(--color-sand); border: 1px solid var(--color-stone); border-left: 4px solid var(--color-amber);
  border-radius: var(--radius-md); padding: 16px 18px; white-space: pre-wrap; margin-bottom: 18px;
}
.actions { display: flex; gap: 12px; align-items: center; margin-top: 14px; }
.empty { color: var(--color-warm-gray); padding: 20px 0; }
form { margin: 0; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sync-log {
  background: var(--color-sand); border: 1px solid var(--color-stone); border-radius: var(--radius-sm);
  padding: 10px 14px; margin: 12px 0 4px; font-size: 13px; color: var(--color-warm-gray); line-height: 1.7;
}
.sync-log summary { cursor: pointer; font-weight: 600; }
.sync-bar { display: flex; align-items: center; gap: 12px; }
.sync-info {
  color: var(--color-warm-gray); font-size: 13px; white-space: nowrap;
  /* Feste Mindestbreite: verhindert, dass die Sync-Bar beim Wechsel zwischen
     "Letzter Sync: …" und dem kürzeren "Sync läuft …" umbricht und der Button
     neben die Überschrift nach rechts oben "springt". */
  min-width: 210px;
}
`;

export function renderAdminPage(opts: { title: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
  ${FONTS}
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="container">${opts.body}</div>
</body>
</html>`;
}
