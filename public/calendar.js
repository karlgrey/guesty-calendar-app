/**
 * Calendar UI Component
 * Displays availability calendar and handles date selection
 */

class BookingCalendar {
  constructor(apiBaseUrl = 'http://localhost:3000') {
    this.apiBaseUrl = apiBaseUrl;
    this.currentDate = new Date();
    this.selectedCheckIn = null;
    this.selectedCheckOut = null;
    this.availabilityData = {};
    this.listingData = null;
    this.isMobile = window.innerWidth < 768;
    this.guestCount = 2; // Default guest count
    this.maxGuests = 1; // Will be set from listing data
    this.currentQuote = null; // Store current quote for email

    // Overlay calendar state
    this.overlayCurrentMonth = new Date();
    this.hoverDate = null;
    this.tempCheckIn = null;
    this.tempCheckOut = null;

    // Language detection
    this.language = this.detectLanguage();

    this.init();
  }

  /**
   * Detect browser language (DE or EN)
   * Defaults to DE if detection fails or language is not English
   */
  detectLanguage() {
    const browserLang = navigator.language || navigator.userLanguage;
    // Default to DE, only switch to EN if explicitly English
    return browserLang && browserLang.startsWith('en') ? 'en' : 'de';
  }

  /**
   * Get translated text
   */
  t(key) {
    const translations = {
      de: {
        priceFor: (total, nights) => `${total} für ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}`,
        checkIn: 'Check-in',
        checkOut: 'Check-out',
        guests: 'Gäste',
        reserve: 'Reservieren',
        noCharge: 'Du musst noch nichts bezahlen.',
        pricingDetails: 'Preisdetails',
        hidePricingDetails: 'Preisdetails ausblenden',
        showPricingDetails: 'Preisdetails anzeigen',
        selectDates: 'Reisedaten auswählen',
        resetDates: 'Reisedaten zurücksetzen',
        close: 'Schließen',
        dayHeaders: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
        total: 'Gesamt',
        baseNights: (rate, nights) => `${rate} × ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}`,
        extraGuests: 'Zusätzliche Gäste',
        cleaningFee: 'Endreinigung',
        weeklyDiscount: 'Wochenrabatt',
        monthlyDiscount: 'Monatsrabatt',
        taxes: 'Steuern',
        emptyPricing: 'Wähle Reisedaten, um den Gesamtpreis zu sehen.',
        ariaDecreaseGuests: 'Gästeanzahl verringern',
        ariaIncreaseGuests: 'Gästeanzahl erhöhen',
        ariaNumGuests: 'Anzahl der Gäste',
        ariaPrevMonth: 'Vorheriger Monat',
        ariaNextMonth: 'Nächster Monat',
        ariaClose: 'Schließen',
        addDate: 'Datum hinzufügen',
        maxCapacity: (max) => `Maximale Kapazität ist ${max} ${max === 1 ? 'Gast' : 'Gäste'}`,
        minStay: (nights) => `Mindestaufenthalt ist ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}`,
        datesUnavailable: 'Einige Daten im ausgewählten Bereich sind nicht verfügbar',
        guestsIncluded: (count) => `${count} ${count === 1 ? 'Gast' : 'Gäste'} im Grundpreis enthalten`,
        extraGuestFee: (count, fee) => `${count} zusätzliche${count === 1 ? 'r Gast' : ' Gäste'} (${fee}/Gast)`,
        // Email translations
        emailSubject: (property, checkIn, checkOut, guests) => `[Buchungsanfrage] ${property} – ${checkIn} → ${checkOut}, ${guests} ${guests === 1 ? 'Gast' : 'Gäste'}`,
        emailIntro: (property) => `Ich möchte eine Buchung anfragen für ${property}:\n\n`,
        emailBookingDetails: 'BUCHUNGSDETAILS',
        emailPriceBreakdown: 'PREISAUFSCHLÜSSELUNG',
        emailCheckIn: 'Check-in',
        emailCheckOut: 'Check-out',
        emailNights: (nights) => `${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}`,
        emailGuests: (guests) => `${guests} ${guests === 1 ? 'Gast' : 'Gäste'}`,
        emailAccommodation: 'Unterkunft',
        emailSubtotal: 'Zwischensumme',
        emailTaxes: 'Steuern',
        emailTotalTaxes: 'Steuern gesamt',
        emailTotalPrice: 'GESAMTPREIS',
        emailProperty: 'Unterkunft',
        emailConfirmRequest: 'Bitte bestätigen Sie die Verfügbarkeit und senden Sie die Buchungsdetails.\n\nVielen Dank!',
        nights: (nights) => `${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}`
      },
      en: {
        priceFor: (total, nights) => `${total} for ${nights} ${nights === 1 ? 'night' : 'nights'}`,
        checkIn: 'Check-in',
        checkOut: 'Check-out',
        guests: 'Guests',
        reserve: 'Request to Book',
        noCharge: 'You won\'t be charged yet.',
        pricingDetails: 'Pricing details',
        hidePricingDetails: 'Hide pricing details',
        showPricingDetails: 'Show pricing details',
        selectDates: 'Select Dates',
        resetDates: 'Reset dates',
        close: 'Close',
        dayHeaders: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        total: 'Total',
        baseNights: (rate, nights) => `${rate} × ${nights} ${nights === 1 ? 'night' : 'nights'}`,
        extraGuests: 'Extra guests',
        cleaningFee: 'Cleaning fee',
        weeklyDiscount: 'Weekly discount',
        monthlyDiscount: 'Monthly discount',
        taxes: 'Taxes',
        emptyPricing: 'Select dates to see the total price.',
        ariaDecreaseGuests: 'Decrease guests',
        ariaIncreaseGuests: 'Increase guests',
        ariaNumGuests: 'Number of guests',
        ariaPrevMonth: 'Previous month',
        ariaNextMonth: 'Next month',
        ariaClose: 'Close',
        addDate: 'Add date',
        maxCapacity: (max) => `Maximum capacity is ${max} ${max === 1 ? 'guest' : 'guests'}`,
        minStay: (nights) => `Minimum stay is ${nights} ${nights === 1 ? 'night' : 'nights'}`,
        datesUnavailable: 'Some dates in the selected range are not available',
        guestsIncluded: (count) => `${count} ${count === 1 ? 'guest' : 'guests'} included in base price`,
        extraGuestFee: (count, fee) => `${count} extra ${count === 1 ? 'guest' : 'guests'} (${fee}/guest)`,
        // Email translations
        emailSubject: (property, checkIn, checkOut, guests) => `[Booking Request] ${property} – ${checkIn} → ${checkOut}, ${guests} ${guests === 1 ? 'guest' : 'guests'}`,
        emailIntro: (property) => `I would like to request a booking for ${property}:\n\n`,
        emailBookingDetails: 'BOOKING DETAILS',
        emailPriceBreakdown: 'PRICE BREAKDOWN',
        emailCheckIn: 'Check-in',
        emailCheckOut: 'Check-out',
        emailNights: (nights) => `${nights} ${nights === 1 ? 'night' : 'nights'}`,
        emailGuests: (guests) => `${guests} ${guests === 1 ? 'guest' : 'guests'}`,
        emailAccommodation: 'Accommodation',
        emailSubtotal: 'Subtotal',
        emailTaxes: 'Taxes',
        emailTotalTaxes: 'Total Taxes',
        emailTotalPrice: 'TOTAL PRICE',
        emailProperty: 'Property',
        emailConfirmRequest: 'Please confirm availability and send booking details.\n\nThank you!',
        nights: (nights) => `${nights} ${nights === 1 ? 'night' : 'nights'}`
      }
    };

    return translations[this.language][key];
  }

  /**
   * Get week start day (0 = Sunday, 1 = Monday)
   */
  getWeekStart() {
    return this.language === 'de' ? 1 : 0; // Monday for DE, Sunday for EN
  }

  async init() {
    // Fetch listing data
    await this.fetchListingData();

    // Initialize guest selector
    this.initGuestSelector();

    // Fetch availability for current and next month
    await this.fetchAvailability();

    // Auto-select dates (first available + minNights)
    this.autoSelectDates();

    // Render calendar
    this.render();

    // Set up event listeners
    this.setupEventListeners();

    // Update header with auto-selected dates
    await this.updateHeaderInfo();

    // Update labels with translations
    this.updateLabels();
  }

  /**
   * Update UI labels with translations
   */
  updateLabels() {
    // Labels
    const labelCheckIn = document.getElementById('label-checkin');
    const labelCheckOut = document.getElementById('label-checkout');
    const labelGuests = document.getElementById('label-guests');
    const headerCta = document.getElementById('header-cta');
    const headerHelper = document.getElementById('header-helper');
    const pricingTitle = document.getElementById('pricing-title');
    const calendarTitle = document.getElementById('calendar-title');
    const resetDatesBtn = document.getElementById('reset-dates-btn');
    const closeCalendarBtn = document.getElementById('close-calendar-btn');

    if (labelCheckIn) labelCheckIn.textContent = this.t('checkIn');
    if (labelCheckOut) labelCheckOut.textContent = this.t('checkOut');
    if (labelGuests) labelGuests.textContent = this.t('guests');
    if (headerCta) {
      headerCta.textContent = this.t('reserve');
      // Enable/disable CTA based on whether we have a valid quote
      this.updateCtaState();
    }
    if (headerHelper) headerHelper.textContent = this.t('noCharge');
    if (pricingTitle) pricingTitle.textContent = this.t('pricingDetails');
    if (calendarTitle) calendarTitle.textContent = this.t('selectDates');
    if (resetDatesBtn) resetDatesBtn.textContent = this.t('resetDates');
    if (closeCalendarBtn) closeCalendarBtn.textContent = this.t('close');

    // Aria labels
    const checkInInput = document.getElementById('check-in-input');
    const checkOutInput = document.getElementById('check-out-input');
    const guestCountInput = document.getElementById('guest-count');
    const guestDecrement = document.getElementById('guest-decrement');
    const guestIncrement = document.getElementById('guest-increment');
    const prevMonthOverlay = document.getElementById('prev-month-overlay');
    const nextMonthOverlay = document.getElementById('next-month-overlay');
    const pricingCloseBtn = document.getElementById('pricing-close-btn');
    const calendarCloseBtn = document.getElementById('calendar-close-btn');

    if (checkInInput) {
      checkInInput.setAttribute('aria-label', this.t('checkIn'));
      checkInInput.setAttribute('placeholder', this.t('addDate'));
    }
    if (checkOutInput) {
      checkOutInput.setAttribute('aria-label', this.t('checkOut'));
      checkOutInput.setAttribute('placeholder', this.t('addDate'));
    }
    if (guestCountInput) guestCountInput.setAttribute('aria-label', this.t('ariaNumGuests'));
    if (guestDecrement) guestDecrement.setAttribute('aria-label', this.t('ariaDecreaseGuests'));
    if (guestIncrement) guestIncrement.setAttribute('aria-label', this.t('ariaIncreaseGuests'));
    if (prevMonthOverlay) prevMonthOverlay.setAttribute('aria-label', this.t('ariaPrevMonth'));
    if (nextMonthOverlay) nextMonthOverlay.setAttribute('aria-label', this.t('ariaNextMonth'));
    if (pricingCloseBtn) pricingCloseBtn.setAttribute('aria-label', this.t('ariaClose'));
    if (calendarCloseBtn) calendarCloseBtn.setAttribute('aria-label', this.t('ariaClose'));
  }

  /**
   * Update CTA button state (enabled/disabled)
   */
  updateCtaState() {
    const headerCta = document.getElementById('header-cta');
    if (!headerCta) return;

    // Enable CTA only if we have valid dates and a quote
    const isValid = this.selectedCheckIn && this.selectedCheckOut && this.currentQuote;
    headerCta.disabled = !isValid;
  }

  /**
   * Auto-select first available date + minNights
   */
  autoSelectDates() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find first available date
    const sortedDates = Object.keys(this.availabilityData).sort();

    for (const dateStr of sortedDates) {
      const date = new Date(dateStr + 'T00:00:00');
      const availability = this.availabilityData[dateStr];

      // Skip past dates and unavailable dates
      if (date < today) continue;
      if (!availability || availability.status !== 'available') continue;

      // Found first available date
      this.selectedCheckIn = date;
      const minNights = availability.minNights || 1;

      // Calculate checkOut date
      const checkOutDate = new Date(date);
      checkOutDate.setDate(checkOutDate.getDate() + minNights);
      this.selectedCheckOut = checkOutDate;

      break;
    }
  }

  /**
   * Fetch listing information
   */
  async fetchListingData() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/listing`);
      if (!response.ok) throw new Error('Failed to fetch listing');
      this.listingData = await response.json();
      this.maxGuests = this.listingData.accommodates || 1;
    } catch (error) {
      console.error('Error fetching listing:', error);
      this.showError('Failed to load property information');
    }
  }

  /**
   * Initialize guest selector UI and constraints
   */
  initGuestSelector() {
    const guestInput = document.getElementById('guest-count');
    const helperText = document.getElementById('guest-helper');

    if (guestInput) {
      guestInput.value = this.guestCount;
      guestInput.max = this.maxGuests;
    }

    if (helperText) {
      helperText.textContent = `Maximum ${this.maxGuests} guest${this.maxGuests > 1 ? 's' : ''}`;
      helperText.className = 'guest-helper info';
    }

    this.updateGuestButtons();
  }

  /**
   * Fetch availability data for a date range
   */
  async fetchAvailability() {
    const startDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth(), 1);
    const endDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + 3, 0);

    const from = this.formatDate(startDate);
    const to = this.formatDate(endDate);

    try {
      const response = await fetch(`${this.apiBaseUrl}/availability?from=${from}&to=${to}`);
      if (!response.ok) throw new Error('Failed to fetch availability');

      const data = await response.json();

      // Build lookup map
      this.availabilityData = {};
      data.days.forEach(day => {
        this.availabilityData[day.date] = day;
      });
    } catch (error) {
      console.error('Error fetching availability:', error);
      this.showError('Failed to load availability data');
    }
  }

  /**
   * Format date as YYYY-MM-DD
   */
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get number of months to display (1 for mobile, 2 for desktop)
   */
  getMonthsToDisplay() {
    return this.isMobile ? 1 : 2;
  }

  /**
   * Generate calendar HTML
   */
  render() {
    const wrapper = document.getElementById('calendar-wrapper');
    if (!wrapper) return;

    const monthsToDisplay = this.getMonthsToDisplay();
    let html = '';

    for (let i = 0; i < monthsToDisplay; i++) {
      const monthDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + i, 1);
      html += this.renderMonth(monthDate);
    }

    wrapper.innerHTML = html;
  }

  /**
   * Render a single month
   */
  renderMonth(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const monthName = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startingDayOfWeek = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    let html = `
      <div class="calendar-month">
        <h3 class="month-title">${monthName}</h3>
        <div class="calendar-grid">
    `;

    // Day headers
    const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayHeaders.forEach(day => {
      html += `<div class="calendar-day-header">${day}</div>`;
    });

    // Empty cells before first day
    for (let i = 0; i < startingDayOfWeek; i++) {
      html += `<div class="calendar-day empty"></div>`;
    }

    // Days
    for (let day = 1; day <= daysInMonth; day++) {
      const currentDate = new Date(year, month, day);
      const dateStr = this.formatDate(currentDate);
      html += this.renderDay(dateStr, day, currentDate);
    }

    html += `</div></div>`;
    return html;
  }

  /**
   * Render a single day cell
   */
  renderDay(dateStr, dayNumber, date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isPast = date < today;

    const availability = this.availabilityData[dateStr];

    let classes = ['calendar-day'];
    let disabled = false;
    let price = '';

    if (isPast) {
      classes.push('past');
      disabled = true;
    } else if (!availability || availability.status !== 'available') {
      classes.push(availability?.status === 'booked' ? 'booked' : 'blocked');
      disabled = true;
    } else {
      // Check if selected
      if (this.selectedCheckIn && dateStr === this.formatDate(this.selectedCheckIn)) {
        classes.push('selected');
      } else if (this.selectedCheckOut && dateStr === this.formatDate(this.selectedCheckOut)) {
        classes.push('selected');
      } else if (this.isInRange(date)) {
        classes.push('in-range');
      }

      // Show price
      if (availability.price) {
        const currency = this.listingData?.currency || 'EUR';
        price = `<div class="price">${this.formatCurrency(availability.price, currency)}</div>`;
      }
    }

    const disabledAttr = disabled ? 'data-disabled="true"' : '';

    return `
      <div class="calendar-day ${classes.join(' ')}"
           data-date="${dateStr}"
           ${disabledAttr}>
        <div class="day-number">${dayNumber}</div>
        ${price}
      </div>
    `;
  }

  /**
   * Check if date is in selected range
   */
  isInRange(date) {
    if (!this.selectedCheckIn || !this.selectedCheckOut) return false;
    return date > this.selectedCheckIn && date < this.selectedCheckOut;
  }

  /**
   * Format currency with locale support
   */
  formatCurrency(amount, currency) {
    const locale = this.language === 'de' ? 'de-DE' : 'en-US';
    const currencyCode = currency || 'EUR';

    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).format(amount);
    } catch (error) {
      // Fallback if Intl fails
      const symbol = currencyCode === 'EUR' ? '€' : currencyCode === 'USD' ? '$' : currencyCode;
      return `${symbol}${Math.round(amount)}`;
    }
  }

  /**
   * Set up event listeners
   */
  setupEventListeners() {
    // Calendar navigation
    const prevBtn = document.getElementById('prev-month');
    const nextBtn = document.getElementById('next-month');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.previousMonth());
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.nextMonth());
    }

    // Day selection (event delegation)
    const wrapper = document.getElementById('calendar-wrapper');
    if (wrapper) {
      wrapper.addEventListener('click', (e) => {
        const dayEl = e.target.closest('.calendar-day');
        if (dayEl && !dayEl.dataset.disabled) {
          this.handleDayClick(dayEl.dataset.date);
        }
      });
    }

    // Guest selector buttons
    const guestDecrement = document.getElementById('guest-decrement');
    const guestIncrement = document.getElementById('guest-increment');

    if (guestDecrement) {
      guestDecrement.addEventListener('click', () => this.decrementGuests());
    }

    if (guestIncrement) {
      guestIncrement.addEventListener('click', () => this.incrementGuests());
    }

    // Responsive handling
    window.addEventListener('resize', () => {
      const wasMobile = this.isMobile;
      this.isMobile = window.innerWidth < 768;

      if (wasMobile !== this.isMobile) {
        this.render();
      }
    });
  }

  /**
   * Increment guest count
   */
  incrementGuests() {
    if (this.guestCount < this.maxGuests) {
      this.guestCount++;
      this.updateGuestUI();
      this.updateHeaderInfo();
      this.updateSelectionInfo();
    } else {
      this.showGuestHelper(this.t('maxCapacity')(this.maxGuests), 'error');
    }
  }

  /**
   * Decrement guest count
   */
  decrementGuests() {
    if (this.guestCount > 1) {
      this.guestCount--;
      this.updateGuestUI();
      this.updateHeaderInfo();
      this.updateSelectionInfo();
    }
  }

  /**
   * Update guest selector UI
   */
  updateGuestUI() {
    const guestInput = document.getElementById('guest-count');
    if (guestInput) {
      guestInput.value = this.guestCount;
    }

    this.updateGuestButtons();

    // Show info about included guests if applicable
    if (this.listingData?.pricing?.guestsIncluded) {
      const included = this.listingData.pricing.guestsIncluded;
      if (this.guestCount > included) {
        const extraGuests = this.guestCount - included;
        const fee = this.listingData.pricing.extraPersonFee || 0;
        this.showGuestHelper(
          this.t('extraGuestFee')(extraGuests, this.formatCurrency(fee, this.listingData.currency)),
          'warning'
        );
      } else {
        this.showGuestHelper(this.t('guestsIncluded')(this.guestCount), 'info');
      }
    }
  }

  /**
   * Update guest button states (enable/disable)
   */
  updateGuestButtons() {
    const decrementBtn = document.getElementById('guest-decrement');
    const incrementBtn = document.getElementById('guest-increment');

    if (decrementBtn) {
      decrementBtn.disabled = this.guestCount <= 1;
    }

    if (incrementBtn) {
      incrementBtn.disabled = this.guestCount >= this.maxGuests;
    }
  }

  /**
   * Show guest helper text
   */
  showGuestHelper(message, type = 'info') {
    const helperEl = document.getElementById('guest-helper');
    if (helperEl) {
      helperEl.textContent = message;
      helperEl.className = `guest-helper ${type}`;
    }
  }

  /**
   * Handle day click
   */
  handleDayClick(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');

    // If no check-in selected, or if clicking before check-in, set as check-in
    if (!this.selectedCheckIn || (this.selectedCheckIn && date < this.selectedCheckIn)) {
      this.selectedCheckIn = date;
      this.selectedCheckOut = null;
    }
    // If check-in selected but no check-out, set as check-out
    else if (this.selectedCheckIn && !this.selectedCheckOut && date > this.selectedCheckIn) {
      // Validate min-stay
      const availability = this.availabilityData[this.formatDate(this.selectedCheckIn)];
      const minNights = availability?.minNights || 1;

      const daysDiff = Math.ceil((date - this.selectedCheckIn) / (1000 * 60 * 60 * 24));

      if (daysDiff < minNights) {
        this.showError(this.t('minStay')(minNights));
        return;
      }

      // Check if all dates in range are available
      if (!this.validateDateRange(this.selectedCheckIn, date)) {
        this.showError(this.t('datesUnavailable'));
        return;
      }

      this.selectedCheckOut = date;
    }
    // If both selected, start over
    else {
      this.selectedCheckIn = date;
      this.selectedCheckOut = null;
    }

    this.clearError();
    this.render();
    this.updateHeaderInfo();
    this.updateSelectionInfo();
  }

  /**
   * Validate that all dates in range are available
   */
  validateDateRange(startDate, endDate) {
    const current = new Date(startDate);

    while (current < endDate) {
      const dateStr = this.formatDate(current);
      const availability = this.availabilityData[dateStr];

      if (!availability || availability.status !== 'available') {
        return false;
      }

      current.setDate(current.getDate() + 1);
    }

    return true;
  }

  /**
   * Update header info with price and dates
   */
  async updateHeaderInfo() {
    if (!this.selectedCheckIn || !this.selectedCheckOut) return;

    const checkIn = this.formatDate(this.selectedCheckIn);
    const checkOut = this.formatDate(this.selectedCheckOut);
    const guests = this.guestCount;

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/quote?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error.message);
      }

      const data = await response.json();
      const quote = data.quote;

      // Store quote for email
      this.currentQuote = quote;

      // Update header price
      const priceEl = document.getElementById('header-price');
      if (priceEl) {
        const totalPrice = this.formatCurrency(quote.pricing.totalPrice, quote.currency);
        priceEl.textContent = this.t('priceFor')(totalPrice, quote.nights);
      }

      // Update date inputs
      const checkInInput = document.getElementById('check-in-input');
      const checkOutInput = document.getElementById('check-out-input');
      if (checkInInput) {
        checkInInput.value = this.formatDateShort(this.selectedCheckIn);
      }
      if (checkOutInput) {
        checkOutInput.value = this.formatDateShort(this.selectedCheckOut);
      }

      // Update CTA state
      this.updateCtaState();

    } catch (error) {
      console.error('Error fetching quote:', error);
      this.showError(error.message);
      this.currentQuote = null;
      this.updateCtaState();
    }
  }

  /**
   * Format date for input display (e.g., "Mar 15")
   */
  formatDateShort(date) {
    const options = { month: 'short', day: 'numeric' };
    return date.toLocaleDateString(this.language === 'de' ? 'de-DE' : 'en-US', options);
  }

  /**
   * Update selection info display
   */
  async updateSelectionInfo() {
    const infoEl = document.getElementById('selection-info');
    if (!infoEl) return;

    if (!this.selectedCheckIn) {
      infoEl.innerHTML = `
        <p style="text-align: center; color: #6b7280;">Select your check-in date to get started</p>
        <button class="cta-button" disabled>${this.t('reserve')}</button>
      `;
      return;
    }

    if (!this.selectedCheckOut) {
      infoEl.innerHTML = `
        <p style="text-align: center; color: #6b7280;">Select your check-out date</p>
        <button class="cta-button" disabled>${this.t('reserve')}</button>
      `;
      return;
    }

    // Fetch quote
    const checkIn = this.formatDate(this.selectedCheckIn);
    const checkOut = this.formatDate(this.selectedCheckOut);
    const guests = this.guestCount;

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/quote?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error.message);
      }

      const data = await response.json();
      const quote = data.quote;

      // Store quote for email
      this.currentQuote = quote;

      // Build pricing breakdown
      let breakdownHtml = '';

      // Accommodation fare
      breakdownHtml += `
        <div class="breakdown-row">
          <span class="breakdown-label">${this.formatCurrency(quote.breakdown.nightlyRates[0]?.adjustedPrice || 0, quote.currency)} × ${quote.nights} night${quote.nights > 1 ? 's' : ''}</span>
          <span class="breakdown-value">${this.formatCurrency(quote.pricing.accommodationFare, quote.currency)}</span>
        </div>
      `;

      // Discount (if applicable)
      if (quote.discount) {
        breakdownHtml += `
          <div class="breakdown-row discount">
            <span class="breakdown-label">${quote.discount.type === 'weekly' ? 'Weekly' : 'Monthly'} discount</span>
            <span class="breakdown-value">-${this.formatCurrency(quote.discount.savings, quote.currency)}</span>
          </div>
        `;
      }

      // Cleaning fee
      if (quote.pricing.cleaningFee > 0) {
        breakdownHtml += `
          <div class="breakdown-row">
            <span class="breakdown-label">Cleaning fee</span>
            <span class="breakdown-value">${this.formatCurrency(quote.pricing.cleaningFee, quote.currency)}</span>
          </div>
        `;
      }

      // Extra guest fee
      if (quote.pricing.extraGuestFee > 0) {
        breakdownHtml += `
          <div class="breakdown-row">
            <span class="breakdown-label">Extra guest fee</span>
            <span class="breakdown-value">${this.formatCurrency(quote.pricing.extraGuestFee, quote.currency)}</span>
          </div>
        `;
      }

      // Taxes
      if (quote.breakdown.taxes && quote.breakdown.taxes.length > 0) {
        quote.breakdown.taxes.forEach(tax => {
          breakdownHtml += `
            <div class="breakdown-row">
              <span class="breakdown-label">${tax.description}</span>
              <span class="breakdown-value">${this.formatCurrency(tax.amount, quote.currency)}</span>
            </div>
          `;
        });
      }

      let html = `
        <h3>Booking Summary</h3>
        <div class="selection-details">
          <div class="selection-row">
            <span class="selection-label">Check-in</span>
            <span class="selection-value">${new Date(checkIn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          </div>
          <div class="selection-row">
            <span class="selection-label">Check-out</span>
            <span class="selection-value">${new Date(checkOut).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          </div>
          <div class="selection-row">
            <span class="selection-label">Nights</span>
            <span class="selection-value">${quote.nights}</span>
          </div>
          <div class="selection-row">
            <span class="selection-label">Guests</span>
            <span class="selection-value">${guests}</span>
          </div>
          <div class="selection-row" style="border-top: 2px solid #e5e7eb; margin-top: 1rem; padding-top: 1rem;">
            <span class="selection-label">Total Price (incl. cleaning)</span>
            <span class="selection-value total-price">${this.formatCurrency(quote.pricing.totalPrice, quote.currency)}</span>
          </div>
        </div>

        <div class="pricing-breakdown">
          <button class="breakdown-toggle" onclick="calendar.toggleBreakdown()">
            <span id="breakdown-toggle-text">Show pricing details</span>
            <span id="breakdown-toggle-icon">▼</span>
          </button>
          <div id="breakdown-content" class="breakdown-content" style="display: none;">
            ${breakdownHtml}
          </div>
        </div>

        <button class="cta-button" onclick="calendar.requestBooking()">Request to Book</button>
      `;

      infoEl.innerHTML = html;
    } catch (error) {
      console.error('Error fetching quote:', error);
      this.showError(error.message);
    }
  }

  /**
   * Navigate to previous month
   */
  async previousMonth() {
    const today = new Date();
    const firstOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const targetMonth = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() - 1, 1);

    // Don't allow going to past months
    if (targetMonth < firstOfCurrentMonth) {
      return;
    }

    this.currentDate = targetMonth;
    await this.fetchAvailability();
    this.render();
    this.updateNavigationButtons();
  }

  /**
   * Navigate to next month
   */
  async nextMonth() {
    this.currentDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + 1, 1);
    await this.fetchAvailability();
    this.render();
    this.updateNavigationButtons();
  }

  /**
   * Update navigation button states
   */
  updateNavigationButtons() {
    const prevBtn = document.getElementById('prev-month');
    const today = new Date();
    const firstOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    if (prevBtn) {
      prevBtn.disabled = this.currentDate <= firstOfCurrentMonth;
    }
  }

  /**
   * Show error message
   */
  showError(message) {
    const errorEl = document.getElementById('error-message');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }

  /**
   * Clear error message
   */
  clearError() {
    const errorEl = document.getElementById('error-message');
    if (errorEl) {
      errorEl.style.display = 'none';
    }
  }

  /**
   * Toggle pricing breakdown visibility
   */
  toggleBreakdown() {
    const content = document.getElementById('breakdown-content');
    const toggleText = document.getElementById('breakdown-toggle-text');
    const toggleIcon = document.getElementById('breakdown-toggle-icon');

    if (content && toggleText && toggleIcon) {
      const isVisible = content.style.display !== 'none';
      content.style.display = isVisible ? 'none' : 'block';
      toggleText.textContent = isVisible ? 'Show pricing details' : 'Hide pricing details';
      toggleIcon.textContent = isVisible ? '▼' : '▲';
    }
  }

  /**
   * Toggle pricing details overlay
   */
  togglePricingOverlay() {
    const overlay = document.getElementById('pricing-overlay');
    if (!overlay) return;

    if (overlay.style.display === 'none') {
      this.showPricingOverlay();
    } else {
      this.closePricingOverlay();
    }
  }

  /**
   * Show pricing details overlay
   */
  showPricingOverlay() {
    const overlay = document.getElementById('pricing-overlay');
    const breakdownEl = document.getElementById('pricing-breakdown');
    if (!overlay || !breakdownEl) return;

    // Store currently focused element to restore later
    this.previouslyFocusedElementPricing = document.activeElement;

    // Empty state if no quote
    if (!this.currentQuote) {
      breakdownEl.innerHTML = `
        <div class="pricing-empty-state">
          <p>${this.t('emptyPricing')}</p>
        </div>
      `;
      overlay.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      this.addPricingOverlayEscapeHandler();

      // Set focus to close button
      setTimeout(() => {
        const closeButton = document.getElementById('pricing-close-btn');
        if (closeButton) {
          closeButton.focus();
        }
      }, 50);

      // Add focus trap
      this.trapFocusPricing(overlay);
      return;
    }

    const quote = this.currentQuote;
    let breakdownHtml = '';

    // 1. Base nights
    const nightlyRate = quote.breakdown.nightlyRates[0]?.adjustedPrice || 0;
    breakdownHtml += `
      <div class="breakdown-row">
        <span class="breakdown-label">${this.t('baseNights')(this.formatCurrency(nightlyRate, quote.currency), quote.nights)}</span>
        <span class="breakdown-value">${this.formatCurrency(quote.pricing.accommodationFare, quote.currency)}</span>
      </div>
    `;

    // 2. Discounts (with percentage if available)
    if (quote.discount) {
      const discountLabel = quote.discount.type === 'weekly'
        ? this.t('weeklyDiscount')
        : this.t('monthlyDiscount');

      // Calculate percentage
      const percentage = this.listingData?.pricing?.weeklyDiscount ||
                        this.listingData?.pricing?.monthlyDiscount || 0;
      const percentageStr = percentage > 0 ? ` −${Math.round(percentage)}%` : '';

      breakdownHtml += `
        <div class="breakdown-row discount">
          <span class="breakdown-label">${discountLabel}${percentageStr}</span>
          <span class="breakdown-value">−${this.formatCurrency(quote.discount.savings, quote.currency)}</span>
        </div>
      `;
    }

    // 3. Cleaning (once per stay)
    if (quote.pricing.cleaningFee > 0) {
      breakdownHtml += `
        <div class="breakdown-row">
          <span class="breakdown-label">${this.t('cleaningFee')}</span>
          <span class="breakdown-value">${this.formatCurrency(quote.pricing.cleaningFee, quote.currency)}</span>
        </div>
      `;
    }

    // 4. Extra guests
    if (quote.pricing.extraGuestFee > 0) {
      breakdownHtml += `
        <div class="breakdown-row">
          <span class="breakdown-label">${this.t('extraGuests')}</span>
          <span class="breakdown-value">${this.formatCurrency(quote.pricing.extraGuestFee, quote.currency)}</span>
        </div>
      `;
    }

    // 5. Taxes
    if (quote.breakdown.taxes && quote.breakdown.taxes.length > 0) {
      quote.breakdown.taxes.forEach(tax => {
        breakdownHtml += `
          <div class="breakdown-row">
            <span class="breakdown-label">${tax.description}</span>
            <span class="breakdown-value">${this.formatCurrency(tax.amount, quote.currency)}</span>
          </div>
        `;
      });
    }

    // 6. Total at the bottom
    breakdownHtml += `
      <div class="breakdown-row total">
        <span class="breakdown-label">${this.t('total')}</span>
        <span class="breakdown-value">${this.formatCurrency(quote.pricing.totalPrice, quote.currency)}</span>
      </div>
    `;

    breakdownEl.innerHTML = breakdownHtml;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    this.addPricingOverlayEscapeHandler();

    // Set focus to close button
    setTimeout(() => {
      const closeButton = document.getElementById('pricing-close-btn');
      if (closeButton) {
        closeButton.focus();
      }
    }, 50);

    // Add focus trap
    this.trapFocusPricing(overlay);
  }

  /**
   * Add ESC key handler for pricing overlay
   */
  addPricingOverlayEscapeHandler() {
    this.pricingEscapeHandler = (event) => {
      if (event.key === 'Escape') {
        this.closePricingOverlay();
      }
    };
    document.addEventListener('keydown', this.pricingEscapeHandler);
  }

  /**
   * Close pricing overlay
   */
  closePricingOverlay(event) {
    // If event is passed, only close when clicking the overlay background
    if (event && event.target.id !== 'pricing-overlay') return;

    const overlay = document.getElementById('pricing-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      document.body.style.overflow = '';

      // Remove ESC key handler
      if (this.pricingEscapeHandler) {
        document.removeEventListener('keydown', this.pricingEscapeHandler);
        this.pricingEscapeHandler = null;
      }

      // Remove focus trap handler
      if (this.focusTrapHandlerPricing) {
        overlay.removeEventListener('keydown', this.focusTrapHandlerPricing);
        this.focusTrapHandlerPricing = null;
      }

      // Restore focus to previously focused element
      if (this.previouslyFocusedElementPricing) {
        this.previouslyFocusedElementPricing.focus();
        this.previouslyFocusedElementPricing = null;
      }
    }
  }

  /**
   * Open datepicker overlay with focus trap
   */
  openDatepicker() {
    // Set overlay month to current selected check-in or current month
    if (this.selectedCheckIn) {
      this.overlayCurrentMonth = new Date(this.selectedCheckIn);
    } else {
      this.overlayCurrentMonth = new Date();
    }

    // Store current selection as temp
    this.tempCheckIn = this.selectedCheckIn;
    this.tempCheckOut = this.selectedCheckOut;

    // Store currently focused element to restore later
    this.previouslyFocusedElement = document.activeElement;

    // Render calendar in overlay
    this.renderOverlayCalendar();

    // Show overlay
    const overlay = document.getElementById('calendar-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      document.body.style.overflow = 'hidden';

      // Add keyboard listeners for ESC and arrow keys
      document.addEventListener('keydown', this.handleEscapeKey);
      document.addEventListener('keydown', this.handleCalendarKeyboard);

      // Set focus to close button for accessibility
      setTimeout(() => {
        const closeButton = document.getElementById('calendar-close-btn');
        if (closeButton) {
          closeButton.focus();
        }
      }, 50);

      // Add focus trap
      this.trapFocus(overlay);
    }
  }

  /**
   * Close datepicker overlay
   */
  closeDatepicker() {
    const overlay = document.getElementById('calendar-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      document.body.style.overflow = '';

      // Remove keyboard listeners
      document.removeEventListener('keydown', this.handleEscapeKey);
      document.removeEventListener('keydown', this.handleCalendarKeyboard);

      // Remove focus trap handler
      if (this.focusTrapHandler) {
        overlay.removeEventListener('keydown', this.focusTrapHandler);
        this.focusTrapHandler = null;
      }

      // Restore focus to previously focused element
      if (this.previouslyFocusedElement) {
        this.previouslyFocusedElement.focus();
        this.previouslyFocusedElement = null;
      }

      // Apply temp selection
      if (this.tempCheckIn && this.tempCheckOut) {
        this.selectedCheckIn = this.tempCheckIn;
        this.selectedCheckOut = this.tempCheckOut;
        this.updateHeaderInfo();
      }
    }
  }

  /**
   * Handle click on overlay background (close on click outside)
   */
  handleOverlayClick(event) {
    if (event.target.id === 'calendar-overlay') {
      this.closeDatepicker();
    }
  }

  /**
   * Handle ESC key press
   */
  handleEscapeKey = (event) => {
    if (event.key === 'Escape') {
      this.closeDatepicker();
    }
  }

  /**
   * Trap focus within overlay for accessibility
   */
  trapFocus(container) {
    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    this.focusTrapHandler = (e) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        // Shift+Tab: if on first element, wrap to last
        if (document.activeElement === firstFocusable) {
          lastFocusable.focus();
          e.preventDefault();
        }
      } else {
        // Tab: if on last element, wrap to first
        if (document.activeElement === lastFocusable) {
          firstFocusable.focus();
          e.preventDefault();
        }
      }
    };

    container.addEventListener('keydown', this.focusTrapHandler);
  }

  /**
   * Trap focus within pricing overlay for accessibility
   */
  trapFocusPricing(container) {
    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    this.focusTrapHandlerPricing = (e) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        // Shift+Tab: if on first element, wrap to last
        if (document.activeElement === firstFocusable) {
          lastFocusable.focus();
          e.preventDefault();
        }
      } else {
        // Tab: if on last element, wrap to first
        if (document.activeElement === lastFocusable) {
          firstFocusable.focus();
          e.preventDefault();
        }
      }
    };

    container.addEventListener('keydown', this.focusTrapHandlerPricing);
  }

  /**
   * Handle keyboard navigation in calendar
   */
  handleCalendarKeyboard = (event) => {
    // Only handle arrow keys, Enter, and Space
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
      return;
    }

    // Find currently focused day element
    const focusedDay = document.activeElement;
    if (!focusedDay || !focusedDay.classList.contains('calendar-day-overlay')) {
      return;
    }

    event.preventDefault();

    const currentDateStr = focusedDay.getAttribute('data-date');
    if (!currentDateStr) return;

    // Handle Enter/Space to select date
    if (event.key === 'Enter' || event.key === ' ') {
      if (!focusedDay.hasAttribute('data-disabled')) {
        this.handleDayClickOverlay(currentDateStr);
      }
      return;
    }

    // Handle arrow key navigation
    const currentDate = new Date(currentDateStr + 'T00:00:00');
    let newDate;

    switch (event.key) {
      case 'ArrowLeft':
        newDate = new Date(currentDate);
        newDate.setDate(newDate.getDate() - 1);
        break;
      case 'ArrowRight':
        newDate = new Date(currentDate);
        newDate.setDate(newDate.getDate() + 1);
        break;
      case 'ArrowUp':
        newDate = new Date(currentDate);
        newDate.setDate(newDate.getDate() - 7);
        break;
      case 'ArrowDown':
        newDate = new Date(currentDate);
        newDate.setDate(newDate.getDate() + 7);
        break;
    }

    if (newDate) {
      const newDateStr = this.formatDate(newDate);

      // Check if new date is in visible months, if not, navigate months
      const newMonth = newDate.getMonth();
      const newYear = newDate.getFullYear();
      const currentOverlayMonth = this.overlayCurrentMonth.getMonth();
      const currentOverlayYear = this.overlayCurrentMonth.getFullYear();
      const nextMonth = (currentOverlayMonth + 1) % 12;
      const nextYear = nextMonth === 0 ? currentOverlayYear + 1 : currentOverlayYear;

      const isInCurrentMonth = newMonth === currentOverlayMonth && newYear === currentOverlayYear;
      const isInNextMonth = newMonth === nextMonth && newYear === nextYear;

      if (!isInCurrentMonth && !isInNextMonth) {
        // Navigate to the new month
        if (newDate < this.overlayCurrentMonth) {
          this.previousMonthOverlay();
        } else {
          this.nextMonthOverlay();
        }
      }

      // Focus on the new date after a short delay to allow re-render
      setTimeout(() => {
        const newDayElement = document.querySelector(`.calendar-day-overlay[data-date="${newDateStr}"]`);
        if (newDayElement) {
          newDayElement.focus();
        }
      }, 50);
    }
  }

  /**
   * Reset dates to auto-selected defaults
   */
  resetDates() {
    this.autoSelectDates();
    this.tempCheckIn = this.selectedCheckIn;
    this.tempCheckOut = this.selectedCheckOut;
    this.renderOverlayCalendar();
  }

  /**
   * Render two-month calendar in overlay
   */
  renderOverlayCalendar() {
    const container = document.getElementById('calendar-months-overlay');
    if (!container) return;

    let html = '';

    // Render two months
    for (let i = 0; i < 2; i++) {
      const monthDate = new Date(this.overlayCurrentMonth.getFullYear(), this.overlayCurrentMonth.getMonth() + i, 1);
      html += this.renderMonthOverlay(monthDate);
    }

    container.innerHTML = html;
    this.updateNavigationButtonsOverlay();
    this.setupOverlayEventListeners();
  }

  /**
   * Set up event listeners for overlay calendar (using delegation)
   */
  setupOverlayEventListeners() {
    const container = document.getElementById('calendar-months-overlay');
    if (!container) return;

    // Remove old listeners if any
    const oldContainer = container.cloneNode(true);
    container.parentNode.replaceChild(oldContainer, container);
    const newContainer = document.getElementById('calendar-months-overlay');

    // Click handler (event delegation)
    newContainer.addEventListener('click', (e) => {
      const dayEl = e.target.closest('.calendar-day-overlay');
      if (dayEl && !dayEl.hasAttribute('data-disabled')) {
        const dateStr = dayEl.getAttribute('data-date');
        if (dateStr) {
          this.handleDayClickOverlay(dateStr);
        }
      }
    });

    // Hover handlers (event delegation) - only on desktop
    if (!this.isMobile) {
      newContainer.addEventListener('mouseenter', (e) => {
        const dayEl = e.target.closest('.calendar-day-overlay');
        if (dayEl && !dayEl.hasAttribute('data-disabled')) {
          const dateStr = dayEl.getAttribute('data-date');
          if (dateStr) {
            this.handleDayHover(dateStr);
          }
        }
      }, true);

      newContainer.addEventListener('mouseleave', (e) => {
        const dayEl = e.target.closest('.calendar-day-overlay');
        if (dayEl && !dayEl.hasAttribute('data-disabled')) {
          this.clearDayHover();
        }
      }, true);
    }
  }

  /**
   * Render single month for overlay with locale support
   */
  renderMonthOverlay(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const monthName = date.toLocaleDateString(this.language === 'de' ? 'de-DE' : 'en-US', {
      month: 'long',
      year: 'numeric'
    });

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();

    // Adjust starting day based on locale
    const weekStart = this.getWeekStart();
    let startingDayOfWeek = firstDay.getDay();

    // Convert to locale-specific starting day
    if (weekStart === 1) {
      // Monday start: convert Sunday (0) to 7, then subtract 1
      startingDayOfWeek = startingDayOfWeek === 0 ? 6 : startingDayOfWeek - 1;
    }

    let html = `
      <div class="calendar-month-overlay">
        <h3 class="month-title-overlay">${monthName}</h3>
        <div class="calendar-grid-overlay">
    `;

    // Day headers (locale-specific)
    const dayHeaders = this.t('dayHeaders');
    dayHeaders.forEach(day => {
      html += `<div class="calendar-day-header-overlay">${day}</div>`;
    });

    // Empty cells before first day
    for (let i = 0; i < startingDayOfWeek; i++) {
      html += `<div class="calendar-day-overlay empty"></div>`;
    }

    // Days
    for (let day = 1; day <= daysInMonth; day++) {
      const currentDate = new Date(year, month, day);
      const dateStr = this.formatDate(currentDate);
      html += this.renderDayOverlay(dateStr, day, currentDate);
    }

    html += `</div></div>`;
    return html;
  }

  /**
   * Render individual day cell for overlay
   */
  renderDayOverlay(dateStr, dayNumber, date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isPast = date < today;

    const availability = this.availabilityData[dateStr];

    let classes = ['calendar-day-overlay'];
    let disabled = false;

    if (isPast) {
      classes.push('past');
      disabled = true;
    } else if (!availability || availability.status !== 'available') {
      classes.push(availability?.status === 'booked' ? 'booked' : 'blocked');
      disabled = true;
    } else {
      // Check if selected
      const dateTime = date.getTime();
      const checkInTime = this.tempCheckIn ? this.tempCheckIn.getTime() : null;
      const checkOutTime = this.tempCheckOut ? this.tempCheckOut.getTime() : null;

      if (checkInTime && dateTime === checkInTime) {
        classes.push('selected check-in');
      } else if (checkOutTime && dateTime === checkOutTime) {
        classes.push('selected check-out');
      } else if (checkInTime && checkOutTime && dateTime > checkInTime && dateTime < checkOutTime) {
        classes.push('in-range');
      } else if (checkInTime && !checkOutTime && this.hoverDate) {
        // Hover preview
        const hoverTime = this.hoverDate.getTime();
        if (hoverTime > checkInTime && dateTime > checkInTime && dateTime < hoverTime) {
          classes.push('hover-range');
        } else if (dateTime === hoverTime) {
          classes.push('hover-end');
        }
      }
    }

    const disabledAttr = disabled ? 'data-disabled="true"' : '';
    const dataAttr = disabled ? '' : `data-date="${dateStr}"`;
    const tabindexAttr = disabled ? '' : 'tabindex="0"';

    return `
      <div class="calendar-day-overlay ${classes.join(' ')}"
           ${dataAttr}
           ${disabledAttr}
           ${tabindexAttr}>
        <div class="day-number-overlay">${dayNumber}</div>
      </div>
    `;
  }

  /**
   * Handle day click in overlay
   */
  handleDayClickOverlay(dateStr) {
    if (!dateStr) {
      console.log('handleDayClickOverlay: dateStr is empty');
      return;
    }

    console.log('handleDayClickOverlay:', dateStr);
    const date = new Date(dateStr + 'T00:00:00');
    console.log('Parsed date:', date, 'tempCheckIn:', this.tempCheckIn, 'tempCheckOut:', this.tempCheckOut);

    // If no check-in selected, or clicking before check-in, set as check-in
    if (!this.tempCheckIn || (this.tempCheckIn && date < this.tempCheckIn)) {
      console.log('Setting as check-in');
      this.tempCheckIn = date;
      this.tempCheckOut = null;
    }
    // If clicking the same date as check-in, just keep it
    else if (this.tempCheckIn && date.getTime() === this.tempCheckIn.getTime()) {
      console.log('Clicking same date as check-in, ignoring');
      return;
    }
    // If check-in selected but no check-out, validate and set as check-out
    else if (this.tempCheckIn && !this.tempCheckOut && date > this.tempCheckIn) {
      console.log('Attempting to set as check-out');
      // Validate min-stay
      const availability = this.availabilityData[this.formatDate(this.tempCheckIn)];
      const minNights = availability?.minNights || 1;

      const daysDiff = Math.ceil((date - this.tempCheckIn) / (1000 * 60 * 60 * 24));
      console.log('Days diff:', daysDiff, 'minNights:', minNights);

      if (daysDiff < minNights) {
        console.log('Failed: minimum stay not met');
        this.showError(this.t('minStay')(minNights));
        return;
      }

      // Check if all dates in range are available
      console.log('Validating date range...');
      if (!this.validateDateRange(this.tempCheckIn, date)) {
        console.log('Failed: some dates unavailable');
        this.showError(this.t('datesUnavailable'));
        return;
      }

      console.log('Setting as check-out');
      this.tempCheckOut = date;

      // Auto-close overlay when both dates are selected
      this.clearError();
      this.closeDatepicker();
      return;
    }
    // If both selected, start over
    else {
      console.log('Both selected, starting over');
      this.tempCheckIn = date;
      this.tempCheckOut = null;
    }

    this.clearError();
    this.renderOverlayCalendar();
  }

  /**
   * Handle day hover (for range preview)
   */
  handleDayHover(dateStr) {
    if (this.isMobile) return; // No hover on mobile
    if (!dateStr) return;

    const date = new Date(dateStr + 'T00:00:00');

    // Only show hover if check-in selected but not check-out
    if (this.tempCheckIn && !this.tempCheckOut && date > this.tempCheckIn) {
      if (!this.hoverDate || this.hoverDate.getTime() !== date.getTime()) {
        this.hoverDate = date;
        this.renderOverlayCalendar();
      }
    }
  }

  /**
   * Clear day hover
   */
  clearDayHover() {
    if (this.isMobile) return;

    if (this.hoverDate) {
      this.hoverDate = null;
      this.renderOverlayCalendar();
    }
  }

  /**
   * Navigate to previous month in overlay
   */
  previousMonthOverlay() {
    const today = new Date();
    const firstOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const targetMonth = new Date(this.overlayCurrentMonth.getFullYear(), this.overlayCurrentMonth.getMonth() - 1, 1);

    // Don't allow going to past months
    if (targetMonth < firstOfCurrentMonth) {
      return;
    }

    this.overlayCurrentMonth = targetMonth;
    this.renderOverlayCalendar();
  }

  /**
   * Navigate to next month in overlay
   */
  nextMonthOverlay() {
    this.overlayCurrentMonth = new Date(
      this.overlayCurrentMonth.getFullYear(),
      this.overlayCurrentMonth.getMonth() + 1,
      1
    );
    this.renderOverlayCalendar();
  }

  /**
   * Update navigation button states in overlay
   */
  updateNavigationButtonsOverlay() {
    const prevBtn = document.getElementById('prev-month-overlay');
    const today = new Date();
    const firstOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    if (prevBtn) {
      prevBtn.disabled = this.overlayCurrentMonth <= firstOfCurrentMonth;
    }
  }

  /**
   * Handle booking request (localized)
   */
  requestBooking() {
    if (!this.selectedCheckIn || !this.selectedCheckOut || !this.currentQuote) return;

    const checkIn = this.formatDate(this.selectedCheckIn);
    const checkOut = this.formatDate(this.selectedCheckOut);
    const guests = this.guestCount;
    const quote = this.currentQuote;
    const propertyTitle = this.listingData?.title || 'Property';

    // Format dates for subject (locale-specific)
    const locale = this.language === 'de' ? 'de-DE' : 'en-US';
    const checkInFormatted = new Date(checkIn).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    const checkOutFormatted = new Date(checkOut).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

    // Generate mailto link with localized subject
    const subject = encodeURIComponent(
      this.t('emailSubject')(propertyTitle, checkInFormatted, checkOutFormatted, guests)
    );

    // Build detailed email body (localized)
    let emailBody = this.t('emailIntro')(propertyTitle);
    emailBody += `═══════════════════════════════\n`;
    emailBody += `${this.t('emailBookingDetails')}\n`;
    emailBody += `═══════════════════════════════\n\n`;
    emailBody += `${this.t('emailCheckIn')}: ${checkIn}\n`;
    emailBody += `${this.t('emailCheckOut')}: ${checkOut}\n`;
    emailBody += `${this.t('emailNights')(quote.nights)}\n`;
    emailBody += `${this.t('emailGuests')(guests)}\n\n`;

    emailBody += `═══════════════════════════════\n`;
    emailBody += `${this.t('emailPriceBreakdown')}\n`;
    emailBody += `═══════════════════════════════\n\n`;

    // Accommodation fare
    const nightlyRate = quote.breakdown.nightlyRates[0]?.adjustedPrice || 0;
    emailBody += `${this.t('emailAccommodation')}: ${this.formatCurrency(nightlyRate, quote.currency)} × ${this.t('nights')(quote.nights)} = ${this.formatCurrency(quote.pricing.accommodationFare, quote.currency)}\n`;

    // Discount
    if (quote.discount) {
      const discountLabel = quote.discount.type === 'weekly'
        ? this.t('weeklyDiscount')
        : this.t('monthlyDiscount');
      emailBody += `${discountLabel}: -${this.formatCurrency(quote.discount.savings, quote.currency)}\n`;
    }

    // Cleaning fee
    if (quote.pricing.cleaningFee > 0) {
      emailBody += `${this.t('cleaningFee')}: ${this.formatCurrency(quote.pricing.cleaningFee, quote.currency)}\n`;
    }

    // Extra guest fee
    if (quote.pricing.extraGuestFee > 0) {
      emailBody += `${this.t('extraGuests')}: ${this.formatCurrency(quote.pricing.extraGuestFee, quote.currency)}\n`;
    }

    emailBody += `\n${this.t('emailSubtotal')}: ${this.formatCurrency(quote.pricing.subtotal, quote.currency)}\n\n`;

    // Taxes
    if (quote.breakdown.taxes && quote.breakdown.taxes.length > 0) {
      emailBody += `${this.t('emailTaxes')}:\n`;
      quote.breakdown.taxes.forEach(tax => {
        emailBody += `  ${tax.description}: ${this.formatCurrency(tax.amount, quote.currency)}\n`;
      });
      emailBody += `\n${this.t('emailTotalTaxes')}: ${this.formatCurrency(quote.pricing.totalTaxes, quote.currency)}\n\n`;
    }

    emailBody += `═══════════════════════════════\n`;
    emailBody += `${this.t('emailTotalPrice')}: ${this.formatCurrency(quote.pricing.totalPrice, quote.currency)}\n`;
    emailBody += `═══════════════════════════════\n\n`;

    emailBody += `${this.t('emailProperty')}: ${window.location.origin}\n\n`;
    emailBody += `${this.t('emailConfirmRequest')}\n`;

    const body = encodeURIComponent(emailBody);
    const recipient = 'booking@farmhouse-prasser.de';
    window.location.href = `mailto:${recipient}?subject=${subject}&body=${body}`;
  }
}

// Initialize calendar when DOM is ready
let calendar;
document.addEventListener('DOMContentLoaded', () => {
  calendar = new BookingCalendar();
});