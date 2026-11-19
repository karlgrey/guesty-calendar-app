-- Migration 043: Gast-Gesamtbetrag an Anfragen (#1242)
--
-- Der Entwurfs-Kontext und der Thread-Kopf sollen bei Anfragen den Betrag nennen, den der Gast
-- in Airbnb sieht. total_price und host_payout (Migration 040) bleiben in ihrer Bedeutung
-- unverändert. Befüllt von sync-inquiries.ts (Stunden-Sync UND Einzelabruf, gemeinsamer Mapper
-- mapGuestyInquiryRow) und vom Hostex-Reservierungs-Sync.
--
-- guest_total:  NULL (unbekannt) | Gastbetrag inkl. Steuern laut Plattform (nur bei
--               price_basis = 'guest_total'; Guesty: fareAccommodationAdjusted + fareCleaning +
--               totalTaxes einer Airbnb-Buchung mit voller Aufstellung; Hostex: rates.total_rate)
-- price_basis:  Herkunft der Preiszahlen dieser Zeile
--               'guest_total'   = guest_total ist echt
--               'net_payout'    = einzige Zahl ist die Netto-Auszahlung (Airbnb-Anfrage über
--                                 Guesty); der Gastbetrag wird zur Anzeigezeit mit den Sätzen aus
--                                 properties.json (airbnbGuestPrice) zurückgerechnet
--               'accommodation' = total_price ist der Übernachtungspreis ohne Reinigung/Steuern
--               NULL            = unbekannt (dann wird kein Gastpreis genannt)
-- Upsert: beide Spalten werden nur gemeinsam überschrieben, und nur wenn price_basis bekannt ist.

ALTER TABLE inquiries ADD COLUMN guest_total REAL;
ALTER TABLE inquiries ADD COLUMN price_basis TEXT;
