/**
 * Email Service
 *
 * Handles sending emails via SMTP using nodemailer
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

let transporter: Transporter | null = null;

/**
 * Initialize email transporter
 */
function getTransporter(): Transporter | null {
  // Return existing transporter if already initialized
  if (transporter) {
    return transporter;
  }

  // Check if SMTP is configured
  if (!config.smtpHost || !config.smtpPort) {
    logger.warn('SMTP not configured - email sending disabled');
    return null;
  }

  try {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure, // true for 465, false for other ports
      auth: config.smtpUser && config.smtpPassword ? {
        user: config.smtpUser,
        pass: config.smtpPassword,
      } : undefined,
    });

    logger.info({ host: config.smtpHost, port: config.smtpPort }, 'Email transporter initialized');
    return transporter;
  } catch (error) {
    logger.error({ error }, 'Failed to initialize email transporter');
    return null;
  }
}

/**
 * Send an email
 */
export async function sendEmail(options: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
    logger.warn('Cannot send email - SMTP not configured');
    return false;
  }

  if (!config.smtpFromEmail) {
    logger.error('Cannot send email - SMTP_FROM_EMAIL not configured');
    return false;
  }

  try {
    const recipients = Array.isArray(options.to) ? options.to : [options.to];

    const info = await transport.sendMail({
      from: `"${config.smtpFromName}" <${config.smtpFromEmail}>`,
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
      },
      'Email sent successfully'
    );

    return true;
  } catch (error) {
    logger.error(
      {
        error,
        to: options.to,
        subject: options.subject,
      },
      'Failed to send email'
    );
    return false;
  }
}

/**
 * Verify SMTP connection
 */
export async function verifyEmailConnection(): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
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
