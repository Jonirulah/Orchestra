export default {
  // Host-key confirmation dialog (ConfirmHostKey.svelte). The blocked messages live in model.hostKey.*
  'hostkey.confirm.aria': "Verify the server's host key",
  'hostkey.confirm.titleConfirm': 'Trust this server?',
  'hostkey.confirm.titleOther': 'Server host key',
  'hostkey.confirm.checking': "Reading the server's host key…",
  'hostkey.confirm.newOne': 'Orchestra has not seen this server before. Its host key is:',
  'hostkey.confirm.newMany': 'Orchestra has not seen this server before. Its host keys are:',
  'hostkey.confirm.warning': "Compare this fingerprint with one you got from the server's administrator or from a trusted channel. Trusting a wrong key lets an attacker impersonate the server.",
  'hostkey.confirm.cancel': 'Cancel',
  'hostkey.confirm.trust': 'Trust and connect',
  'hostkey.confirm.close': 'Close',
} as const;
