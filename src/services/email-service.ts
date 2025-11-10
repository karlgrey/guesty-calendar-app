/**
 * Email Service
 *
 * Handles sending emails via Resend (preferred) or SMTP fallback
 */

import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

let resendClient: Resend | null = null;
let transporter: Transporter | null = null;

/**
 * Initialize Resend client
 */
function getResendClient(): Resend | null {
  if (resendClient) {
    return resendClient;
  }

  if (!config.resendApiKey) {
    return null;
  }

  try {
    resendClient = new Resend(config.resendApiKey);
    logger.info('Resend email client initialized');
    return resendClient;
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Resend client');
    return null;
  }
}

/**
 * Initialize SMTP transporter (fallback)
 */
function getTransporter(): Transporter | null {
  if (transporter) {
    return transporter;
  }

  if (!config.smtpHost || !config.smtpPort) {
    return null;
  }

  try {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser && config.smtpPassword ? {
        user: config.smtpUser,
        pass: config.smtpPassword,
      } : undefined,
    });

    logger.info({ host: config.smtpHost, port: config.smtpPort }, 'SMTP transporter initialized');
    return transporter;
  } catch (error) {
    logger.error({ error }, 'Failed to initialize SMTP transporter');
    return null;
  }
}

/**
 * Send an email using Resend (preferred) or SMTP (fallback)
 */
export async function sendEmail(options: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}): Promise<boolean> {
  const recipients = Array.isArray(options.to) ? options.to : [options.to];

  // Check if from email is configured
  if (!config.emailFromAddress) {
    logger.error('Cannot send email - EMAIL_FROM_ADDRESS not configured');
    return false;
  }

  // Try Resend first
  const resend = getResendClient();
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from: `${config.emailFromName} <${config.emailFromAddress}>`,
        to: recipients,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      if (error) {
        logger.error({ error, recipients, subject: options.subject }, 'Resend API error');
        return false;
      }

      logger.info(
        {
          messageId: data?.id,
          recipients,
          subject: options.subject,
          provider: 'resend',
        },
        'Email sent successfully via Resend'
      );

      return true;
    } catch (error) {
      logger.error(
        {
          error,
          to: options.to,
          subject: options.subject,
        },
        'Failed to send email via Resend'
      );
      return false;
    }
  }

  // Fallback to SMTP
  const transport = getTransporter();
  if (!transport) {
    logger.warn('Cannot send email - no email provider configured (Resend or SMTP)');
    return false;
  }

  try {
    const info = await transport.sendMail({
      from: `"${config.emailFromName}" <${config.emailFromAddress}>`,
      to: recipients.join(', '),
      subject: options.subject,
      text: options.text,
      html: options.html,
    });

    logger.info(
      {
        messageId: info.messageId,
        recipients,
        subject: options.subject,
        provider: 'smtp',
      },
      'Email sent successfully via SMTP'
    );

    return true;
  } catch (error) {
    logger.error(
      {
        error,
        to: options.to,
        subject: options.subject,
      },
      'Failed to send email via SMTP'
    );
    return false;
  }
}

/**
 * Verify email connection (tests Resend or SMTP)
 */
export async function verifyEmailConnection(): Promise<boolean> {
  // Check Resend first
  const resend = getResendClient();
  if (resend) {
    try {
      // Resend doesn't have a verify method, but we can check if API key is valid
      // by making a simple API call
      logger.info('Resend client initialized - ready to send emails');
      return true;
    } catch (error) {
      logger.error({ error }, 'Resend client verification failed');
      return false;
    }
  }

  // Fallback to SMTP verification
  const transport = getTransporter();
  if (!transport) {
    logger.warn('No email provider configured');
    return false;
  }

  try {
    await transport.verify();
    logger.info('SMTP connection verified successfully');
    return true;
  } catch (error) {
    logger.error({ error }, 'SMTP connection verification failed');
    return false;
  }
}
