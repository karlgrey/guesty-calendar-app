import { describe, it, expect } from 'vitest';
import { ACTIVE_RESERVATION_STATUSES } from './reservation-repository.js';

// F8(d): Status-Set als exportierte Konstante statt an sechs Stellen im SQL
// dupliziert — sonst driftet eine Stelle irgendwann ab.
describe('ACTIVE_RESERVATION_STATUSES', () => {
  it('enthält genau confirmed und reserved', () => {
    expect(ACTIVE_RESERVATION_STATUSES).toEqual(['confirmed', 'reserved']);
  });
});
