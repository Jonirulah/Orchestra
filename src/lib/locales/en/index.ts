// Aggregates every area dictionary. One file per area so parallel edits never collide.
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
import settingsMcpServers from './settingsMcpServers.ts';
import settingsMcpEdit from './settingsMcpEdit.ts';
import mcpView from './mcpView.ts';
import mcpApproval from './mcpApproval.ts';
import settingsUsage from './settingsUsage.ts';
import providers from './providers.ts';
import ctx from './ctx.ts';
import git from './git.ts';
import statusbar from './statusbar.ts';
import consumo from './consumo.ts';

export const en = {
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
  ...settingsMcpServers,
  ...settingsMcpEdit,
  ...mcpView,
  ...mcpApproval,
  ...settingsUsage,
  ...providers,
  ...ctx,
  ...git,
  ...statusbar,
  ...consumo,
};
