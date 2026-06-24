# Buchungswidget per iframe einbetten

## Basis

```html
<iframe
  src="https://guesty.remoterepublic.com/p/farmhouse"
  width="100%"
  height="520"
  style="border:0;max-width:480px"
  loading="lazy"
  title="Buchungskalender">
</iframe>
```

`farmhouse` durch den jeweiligen Property-Slug ersetzen.

## Sprache

| URL | Sprache |
|-----|---------|
| `…/p/farmhouse` | automatisch (Browser; Default Deutsch) |
| `…/p/farmhouse?lang=de` | Deutsch erzwungen |
| `…/p/farmhouse?lang=en` | Englisch erzwungen |

Für eine englische Seite den Parameter direkt an die iframe-`src` hängen:
`src="https://guesty.remoterepublic.com/p/farmhouse?lang=en"`.

## Hinweise

- **Höhe**: `height` ggf. an deine Seite anpassen (das Widget skaliert in der Breite, nicht automatisch in der Höhe).
- **Responsive**: `width="100%"` + `max-width` setzen; das Layout ist mobile-first.
- Keine weiteren Parameter/Keys nötig — Property und Buchungs-E-Mail sind serverseitig pro Slug konfiguriert.
