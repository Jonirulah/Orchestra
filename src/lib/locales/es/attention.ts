// Paneles que te necesitan: aspecto de la caída/reconexión SSH y los agentes que esperan respuesta.
export default {
  // Panel SSH mientras la conexión está caída
  'attention.ssh.retrying': 'Reconectando… (intento {n})',
  'attention.ssh.downFor': 'caída desde hace {dur}',
  'attention.ssh.dotDown': 'Conexión SSH perdida: reconectando',
  'attention.ssh.dotGaveUp': 'Conexión SSH perdida: se dejó de reintentar',
  // Se escribe en el terminal localmente (nunca se envía al shell remoto)
  'attention.ssh.separator': '── reconectado {time} · caída {dur} ──',
  'attention.ssh.retryBanner': '── reconectando (intento {n}) ──',
  'attention.ssh.gaveUp': 'Reconexión abandonada tras {n} intentos: {why}',
  'attention.ssh.gaveUpOne': 'Reconexión abandonada tras 1 intento: {why}',
  'attention.ssh.paused': 'Reconexión detenida: el panel quedó oculto mientras esperaba',
  'attention.ssh.gaveUpWhen': 'a las {time} · {dur} sin conexión',
  'attention.ssh.restart': 'Reiniciar',
  'attention.ssh.close': 'Cerrar',
  'attention.ssh.cause.auth': 'el servidor rechazó el acceso (contraseña o clave)',
  'attention.ssh.cause.hostkey': 'la huella del host ha cambiado o no es de confianza',
  'attention.ssh.cause.dns': 'no se encuentra el nombre del host',
  'attention.ssh.cause.refused': 'el servidor rechazó la conexión',
  'attention.ssh.cause.timeout': 'la red no responde (tiempo agotado)',
  'attention.ssh.cause.unreachable': 'la red o el host no son accesibles',
  'attention.ssh.cause.closed': 'el servidor cierra la conexión una y otra vez',
  'attention.ssh.cause.max': 'no se pudo recuperar la conexión',
  // Agentes que te esperan
  'attention.block.title': 'Necesitan atención ({n})',
  'attention.block.rowTitle': 'Ir a este panel',
  'attention.block.waiting': 'te espera',
  'attention.tab.waiting': '{n} agente(s) esperando en esta pestaña',
  'attention.none': 'Ningún agente te espera',
  'attention.notify.title': '{name} te necesita',
  'attention.notify.body': 'Espera tu respuesta: {what}',
  'attention.notify.bodyGeneric': 'Un agente espera tu respuesta',
};
