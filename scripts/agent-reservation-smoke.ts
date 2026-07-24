/**
 * Echt-Verifikation gegen Guesty: legt eine Hold-Reservierung WEIT in der
 * Zukunft an (Farmhouse, 2 Nächte, 1 € Pauschale), prüft den Status,
 * erzeugt das Angebot und storniert SOFORT wieder.
 *
 * Prüft explizit die Final-Review-Risiken:
 *  - Preis-Rundlauf: spiegelt Guesty den accommodationFare-Override in
 *    money.fareAccommodation? (sonst stille Falschpreise im Angebots-PDF)
 *  - v3-Write → v1-Read-Konsistenz (getReservation direkt nach Anlegen)
 *  - ID-Extraktion und Status-Endpoint (PUT /reservations-v3/{id}/status)
 *
 * Aufruf (lokal, echte Creds in .env):
 *   npx tsx scripts/agent-reservation-smoke.ts
 *
 * Hinweis: verbraucht eine echte Angebotsnummer (A-YYYY-NNNN) — ok, Angebote
 * müssen nicht lückenlos sein (nur Rechnungen).
 */
import { initDatabase } from '../src/db/index.js';
import { createOfferReservation, releaseOfferReservation } from '../src/services/reservation-service.js';
import { guestyClient } from '../src/services/guesty-client.js';

async function main() {
  initDatabase();
  const checkIn = '2027-03-01';
  const checkOut = '2027-03-03';
  // Ziel-GESAMTSUMME inkl. Reinigung — der Service rechnet rückwärts auf den
  // Übernachtungspreis (Reinigung bleibt separater Posten).
  const totalGross = 500;

  console.log('1) Hold anlegen …');
  const result = await createOfferReservation({
    propertySlug: 'farmhouse',
    checkIn,
    checkOut,
    guestsCount: 2,
    guest: { firstName: 'Smoke', lastName: 'Test', email: 'micha+smoketest@remoterepublic.com' },
    totalGross,
  });
  console.log('   →', JSON.stringify(result, null, 2));

  let fare: number | undefined;
  let releasedStatus = '';
  try {
    console.log('2) Status + Preis-Rundlauf prüfen (v1-Read nach v3-Write, mit Retry) …');
    let r: any = null;
    for (let i = 0; i < 6 && !r; i++) {
      r = await guestyClient.getReservation(result.reservationId).catch(() => null);
      if (!r) await new Promise((res) => setTimeout(res, 3000));
    }
    fare = r?.money?.subTotalPrice;
    console.log('   → status:', r?.status, '| fareAccommodation:', r?.money?.fareAccommodation,
      '| fareCleaning:', r?.money?.fareCleaning, '| subTotalPrice:', fare, '| currency:', r?.money?.currency);
  } finally {
    console.log('3) Hold freigeben (expired) …');
    await releaseOfferReservation(result.reservationId);
    // Status-Updates sind asynchron — bis zu 30 s pollen
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      const r2 = await guestyClient.getReservation(result.reservationId).catch(() => null);
      releasedStatus = r2?.status ?? '';
      console.log(`   → status nach Release (Check ${i + 1}):`, releasedStatus);
      if (releasedStatus && releasedStatus !== 'reserved') break;
    }
  }

  const failures: string[] = [];
  if (result.documentError) failures.push(`Angebot fehlgeschlagen: ${result.documentError}`);
  if (fare !== totalGross) failures.push(`Gesamtsumme falsch: subTotalPrice=${fare}, Ziel=${totalGross}`);
  if (releasedStatus !== 'expired') failures.push(`Status nach Release: ${releasedStatus} (erwartet expired)`);

  if (failures.length) {
    console.error('❌ Smoke-Test mit Befunden:\n   - ' + failures.join('\n   - '));
    process.exit(1);
  }
  console.log('✅ Smoke-Test ok — Angebotsnummer', result.documentNumber, '(Hold freigegeben/expired)');
}

main().catch((err) => { console.error('❌', err); process.exit(1); });
