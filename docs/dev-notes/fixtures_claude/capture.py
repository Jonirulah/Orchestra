# Captura la salida en bruto de Claude Code en un ConPTY (pywinpty), con un CLAUDE_CONFIG_DIR temporal.
import os, sys, time, threading
from winpty import PtyProcess
cfg, out, prompt, cwd = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
env = dict(os.environ)
env.update({'CLAUDE_CONFIG_DIR': cfg, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'TERM_PROGRAM': 'Orchestra'})
for k in list(env):
    if k.startswith('CLAUDE') and k != 'CLAUDE_CONFIG_DIR': env.pop(k)
cmd = 'claude.exe --model haiku --allowedTools Read'
p = PtyProcess.spawn(cmd, cwd=cwd, env=env, dimensions=(40, 110))
buf = []
last = [time.time()]
def rd():
    while True:
        try:
            s = p.read(65536)
        except Exception:
            break
        if s:
            buf.append(s); last[0] = time.time()
            # Respuestas de terminal (las da xterm.js en Orchestra)
            if '[6n' in s: p.write('[37;3R')
            if '[c' in s: p.write('[?62;22c')
threading.Thread(target=rd, daemon=True).start()
t0 = time.time()
sent = False
def save():
    open(out, 'wb').write(''.join(buf).encode('utf-8'))
while time.time() - t0 < 150:
    time.sleep(0.5)
    save()
    if not p.isalive(): break
    text = ''.join(buf)
    if False and time.time() - last[0] > 1.5:
        p.write('\r'); trusted = True
    if not sent and time.time() - t0 > 4 and time.time() - last[0] > 2.5:
        p.write(prompt); time.sleep(1.0); p.write(chr(13)); sent = True; t1 = time.time()
    if sent and time.time() - t1 > 25 and time.time() - last[0] > 12:
        break
for _ in range(2):
    try:
        p.write('\x03'); time.sleep(0.7)
    except Exception: pass
try: p.terminate(force=True)
except Exception: pass
save()
print('bytes', len(''.join(buf).encode('utf-8')), 'alive', p.isalive())
