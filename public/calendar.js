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

    this.init();
  }

  async init() {
    // Fetch listing data
    await this.fetchListingData();

    // Initialize guest selector
    this.initGuestSelector();

    // Fetch availability for current and next month
    await this.fetchAvailability();

    // Render calendar
    this.render();

    // Set up event listeners
    this.setupEventListeners();
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
   * Format currency
   */
  formatCurrency(amount, currency) {
    const symbol = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency;
    return `${symbol}${Math.round(amount)}`;
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
      this.updateSelectionInfo();
    } else {
      this.showGuestHelper(`Maximum capacity is ${this.maxGuests} guest${this.maxGuests > 1 ? 's' : ''}`, 'error');
    }
  }

  /**
   * Decrement guest count
   */
  decrementGuests() {
    if (this.guestCount > 1) {
      this.guestCount--;
      this.updateGuestUI();
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
          `${extraGuests} extra guest${extraGuests > 1 ? 's' : ''} (${this.formatCurrency(fee, this.listingData.currency)}/guest)`,
          'warning'
        );
      } else {
        this.showGuestHelper(`${this.guestCount} guest${this.guestCount > 1 ? 's' : ''} included in base price`, 'info');
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
        this.showError(`Minimum stay is ${minNights} night${minNights > 1 ? 's' : ''}`);
        return;
      }

      // Check if all dates in range are available
      if (!this.validateDateRange(this.selectedCheckIn, date)) {
        this.showError('Some dates in the selected range are not available');
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
   * Update selection info display
   */
  async updateSelectionInfo() {
    const infoEl = document.getElementById('selection-info');
    if (!infoEl) return;

    if (!this.selectedCheckIn) {
      infoEl.innerHTML = `
        <p style="text-align: center; color: #6b7280;">Select your check-in date to get started</p>
        <button class="cta-button" disabled>Request to Book</button>
      `;
      return;
    }

    if (!this.selectedCheckOut) {
      infoEl.innerHTML = `
        <p style="text-align: center; color: #6b7280;">Select your check-out date</p>
        <button class="cta-button" disabled>Request to Book</button>
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
   * Handle booking request
   */
  requestBooking() {
    if (!this.selectedCheckIn || !this.selectedCheckOut || !this.currentQuote) return;

    const checkIn = this.formatDate(this.selectedCheckIn);
    const checkOut = this.formatDate(this.selectedCheckOut);
    const guests = this.guestCount;
    const quote = this.currentQuote;
    const propertyTitle = this.listingData?.title || 'Property';

    // Format dates for subject
    const checkInFormatted = new Date(checkIn).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const checkOutFormatted = new Date(checkOut).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // Generate mailto link
    const subject = encodeURIComponent(
      `[Booking Request] ${propertyTitle} – ${checkInFormatted} → ${checkOutFormatted}, ${guests} guest${guests > 1 ? 's' : ''}`
    );

    // Build detailed email body
    let emailBody = `I would like to request a booking for ${propertyTitle}:\n\n`;
    emailBody += `═══════════════════════════════\n`;
    emailBody += `BOOKING DETAILS\n`;
    emailBody += `═══════════════════════════════\n\n`;
    emailBody += `Check-in: ${checkIn}\n`;
    emailBody += `Check-out: ${checkOut}\n`;
    emailBody += `Nights: ${quote.nights}\n`;
    emailBody += `Guests: ${guests}\n\n`;

    emailBody += `═══════════════════════════════\n`;
    emailBody += `PRICE BREAKDOWN\n`;
    emailBody += `═══════════════════════════════\n\n`;

    // Accommodation fare
    const nightlyRate = quote.breakdown.nightlyRates[0]?.adjustedPrice || 0;
    emailBody += `Accommodation: ${this.formatCurrency(nightlyRate, quote.currency)} × ${quote.nights} night${quote.nights > 1 ? 's' : ''} = ${this.formatCurrency(quote.pricing.accommodationFare, quote.currency)}\n`;

    // Discount
    if (quote.discount) {
      const discountType = quote.discount.type === 'weekly' ? 'Weekly' : 'Monthly';
      emailBody += `${discountType} Discount: -${this.formatCurrency(quote.discount.savings, quote.currency)}\n`;
    }

    // Cleaning fee
    if (quote.pricing.cleaningFee > 0) {
      emailBody += `Cleaning Fee: ${this.formatCurrency(quote.pricing.cleaningFee, quote.currency)}\n`;
    }

    // Extra guest fee
    if (quote.pricing.extraGuestFee > 0) {
      emailBody += `Extra Guest Fee: ${this.formatCurrency(quote.pricing.extraGuestFee, quote.currency)}\n`;
    }

    emailBody += `\nSubtotal: ${this.formatCurrency(quote.pricing.subtotal, quote.currency)}\n\n`;

    // Taxes
    if (quote.breakdown.taxes && quote.breakdown.taxes.length > 0) {
      emailBody += `Taxes:\n`;
      quote.breakdown.taxes.forEach(tax => {
        emailBody += `  ${tax.description}: ${this.formatCurrency(tax.amount, quote.currency)}\n`;
      });
      emailBody += `\nTotal Taxes: ${this.formatCurrency(quote.pricing.totalTaxes, quote.currency)}\n\n`;
    }

    emailBody += `═══════════════════════════════\n`;
    emailBody += `TOTAL PRICE: ${this.formatCurrency(quote.pricing.totalPrice, quote.currency)}\n`;
    emailBody += `═══════════════════════════════\n\n`;

    emailBody += `Property: ${window.location.origin}\n\n`;
    emailBody += `Please confirm availability and send booking details.\n\n`;
    emailBody += `Thank you!\n`;

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