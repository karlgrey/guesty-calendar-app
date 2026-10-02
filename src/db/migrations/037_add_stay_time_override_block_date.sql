-- Migration 037: Zieltag des Folgetag-Blocks am Zeit-Override (#802, Korrektur zu #799)
--
-- Guestys Vorbereitungszeit ('pt') blockt am Farmhouse nur die Check-out-Nacht. Der Folgetag-Block
-- bei Late-Checkout liegt deshalb auf Check-out + 1. Wird die Reservierung verschoben, ändert sich
-- dieser Zieltag; damit die Rücknahme genau den Tag löst, den WIR geblockt haben, wird er persistiert.
--
-- block_date: NULL (kein Block / Altbestand aus 036) | YYYY-MM-DD des Tages, auf den sich
--             block_state bezieht

ALTER TABLE stay_time_overrides ADD COLUMN block_date TEXT NULL;
