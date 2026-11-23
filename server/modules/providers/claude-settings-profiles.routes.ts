import express from 'express';

import { requireAuthenticatedUserId } from '@/shared/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { claudeSettingsProfilesService } from './services/claude-settings-profiles.service.js';

// Mounted by the server behind authentication for the Account settings screen.
export const claudeSettingsProfilesRoutes = express.Router();
claudeSettingsProfilesRoutes.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

claudeSettingsProfilesRoutes.get('/', asyncHandler(async (req, res) => {
  res.json(claudeSettingsProfilesService.getAccountSettings(requireAuthenticatedUserId(req)));
}));

claudeSettingsProfilesRoutes.put('/', asyncHandler(async (req, res) => {
  const userId = requireAuthenticatedUserId(req);
  const body: unknown = req.body;
  const selectedProfile = body && typeof body === 'object' && !Array.isArray(body)
    && Object.hasOwn(body, 'selectedProfile')
    ? (body as { selectedProfile: unknown }).selectedProfile
    : undefined;
  if (selectedProfile !== null && typeof selectedProfile !== 'string') {
    throw new AppError('selectedProfile must be a profile ID or null.', {
      code: 'INVALID_CLAUDE_SETTINGS_PROFILE', statusCode: 400,
    });
  }
  res.json(claudeSettingsProfilesService.setAccountSelection(userId, selectedProfile));
}));
