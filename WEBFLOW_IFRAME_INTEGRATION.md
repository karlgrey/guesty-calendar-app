# Webflow iframe Integration Guide

## Problem
iOS Safari blockiert `window.location.href` mailto-Links in iframes aus Sicherheitsgründen.

## Lösung
Das Kalender-iframe sendet jetzt PostMessage-Events an das Parent-Window, das dann den mailto-Link öffnet.

## Integration in Webflow

### 1. iframe Embed Code

Füge das iframe in Webflow ein (HTML Embed Element):

```html
<iframe
  id="booking-calendar"
  src="https://YOUR-CALENDAR-DOMAIN.com"
  style="width: 100%; height: 800px; border: none;"
  allow="top-navigation"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation"
></iframe>
```

**Wichtige Attribute:**
- `allow="top-navigation"` - Erlaubt dem iframe Navigation im Top-Window
- `sandbox="..."` - Sicherheits-Sandbox mit notwendigen Permissions:
  - `allow-scripts` - JavaScript ausführen
  - `allow-same-origin` - Same-origin Policy
  - `allow-forms` - Formulare
  - `allow-popups` - Popups (für mailto)
  - `allow-popups-to-escape-sandbox` - Popups dürfen Sandbox verlassen
  - `allow-top-navigation` - Navigation im Parent erlauben

### 2. PostMessage Event Listener (Custom Code)

Füge diesen Code in Webflow unter **Project Settings → Custom Code → Footer Code** ein:

```html
<script>
// Listen for PostMessage from booking calendar iframe
window.addEventListener('message', function(event) {
  // Security: Only accept messages from your calendar domain
  // In production, replace with your actual domain
  // if (event.origin !== 'https://YOUR-CALENDAR-DOMAIN.com') return;

  console.log('[Webflow] Received PostMessage:', event.data);

  // Handle mailto link requests from iframe
  if (event.data && event.data.type === 'OPEN_MAILTO') {
    console.log('[Webflow] Opening mailto link:', event.data.url);

    // Open mailto link in top window
    // This works because the user gesture is preserved
    window.location.href = event.data.url;
  }
}, false);

console.log('[Webflow] Booking calendar PostMessage listener initialized');
</script>
```

### 3. Alternative: Minimaler Code

Wenn du den Security-Check und Logging nicht brauchst, reicht auch:

```html
<script>
window.addEventListener('message', function(event) {
  if (event.data?.type === 'OPEN_MAILTO') {
    window.location.href = event.data.url;
  }
});
</script>
```

## Wie es funktioniert

### Desktop Browser (Chrome, Safari, Firefox)
1. User klickt "Request to Book"
2. JavaScript erkennt: Nicht in iframe ODER Desktop → Direct `window.location.href`
3. Mail-Client öffnet sich

### iOS Safari in iframe (das Problem)
1. User klickt "Request to Book"
2. JavaScript erkennt: iOS + iframe
3. **Strategie A (PostMessage)**: Sendet Message an Parent Window
   - Parent empfängt Message und öffnet mailto
4. **Strategie B (Fallback)**: Erstellt `<a>` Tag mit `target="_top"` und triggert Click
   - Funktioniert oft auch ohne PostMessage
5. Mail-Client öffnet sich

## Testing

### Desktop
1. Öffne Webflow-Seite mit iframe
2. Öffne Browser Console (F12)
3. Wähle Daten aus und klicke "Request to Book"
4. Console sollte zeigen:
   ```
   [Mailto Debug] { inIframe: true, isiOS: false, ... }
   [Mailto] Attempting PostMessage to parent
   [Webflow] Received PostMessage: { type: 'OPEN_MAILTO', url: '...' }
   [Webflow] Opening mailto link: ...
   ```

### iOS Safari
1. Öffne Webflow-Seite auf iPhone/iPad
2. Wähle Daten und klicke "Request to Book"
3. Mail-App sollte sich öffnen
4. Zum Debugging: Safari → Develop → iPhone → Webflow Site → Console

## Fallback-Strategien

Der Code probiert automatisch in dieser Reihenfolge:

1. **PostMessage** → Parent Window öffnet mailto (beste Lösung)
2. **window.top.location** → Direct top window navigation (Same-Origin)
3. **`<a>` Tag Click** → iOS-spezifischer Workaround
4. **Direct window.location** → Desktop-Fallback

## Sicherheit

**Production**: Aktiviere Origin-Check im Webflow Code:

```javascript
// Nur Messages von deinem Calendar akzeptieren
if (event.origin !== 'https://YOUR-CALENDAR-DOMAIN.com') {
  console.warn('[Security] Rejected message from:', event.origin);
  return;
}
```

## Troubleshooting

### Problem: Mail öffnet sich nicht auf iOS
1. Prüfe Browser Console auf Fehler
2. Stelle sicher iframe hat `sandbox` Attribute
3. Stelle sicher PostMessage Listener ist im Parent Window
4. Teste ohne iframe (direkt auf deiner Calendar-Domain)

### Problem: "Blocked a frame with origin..."
- iframe braucht `sandbox="allow-popups allow-popups-to-escape-sandbox"`

### Problem: PostMessage wird nicht empfangen
- Prüfe ob Custom Code im Footer ist (nicht Header)
- Prüfe Console ob Listener initialisiert wurde
- Teste mit `console.log` im Event Listener

## Support

Bei Problemen:
1. Öffne Browser Console (Desktop: F12, iOS: Safari Develop Menu)
2. Kopiere alle `[Mailto]` und `[Webflow]` Logs
3. Sende Screenshots/Logs an den Support
