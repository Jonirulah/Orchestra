export default {
  'imagepaste.pasted': 'Imagen pegada ({w}×{h})',
  'imagepaste.uploading': 'Subiendo la imagen a {host}…',
  'imagepaste.uploaded': 'Imagen subida a {host}',
  'imagepaste.uploadedMany': '{n} imágenes subidas a {host}',
  'imagepaste.skipped': 'Por SSH solo se suben imágenes: {n} archivo(s) omitido(s)',
  'imagepaste.failed': 'No se pudo pegar la imagen: {error}',
  'imagepaste.uploadFailed': 'No se pudo subir la imagen: {error}',
  'imagepaste.tooLarge': 'Imagen demasiado grande ({mb} MB; el límite es 25 MB)',
  'imagepaste.sshAlias': 'Pegar imágenes no está disponible en paneles abiertos desde ~/.ssh/config: añade el host a Orchestra para poder subirlas.',
  'imagepaste.noDrop': 'Soltar archivos necesita el runtime de WebView2 (no disponible aquí).',
} as const;
