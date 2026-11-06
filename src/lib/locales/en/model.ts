export default {
  // Layout presets (only the two that have words in the label; "N × M" ones are not translated)
  'model.preset.twoColumns': '2 × 1 (two columns)',
  'model.preset.twoRows': '1 × 2 (two rows)',
  // Default names are stored in English in state.json; these are the labels shown for them
  'model.defaultName.main': 'Main',
  'model.defaultName.workspace': 'Workspace {n}',
  // Why a host-key check is blocked (shown in the host-key dialog)
  'model.hostKey.jump': "This host is reached through a jump host, so its key can't be checked in advance. Set this host to 'Trust on first use' in its settings, or connect once without a saved password.",
  'model.hostKey.alias': "This host uses a HostKeyAlias in your SSH config, so its key can't be checked in advance. Set this host to 'Trust on first use' in its settings, or connect once without a saved password.",
} as const;
