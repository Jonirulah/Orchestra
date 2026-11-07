export default {
  'imagepaste.pasted': 'Image pasted ({w}×{h})',
  'imagepaste.uploading': 'Uploading image to {host}…',
  'imagepaste.uploaded': 'Image uploaded to {host}',
  'imagepaste.uploadedMany': '{n} images uploaded to {host}',
  'imagepaste.skipped': 'Only images are uploaded over SSH: {n} file(s) skipped',
  'imagepaste.failed': 'Could not paste the image: {error}',
  'imagepaste.uploadFailed': 'Could not upload the image: {error}',
  'imagepaste.tooLarge': 'Image too large ({mb} MB; the limit is 25 MB)',
  'imagepaste.sshAlias': 'Pasting images is not available in panes opened from ~/.ssh/config: add the host to Orchestra to upload them.',
  'imagepaste.noDrop': 'Dropping files needs the WebView2 runtime (not available here).',
} as const;
