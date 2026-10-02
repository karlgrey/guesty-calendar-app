/**
 * Authentication Routes
 *
 * Handles local username/password login and logout
 */

import express from 'express';
import passport from 'passport';
import { redirectIfAuthenticated } from '../middleware/auth.js';
import { loginRateLimiter } from '../middleware/login-rate-limit.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /auth/login
 * Display login page or redirect if already authenticated
 */
router.get('/login', redirectIfAuthenticated, (req, res) => {
  const error = req.query.error;
  const errorMessage = error === 'invalid' ? 'Invalid email or password' : error === 'session' ? 'Session error. Please try again.' : '';

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
    }

    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
      text-align: center;
    }

    .subtitle {
      color: #666;
      margin-bottom: 30px;
      line-height: 1.6;
      text-align: center;
    }

    .form-group {
      margin-bottom: 20px;
    }

    label {
      display: block;
      color: #333;
      font-weight: 500;
      margin-bottom: 8px;
    }

    input {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.2s;
    }

    input:focus {
      outline: none;
      border-color: #667eea;
    }

    .login-btn {
      width: 100%;
      background: #667eea;
      color: white;
      border: none;
      padding: 14px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }

    .login-btn:hover {
      background: #5568d3;
    }

    .icon {
      font-size: 48px;
      margin-bottom: 20px;
      text-align: center;
    }

    .error {
      background: #fee;
      color: #c33;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
    }

    .footer {
      margin-top: 30px;
      font-size: 13px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="icon">🛠️</div>
    <h1>Admin Login</h1>
    <p class="subtitle">Sign in to access the Guesty Calendar admin panel.</p>

    ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}

    <form method="POST" action="/auth/login">
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required autofocus>
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
      </div>

      <button type="submit" class="login-btn">Sign In</button>
    </form>

    <div class="footer">
      Authorized access only
    </div>
  </div>
</body>
</html>
  `);
});

/**
 * POST /auth/login
 * Handle login form submission
 */
// #767: Rate-Limit (10 Versuche / 15 min je IP) + Fehlversuche mit IP im Log.
// Custom-Callback statt failureRedirect, weil die Passport-Strategie die IP nicht kennt.
router.post('/login', loginRateLimiter, (req, res, next) => {
  passport.authenticate(
    'local',
    (err: unknown, user: Express.User | false | undefined, info?: { message?: string }) => {
      if (err) {
        next(err);
        return;
      }
      if (!user) {
        logger.warn({ ip: req.ip, email: req.body?.email, reason: info?.message }, 'Login failed');
        res.redirect('/auth/login?error=invalid');
        return;
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          next(loginErr);
          return;
        }
        logger.info({ user: req.user, ip: req.ip }, 'User logged in successfully');

        // Redirect to the originally requested URL or admin dashboard
        const returnTo = req.session.returnTo || '/admin';
        delete req.session.returnTo;

        // IMPORTANT: Save session before redirecting to ensure authentication persists
        req.session.save((saveErr) => {
          if (saveErr) {
            logger.error({ err: saveErr }, 'Error saving session after authentication');
            return res.redirect('/auth/login?error=session');
          }
          res.redirect(returnTo);
        });
      });
    }
  )(req, res, next);
});

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
