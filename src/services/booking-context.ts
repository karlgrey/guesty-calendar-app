/**
 * Booking Context (ticket #364)
 *
 * The messaging bot was re-asking guests for arrival/departure dates it
 * already had — draft-service.ts built its prompt from voice + property
 * facts + message texts only, never from the thread's own reservation_id /
 * inquiry_id link. This module turns that link into a short prompt block so
 * the model knows what the platform already knows and stops asking again.
 */
import { getReservationById, getInquiryById } from '../repositories/reservation-repository.js';
import type { MessageThread } from '../types/messages.js';
import { nightsBetween } from '../utils/date.js';

/** ISO/localized date (YYYY-MM-DD…) → German TT.MM.JJJJ. */
function deDate(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Builds a short "what the platform already knows about this booking" block
 * for the draft-generation system prompt. Returns null when the thread isn't
 * linked to a reservation or inquiry (nothing to say).
 */
export function buildBookingContext(thread: MessageThread): string | null {
  if (thread.reservation_id) {
    const res = getReservationById(thread.reservation_id);
    // No early return on a miss: guesty inquiry threads carry the same Guesty
    // id in reservation_id AND inquiry_id, but until the booking is confirmed
    // only an inquiries row exists — fall through to the inquiry lookup below
    // (prod case Ezgi, 10.08.2026).
    if (res) {
      const checkIn = res.check_in_localized ? deDate(res.check_in_localized) : '?';
      const checkOut = res.check_out_localized ? deDate(res.check_out_localized) : '?';
      const status = thread.reservation_status ?? res.status;
      const guests = res.guests_count != null ? `${res.guests_count} Personen` : 'Personenzahl unbekannt';
      const code = res.confirmation_code ?? res.reservation_id;
      const label = status === 'confirmed' ? 'Bestätigte Buchung' : 'Buchung';

      return (
        `${label} (Status: ${status}): Zeitraum ${checkIn}–${checkOut}, ` +
        `${res.nights_count} Nächte, ${guests}, Konfirmationscode ${code}.`
      );
    }
  }

  if (thread.inquiry_id) {
    const inquiry = getInquiryById(thread.inquiry_id);
    if (!inquiry) return null;

    const checkIn = deDate(inquiry.check_in);
    const checkOut = deDate(inquiry.check_out);
    const nights = nightsBetween(inquiry.check_in, inquiry.check_out);
    const guests = inquiry.guests_count != null ? `${inquiry.guests_count} Personen` : 'Personenzahl unbekannt';

    return (
      `Buchungsanfrage (noch nicht bestätigt): Zeitraum ${checkIn}–${checkOut}, ${nights} Nächte, ${guests} ` +
      `— Daten stammen aus der Anfrage selbst.`
    );
  }

  return null;
}
