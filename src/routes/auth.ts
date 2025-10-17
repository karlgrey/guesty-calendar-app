/**
 * Authentication Routes
 *
 * Handles Google OAuth login, logout, and callbacks
 */

import express from 'express';
import passport from 'passport';
import { redirectIfAuthenticated } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /auth/login
 * Display login page or redirect if already authenticated
 */
router.get('/login', redirectIfAuthenticated, (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login - Guesty Calendar</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .login-container {
      background: white;
      border-radius: 12px;
      padding: 50px 40px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }

    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
    }

    p {
      color: #666;
      margin-bottom: 30px;
      line-height: 1.6;
    }

    .google-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #4285f4;
      color: white;
      border: none;
      padding: 14px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
      width: 100%;
    }

    .google-btn:hover {
      background: #357ae8;
    }

    .google-icon {
      width: 20px;
      height: 20px;
      margin-right: 12px;
      background: white;
      border-radius: 2px;
      padding: 2px;
    }

    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }

    .footer {
      margin-top: 30px;
      font-size: 13px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="icon">🛠️</div>
    <h1>Admin Login</h1>
    <p>Sign in with your authorized Google account to access the Guesty Calendar admin panel.</p>

    <a href="/auth/google" class="google-btn">
      <svg class="google-icon" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
      Sign in with Google
    </a>

    <div class="footer">
      Authorized access only
    </div>
  </div>
</body>
</html>
  `);
});

/**
 * GET /auth/google
 * Initiate Google OAuth flow
 */
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account', // Always show account selection
}));

/**
 * GET /auth/google/callback
 * Handle Google OAuth callback
 */
router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/auth/login?error=unauthorized',
    successReturnToOrRedirect: '/admin',
  }),
  (req, res) => {
    // This function will only be called if authentication succeeds
    logger.info({ user: req.user }, 'User logged in successfully');

    // Redirect to the originally requested URL or admin dashboard
    const returnTo = req.session.returnTo || '/admin';
    delete req.session.returnTo;

    res.redirect(returnTo);
  }
);

/**
 * GET /auth/logout
 * Log out the user
 */
router.get('/logout', (req, res) => {
  const user = req.user;

  req.logout((err) => {
    if (err) {
      logger.error({ err }, 'Error during logout');
      res.status(500).send('Error logging out');
      return;
    }

    logger.info({ user }, 'User logged out');

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logged Out - Guesty Calendar</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 12px;
      padding: 50px 40px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }

    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
    }

    p {
      color: #666;
      margin-bottom: 30px;
      line-height: 1.6;
    }

    .btn {
      display: inline-block;
      background: #667eea;
      color: white;
      border: none;
      padding: 14px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
    }

    .btn:hover {
      background: #5568d3;
    }

    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">👋</div>
    <h1>Logged Out</h1>
    <p>You have been successfully logged out of the admin panel.</p>
    <a href="/auth/login" class="btn">Login Again</a>
  </div>
</body>
</html>
    `);
  });
});

/**
 * GET /auth/unauthorized
 * Display unauthorized access page
 */
router.get('/unauthorized', (_req, res) => {
  res.status(403).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unauthorized - Guesty Calendar</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 12px;
      padding: 50px 40px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }

    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
    }

    p {
      color: #666;
      margin-bottom: 30px;
      line-height: 1.6;
    }

    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🚫</div>
    <h1>Access Denied</h1>
    <p>Your email address is not authorized to access the admin panel. Please contact the administrator if you believe this is an error.</p>
  </div>
</body>
</html>
  `);
});

export default router;
