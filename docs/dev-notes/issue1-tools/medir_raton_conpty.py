# Mide que emite una app (Claude Code) en un ConPTY ante raton SGR. Uso: medir.py <salida.json> <escenario>
import os, sys, time, threading, json, re
from winpty import PtyProcess
import pyte
out, esc = sys.argv[1], sys.argv[2]
env = {k: v for k, v in os.environ.items() if not (k.startswith('CLAUDE_CODE_') or k in ('CLAUDECODE', 'NO_COLOR'))}
COLS, ROWS = 120, 40
p = PtyProcess.spawn(os.environ.get('MEDIR_CMD', 'claude'), dimensions=(ROWS, COLS), env=env, cwd=os.environ.get('MEDIR_CWD', os.path.expanduser('~')))
buf = []  # (t, texto)
t0 = time.time()
screen = pyte.Screen(COLS, ROWS); stream = pyte.Stream(screen)
lock = threading.Lock()
def reader():
    while True:
        try: d = p.read(65536)
        except Exception: break
        if not d: break
        with lock:
            buf.append((time.time() - t0, d))
            try: stream.feed(d)
            except Exception: pass
threading.Thread(target=reader, daemon=True).start()
marks = []
import ctypes
seqs = []  # (t, numero de secuencia del portapapeles): cambia en cada escritura, sin leer el contenido
def vigia():
    u = ctypes.windll.user32; last = u.GetClipboardSequenceNumber()
    while True:
        n = u.GetClipboardSequenceNumber()
        if n != last: seqs.append((round(time.time() - t0, 3), n - last)); last = n
        time.sleep(0.005)
threading.Thread(target=vigia, daemon=True).start()
def mark(name):
    with lock: marks.append((name, time.time() - t0, len(buf)))
def lines():
    with lock: return list(screen.display)
def find(txt):
    for y, l in enumerate(lines()):
        x = l.find(txt)
        if x >= 0: return x + 1, y + 1
    return None
def sgr(b, x, y, press=True): p.write('\x1b[<%d;%d;%d%s' % (b, x, y, 'M' if press else 'm'))
def drag(x1, y, x2, pausa=0.0):
    sgr(0, x1, y); time.sleep(0.05)
    for x in range(x1 + 1, x2 + 1):
        sgr(32, x, y); time.sleep(0.02)
        if pausa and x == (x1 + x2) // 2: time.sleep(pausa)
    time.sleep(0.05); sgr(0, x2, y, False)
time.sleep(float(os.environ.get('MEDIR_ARRANQUE', '9')))
mark('arrancado')
if any('trust this folder' in l for l in lines()):
    if os.environ.get('MEDIR_TRUST') == '1':
        p.write('\x1b[B'); time.sleep(0.3); p.write('\r'); time.sleep(8); mark('confiado')
    else:
        print('DIALOGO DE CONFIANZA'); p.terminate(force=True); sys.exit(3)
p.write('alfa beta gamma delta'); time.sleep(1.5)
pos = find('alfa beta')
mark('escrito pos=%s' % (pos,))
res = {'pos': pos}
if pos:
    x, y = pos
    for paso in esc.split(','):
        if paso == 'arrastre': drag(x, y, x + 8)
        elif paso == 'arrastre_pausa': drag(x, y, x + 8, pausa=0.6)
        elif paso == 'doble':
            sgr(0, x + 6, y); sgr(0, x + 6, y, False); time.sleep(0.08); sgr(0, x + 6, y); sgr(0, x + 6, y, False)
        elif paso == 'triple':
            for _ in range(3): sgr(0, x + 6, y); sgr(0, x + 6, y, False); time.sleep(0.08)
        elif paso == 'derecho': sgr(2, x + 3, y); time.sleep(0.05); sgr(2, x + 3, y, False)
        elif paso == 'clic': sgr(0, x + 15, y); time.sleep(0.05); sgr(0, x + 15, y, False)
        elif paso == 'ctrlv': p.write('\x16')
        elif paso == 'central': sgr(1, x + 30, y - 10); time.sleep(0.05); sgr(1, x + 30, y - 10, False)
        elif paso == 'espera': time.sleep(3)
        elif paso == 'pegado': p.write('\x1b[200~PEGADO\x1b[201~')
        elif paso == 'derecho_fuera': sgr(2, x + 30, y - 10); time.sleep(0.05); sgr(2, x + 30, y - 10, False)
        time.sleep(1.5); mark(paso); res.setdefault('entrada', []).append([paso] + [l.strip() for l in lines() if 'alfa' in l])
res['pantalla'] = [l.rstrip() for l in lines() if l.strip()]
try: p.terminate(force=True)
except Exception: pass
with lock:
    todo = ''.join(d for _, d in buf)
    # por tramo entre marcas: OSC 52 y modos
    tramos = []; prev = 0
    for name, t, n in marks:
        s = ''.join(d for _, d in buf[prev:n]); prev = n
        osc = [(m.group(1), len(m.group(2)), m.group(2)[:80]) for m in re.finditer(r'\x1b\]52;([^;]*);([^\x07\x1b]*)(?:\x07|\x1b\\)', s)]
        modos = re.findall(r'\x1b\[\?[0-9;]+[hl]', s)
        tramos.append({'tramo': name, 't': round(t, 2), 'bytes': len(s), 'osc52': osc, 'modos': sorted(set(modos))})
res['tramos'] = tramos
res['osc52_t'] = [round(t, 3) for t, d in buf if '\x1b]52;' in d]
res['portapapeles_t'] = seqs
json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
open(out + '.raw', 'w', encoding='utf-8', newline='').write(todo)
