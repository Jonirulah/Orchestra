// Aggregates every area dictionary. One file per area so parallel edits never collide.
import type { Key } from '../../i18n.ts';
import app from './app.ts';
import topbar from './topbar.ts';
import sidebar from './sidebar.ts';
import agents from './agents.ts';
import usage from './usage.ts';
import grid from './grid.ts';
import pane from './pane.ts';
import palette from './palette.ts';
import dialogs from './dialogs.ts';
import settings from './settings.ts';
import store from './store.ts';
import policy from './policy.ts';
import model from './model.ts';
import terminals from './terminals.ts';
import tray from './tray.ts';
import settingsTerminal from './settingsTerminal.ts';
import imagepaste from './imagepaste.ts';
import settingsAgents from './settingsAgents.ts';
import settingsDialog from './settingsDialog.ts';
import settingsAccounts from './settingsAccounts.ts';
import settingsData from './settingsData.ts';
import shortcuts from './shortcuts.ts';
import themeimport from './themeimport.ts';
import hostDialog from './hostDialog.ts';
import settingsKeys from './settingsKeys.ts';
import hostkeyConfirm from './hostkeyConfirm.ts';
import settingsMcp from './settingsMcp.ts';
import mcpApproval from './mcpApproval.ts';
import settingsUsage from './settingsUsage.ts';
import providers from './providers.ts';
import ctx from './ctx.ts';
import git from './git.ts';
import statusbar from './statusbar.ts';
import updater from './updater.ts';
import attention from './attention.ts';
import files from './files.ts';
import ports from './ports.ts';

export const es: Record<Key, string> = {
  ...app,
  ...topbar,
  ...sidebar,
  ...agents,
  ...usage,
  ...grid,
  ...pane,
  ...palette,
  ...dialogs,
  ...settings,
  ...store,
  ...policy,
  ...model,
  ...terminals,
  ...tray,
  ...settingsTerminal,
  ...imagepaste,
  ...settingsAgents,
  ...settingsDialog,
  ...settingsAccounts,
  ...settingsData,
  ...shortcuts,
  ...themeimport,
  ...hostDialog,
  ...settingsKeys,
  ...hostkeyConfirm,
  ...settingsMcp,
  ...mcpApproval,
  ...settingsUsage,
  ...providers,
  ...ctx,
  ...git,
  ...statusbar,
  ...updater,
  ...attention,
  ...files,
  ...ports,
};
