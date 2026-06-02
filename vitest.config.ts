import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // Provide minimal valid values so config/index.ts can parse without a .env file.
      // These are test-only stubs; they do not grant access to any real service.
      BASE_URL: 'http://localhost:3000',
      GUESTY_CLIENT_ID: 'test-client-id',
      GUESTY_CLIENT_SECRET: 'test-client-secret',
      BOOKING_RECIPIENT_EMAIL: 'test@example.com',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      ADMIN_ALLOWED_EMAILS: 'test@example.com',
      RESEND_API_KEY: 'test-resend-key',
      EMAIL_FROM_ADDRESS: 'noreply@example.com',
      EMAIL_FROM_NAME: 'Test',
    },
  },
});
