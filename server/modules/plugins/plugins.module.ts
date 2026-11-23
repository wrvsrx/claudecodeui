import fs from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';

import {
  getPluginDir, getPluginsConfig, getPluginsDir, installPluginFromGit,
  resolvePluginAssetPath, savePluginsConfig, scanPlugins, uninstallPlugin, updatePluginFromGit,
} from './plugin-registry.service.js';
import {
  getPluginPort, isPluginRunning, startPluginServer, stopPluginServer,
} from './plugin-process.service.js';
import { createPluginsRouter } from './plugins.routes.js';
import { createPluginsService } from './plugins.service.js';

const pluginsService = createPluginsService({
  scanPlugins, readConfig: getPluginsConfig, saveConfig: savePluginsConfig,
  getPluginDirectory: getPluginDir, getPluginsDirectory: getPluginsDir,
  resolveAsset: resolvePluginAssetPath,
  assetIsFile: (assetPath) => { try { return fs.statSync(assetPath).isFile(); } catch { return false; } },
  contentType: (assetPath) => mime.lookup(assetPath) || 'application/octet-stream',
  install: installPluginFromGit,
  update: updatePluginFromGit,
  uninstall: async (pluginName) => { await uninstallPlugin(pluginName); },
  startServer: startPluginServer,
  stopServer: async (pluginName) => { await stopPluginServer(pluginName); },
  getServerPort: getPluginPort, isServerRunning: isPluginRunning,
  joinPath: path.join,
  logError: (message, error) => console.error(message, error),
});

/** Assembles plugin routes for the server entrypoint, optionally redacting query credentials. */
export function createPluginsModule(options: { forwardQueryToken: boolean }) {
  return createPluginsRouter(pluginsService, options);
}

/** Standalone plugin router, also used by plugin integration tests. */
export const pluginsRoutes = createPluginsModule({ forwardQueryToken: true });
