export default {
  // Layout presets (only the two that have words in the label; "N × M" ones are not translated)
  'model.preset.twoColumns': '2 × 1 (dos columnas)',
  'model.preset.twoRows': '1 × 2 (dos filas)',
  // Default names are stored in English in state.json; these are the labels shown for them
  'model.defaultName.main': 'Principal',
  'model.defaultName.workspace': 'Espacio de trabajo {n}',
  // Why a host-key check is blocked (shown in the host-key dialog)
  'model.hostKey.jump': "A este host se llega a través de un host intermedio (jump host), así que su clave no se puede comprobar de antemano. Cambia este host a «Confiar en el primer uso» en sus ajustes, o conéctate una vez sin contraseña guardada.",
  'model.hostKey.alias': "Este host usa un HostKeyAlias en tu configuración de SSH, así que su clave no se puede comprobar de antemano. Cambia este host a «Confiar en el primer uso» en sus ajustes, o conéctate una vez sin contraseña guardada.",
} as const;
