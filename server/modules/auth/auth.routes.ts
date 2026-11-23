import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';
import type { createProxySsoBridge } from './proxy-sso.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
  bridge: ReturnType<typeof createProxySsoBridge> = null,
  proxySession: (() => Promise<ReturnType<ReturnType<typeof createAuthService>['issueProxySession']>>) | null = null,
): express.Router {
  const router = express.Router();

  if (bridge && proxySession) {
    // SSO bootstrap and all other auth replies must not be cached or shared.
    router.use((_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    router.post('/sso', async (req, res, next) => {
      if (!bridge.allowsExchange(req)) {
        res.status(403).json({ error: 'CloudCLI SSO exchange denied' });
        return;
      }
      try {
        res.json(await proxySession());
      } catch (error) {
        next(error);
      }
    });
    router.post(['/register', '/login'], (_req, res) => {
      res.status(403).json({ error: 'Native authentication is disabled in SSO mode' });
    });
  }

  router.get('/status', (_req, res, next) => {
    try {
      res.json(bridge ? { ssoBridge: true, needsSetup: false, isAuthenticated: false } : service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
