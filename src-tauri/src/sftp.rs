//! Explorador de archivos por SFTP de los hosts guardados.
//!
//! Elección: un cliente SFTP v3 propio que habla el protocolo binario sobre el SUBSISTEMA `sftp` del mismo `ssh` que usa el
//! resto de la app (`ssh <base_args> -s -- usuario@host sftp`). Así hereda todo lo de `remote_metrics::base_args`: las `-o`
//! de seguridad, `StrictHostKeyChecking=yes` (la huella nunca se acepta sola), el salto `-J` y el askpass de la bóveda por el
//! ENTORNO (el secreto nunca va en argumentos). Funciona en cuentas solo-SFTP (no hay shell remota) y no hay que analizar
//! texto: READDIR devuelve tamaño, fecha y permisos estructurados. El progreso se cuenta por bytes confirmados y cancelar
//! cierra el archivo, borra lo parcial y, si no responde, mata el hijo.
//!
//! Una conexión viva por destino para listar y operar (se suelta tras 5 min sin uso) y una conexión propia por transferencia
//! (corren en paralelo sin bloquear la lista y se cancelan matando solo la suya).
//!
//! Lo que llega del servidor son DATOS: nombres que se muestran como texto, nunca se ejecutan.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::remote_metrics::{base_args, build_env, classify, Dest, Kind};

// ---------- protocolo (draft-ietf-secsh-filexfer-02, versión 3) ----------

const FXP_INIT: u8 = 1;
const FXP_VERSION: u8 = 2;
const FXP_OPEN: u8 = 3;
const FXP_CLOSE: u8 = 4;
const FXP_READ: u8 = 5;
const FXP_WRITE: u8 = 6;
const FXP_LSTAT: u8 = 7;
const FXP_OPENDIR: u8 = 11;
const FXP_READDIR: u8 = 12;
const FXP_REMOVE: u8 = 13;
const FXP_MKDIR: u8 = 14;
const FXP_RMDIR: u8 = 15;
const FXP_REALPATH: u8 = 16;
const FXP_STAT: u8 = 17;
const FXP_RENAME: u8 = 18;
const FXP_STATUS: u8 = 101;
const FXP_HANDLE: u8 = 102;
const FXP_DATA: u8 = 103;
const FXP_NAME: u8 = 104;
const FXP_ATTRS: u8 = 105;

pub const FLAG_READ: u32 = 0x01;
pub const FLAG_WRITE: u32 = 0x02;
pub const FLAG_CREAT: u32 = 0x08;
pub const FLAG_TRUNC: u32 = 0x10;
pub const FLAG_EXCL: u32 = 0x20;

const ATTR_SIZE: u32 = 0x01;
const ATTR_UIDGID: u32 = 0x02;
const ATTR_PERM: u32 = 0x04;
const ATTR_TIME: u32 = 0x08;
const ATTR_EXT: u32 = 0x8000_0000;

const ST_OK: u32 = 0;
const ST_EOF: u32 = 1;
const ST_NO_SUCH_FILE: u32 = 2;
const ST_PERMISSION_DENIED: u32 = 3;

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

/// Tamaño de cada trozo y peticiones en vuelo (32 KiB × 64 = 2 MiB por transferencia).
pub const CHUNK: u32 = 32 * 1024;
pub const WINDOW: usize = 64;
/// Tope de un paquete recibido (OpenSSH manda como mucho 256 KiB de datos).
const MAX_PACKET: usize = 512 * 1024;
/// Tope de entradas de un directorio que se devuelven (evita colgar la interfaz con carpetas enormes).
pub const MAX_ENTRIES: usize = 20_000;
/// Tope de entradas que se borran o suben en una carpeta recursiva.
pub const MAX_TREE: usize = 50_000;

/// Errores con prefijo estable: el frontend los traduce (sftp.ts `errorKey`).
pub const E_NOFILE: &str = "E_NOFILE";
pub const E_DENIED: &str = "E_DENIED";
pub const E_CANCEL: &str = "E_CANCEL";
pub const E_HOSTKEY: &str = "E_HOSTKEY";
pub const E_AUTH: &str = "E_AUTH";
pub const E_NET: &str = "E_NET";
pub const E_EXISTS: &str = "E_EXISTS";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attrs {
    pub size: Option<u64>,
    pub perm: Option<u32>,
    pub mtime: Option<u32>,
}
impl Attrs {
    pub fn is_dir(&self) -> bool {
        self.perm.map(|p| p & S_IFMT == S_IFDIR).unwrap_or(false)
    }
    pub fn is_link(&self) -> bool {
        self.perm.map(|p| p & S_IFMT == S_IFLNK).unwrap_or(false)
    }
}

/// Constructor de paquetes.
struct Pkt(Vec<u8>);
impl Pkt {
    fn new() -> Self {
        Pkt(Vec::with_capacity(64))
    }
    fn u32(mut self, v: u32) -> Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn u64(mut self, v: u64) -> Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn bytes(mut self, b: &[u8]) -> Self {
        self = self.u32(b.len() as u32);
        self.0.extend_from_slice(b);
        self
    }
    fn str(self, s: &str) -> Self {
        self.bytes(s.as_bytes())
    }
    fn attrs(self, a: &Attrs) -> Self {
        let mut f = 0;
        if a.perm.is_some() {
            f |= ATTR_PERM;
        }
        let mut p = self.u32(f);
        if let Some(m) = a.perm {
            p = p.u32(m);
        }
        p
    }
}

/// Lector de un paquete recibido.
pub struct Rd<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> Rd<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Rd { b, i: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.i + n > self.b.len() {
            return Err("sftp: short packet".into());
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    pub fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    pub fn bytes(&mut self) -> Result<&'a [u8], String> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    pub fn string(&mut self) -> Result<String, String> {
        Ok(String::from_utf8_lossy(self.bytes()?).into_owned())
    }
    pub fn attrs(&mut self) -> Result<Attrs, String> {
        let f = self.u32()?;
        let mut a = Attrs::default();
        if f & ATTR_SIZE != 0 {
            a.size = Some(self.u64()?);
        }
        if f & ATTR_UIDGID != 0 {
            self.u32()?;
            self.u32()?;
        }
        if f & ATTR_PERM != 0 {
            a.perm = Some(self.u32()?);
        }
        if f & ATTR_TIME != 0 {
            self.u32()?; // atime
            a.mtime = Some(self.u32()?);
        }
        if f & ATTR_EXT != 0 {
            let n = self.u32()?;
            for _ in 0..n.min(1024) {
                self.bytes()?;
                self.bytes()?;
            }
        }
        Ok(a)
    }
}

/// STATUS -> error legible con prefijo estable.
pub fn status_error(code: u32, msg: &str) -> String {
    match code {
        ST_NO_SUCH_FILE => format!("{E_NOFILE}: {msg}"),
        ST_PERMISSION_DENIED => format!("{E_DENIED}: {msg}"),
        _ => {
            if msg.is_empty() {
                format!("sftp error {code}")
            } else {
                msg.to_string()
            }
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub mtime: u64,
    /// Modo completo (tipo + permisos), como `st_mode`.
    pub perm: u32,
    pub is_dir: bool,
    pub is_link: bool,
}

/// Cliente síncrono: una petición a la vez salvo en las transferencias (ventana de peticiones en vuelo).
pub struct Client<R: Read, W: Write> {
    r: R,
    w: W,
    next: u32,
}

impl<R: Read, W: Write> Client<R, W> {
    pub fn new(r: R, w: W) -> Self {
        Client { r, w, next: 1 }
    }

    fn send_raw(&mut self, typ: u8, body: &[u8]) -> Result<(), String> {
        let len = (body.len() + 1) as u32;
        let mut buf = Vec::with_capacity(body.len() + 5);
        buf.extend_from_slice(&len.to_be_bytes());
        buf.push(typ);
        buf.extend_from_slice(body);
        self.w.write_all(&buf).map_err(io_err)?;
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        self.w.flush().map_err(io_err)
    }

    /// Envía una petición con id nuevo y devuelve el id.
    fn send(&mut self, typ: u8, body: Pkt) -> Result<u32, String> {
        let id = self.next;
        self.next = self.next.wrapping_add(1);
        let mut b = id.to_be_bytes().to_vec();
        b.extend_from_slice(&body.0);
        self.send_raw(typ, &b)?;
        Ok(id)
    }

    /// Lee un paquete: (tipo, carga sin la longitud ni el tipo).
    fn recv_raw(&mut self) -> Result<(u8, Vec<u8>), String> {
        let mut h = [0u8; 4];
        self.r.read_exact(&mut h).map_err(io_err)?;
        let n = u32::from_be_bytes(h) as usize;
        if n == 0 || n > MAX_PACKET {
            return Err("sftp: bad packet length".into());
        }
        let mut b = vec![0u8; n];
        self.r.read_exact(&mut b).map_err(io_err)?;
        let t = b[0];
        b.remove(0);
        Ok((t, b))
    }

    /// Lee la respuesta a una petición: (tipo, id, resto).
    fn recv(&mut self) -> Result<(u8, u32, Vec<u8>), String> {
        let (t, b) = self.recv_raw()?;
        if b.len() < 4 {
            return Err("sftp: short packet".into());
        }
        let id = u32::from_be_bytes(b[0..4].try_into().unwrap());
        Ok((t, id, b[4..].to_vec()))
    }

    fn request(&mut self, typ: u8, body: Pkt) -> Result<(u8, Vec<u8>), String> {
        let id = self.send(typ, body)?;
        self.flush()?;
        let (t, rid, b) = self.recv()?;
        if rid != id {
            return Err("sftp: out-of-order reply".into());
        }
        Ok((t, b))
    }

    fn expect_ok(&mut self, typ: u8, body: Pkt) -> Result<(), String> {
        let (t, b) = self.request(typ, body)?;
        check_status(t, &b)
    }

    pub fn init(&mut self) -> Result<u32, String> {
        self.send_raw(FXP_INIT, &3u32.to_be_bytes())?;
        self.flush()?;
        let (t, b) = self.recv_raw()?;
        if t != FXP_VERSION {
            return Err("sftp: bad version reply".into());
        }
        Rd::new(&b).u32()
    }

    pub fn realpath(&mut self, p: &str) -> Result<String, String> {
        let (t, b) = self.request(FXP_REALPATH, Pkt::new().str(p))?;
        if t == FXP_NAME {
            let mut r = Rd::new(&b);
            if r.u32()? >= 1 {
                return r.string();
            }
            return Err("sftp: empty realpath".into());
        }
        Err(status_of(t, &b))
    }

    fn stat_kind(&mut self, typ: u8, p: &str) -> Result<Option<Attrs>, String> {
        let (t, b) = self.request(typ, Pkt::new().str(p))?;
        if t == FXP_ATTRS {
            return Ok(Some(Rd::new(&b).attrs()?));
        }
        if t == FXP_STATUS {
            let mut r = Rd::new(&b);
            if r.u32()? == ST_NO_SUCH_FILE {
                return Ok(None);
            }
        }
        Err(status_of(t, &b))
    }
    pub fn stat(&mut self, p: &str) -> Result<Option<Attrs>, String> {
        self.stat_kind(FXP_STAT, p)
    }
    pub fn lstat(&mut self, p: &str) -> Result<Option<Attrs>, String> {
        self.stat_kind(FXP_LSTAT, p)
    }

    fn handle(&mut self, typ: u8, body: Pkt) -> Result<Vec<u8>, String> {
        let (t, b) = self.request(typ, body)?;
        if t == FXP_HANDLE {
            return Ok(Rd::new(&b).bytes()?.to_vec());
        }
        Err(status_of(t, &b))
    }

    pub fn close(&mut self, h: &[u8]) -> Result<(), String> {
        self.expect_ok(FXP_CLOSE, Pkt::new().bytes(h))
    }

    /// Lista un directorio (sin `.` ni `..`). Los enlaces simbólicos se resuelven con STAT para saber si son carpeta.
    pub fn readdir(&mut self, dir: &str) -> Result<Vec<Entry>, String> {
        let h = self.handle(FXP_OPENDIR, Pkt::new().str(dir))?;
        let mut out = Vec::new();
        let res = (|| -> Result<(), String> {
            loop {
                let (t, b) = self.request(FXP_READDIR, Pkt::new().bytes(&h))?;
                if t == FXP_STATUS {
                    let mut r = Rd::new(&b);
                    let code = r.u32()?;
                    if code == ST_EOF {
                        return Ok(());
                    }
                    return Err(status_error(code, &r.string().unwrap_or_default()));
                }
                if t != FXP_NAME {
                    return Err("sftp: unexpected reply".into());
                }
                let mut r = Rd::new(&b);
                let n = r.u32()?;
                for _ in 0..n {
                    let name = r.string()?;
                    let _long = r.bytes()?;
                    let a = r.attrs()?;
                    if name == "." || name == ".." || name.is_empty() || name.contains('/') {
                        continue;
                    }
                    if out.len() < MAX_ENTRIES {
                        out.push(Entry {
                            name,
                            size: a.size.unwrap_or(0),
                            mtime: a.mtime.unwrap_or(0) as u64,
                            perm: a.perm.unwrap_or(0),
                            is_dir: a.is_dir(),
                            is_link: a.is_link(),
                        });
                    }
                }
            }
        })();
        let _ = self.close(&h);
        res?;
        for e in out.iter_mut().filter(|e| e.is_link) {
            if let Ok(Some(a)) = self.stat(&join(dir, &e.name)) {
                e.is_dir = a.is_dir();
            }
        }
        Ok(out)
    }

    pub fn mkdir(&mut self, p: &str) -> Result<(), String> {
        self.expect_ok(FXP_MKDIR, Pkt::new().str(p).attrs(&Attrs::default()))
    }
    pub fn rmdir(&mut self, p: &str) -> Result<(), String> {
        self.expect_ok(FXP_RMDIR, Pkt::new().str(p))
    }
    pub fn remove(&mut self, p: &str) -> Result<(), String> {
        self.expect_ok(FXP_REMOVE, Pkt::new().str(p))
    }
    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.expect_ok(FXP_RENAME, Pkt::new().str(from).str(to))
    }

    /// Borra un archivo, un enlace o una carpeta entera (sin seguir enlaces: READDIR da lstat). `count` limita el árbol.
    pub fn remove_tree(&mut self, p: &str, count: &mut usize) -> Result<(), String> {
        let a = self.lstat(p)?.ok_or_else(|| format!("{E_NOFILE}: {p}"))?;
        if !a.is_dir() {
            return self.remove(p);
        }
        for e in self.readdir(p)? {
            *count += 1;
            if *count > MAX_TREE {
                return Err("too many files".into());
            }
            let child = join(p, &e.name);
            if e.is_dir && !e.is_link {
                self.remove_tree(&child, count)?;
            } else {
                self.remove(&child)?;
            }
        }
        self.rmdir(p)
    }

    /// Sube `src` (de `total` bytes) a `remote` con peticiones en vuelo. `tick(bytes)` cuenta lo confirmado.
    /// Si `cancel` se enciende, cierra y borra lo parcial y devuelve `E_CANCEL`.
    pub fn upload(&mut self, src: &mut dyn Read, remote: &str, overwrite: bool, cancel: &AtomicBool, tick: &mut dyn FnMut(u64)) -> Result<(), String> {
        // Sin sobrescribir: se mira antes (el EXCL de algunos servidores solo dice «Failure»).
        if !overwrite && self.lstat(remote)?.is_some() {
            return Err(format!("{E_EXISTS}: {remote}"));
        }
        let flags = FLAG_WRITE | FLAG_CREAT | if overwrite { FLAG_TRUNC } else { FLAG_EXCL };
        let h = self.handle(FXP_OPEN, Pkt::new().str(remote).u32(flags).attrs(&Attrs::default()))?;
        let res = (|| -> Result<(), String> {
            let mut inflight: HashMap<u32, u64> = HashMap::new();
            let mut off = 0u64;
            let mut eof = false;
            let mut buf = vec![0u8; CHUNK as usize];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    // Recoge lo que haya en vuelo para dejar el canal limpio antes de cerrar.
                    while !inflight.is_empty() {
                        let (_, id, _) = self.recv()?;
                        inflight.remove(&id);
                    }
                    return Err(E_CANCEL.into());
                }
                let mut sent = false;
                while !eof && inflight.len() < WINDOW {
                    let n = read_full(src, &mut buf).map_err(io_err)?;
                    if n == 0 {
                        eof = true;
                        break;
                    }
                    let id = self.send(FXP_WRITE, Pkt::new().bytes(&h).u64(off).bytes(&buf[..n]))?;
                    inflight.insert(id, n as u64);
                    off += n as u64;
                    sent = true;
                }
                if sent {
                    self.flush()?;
                }
                if inflight.is_empty() {
                    return Ok(());
                }
                let (t, id, b) = self.recv()?;
                let n = inflight.remove(&id).ok_or("sftp: unexpected reply")?;
                check_status(t, &b)?;
                tick(n);
            }
        })();
        let closed = self.close(&h);
        match res {
            Ok(()) => closed,
            Err(e) => {
                if e == E_CANCEL {
                    let _ = self.remove(remote);
                }
                Err(e)
            }
        }
    }

    /// Descarga `remote` en `dst` (ya abierto) con peticiones en vuelo; soporta respuestas cortas y fuera de orden.
    pub fn download<F: Write + Seek>(&mut self, remote: &str, dst: &mut F, cancel: &AtomicBool, tick: &mut dyn FnMut(u64)) -> Result<u64, String> {
        let size = self.stat(remote)?.and_then(|a| a.size).ok_or_else(|| format!("{E_NOFILE}: {remote}"))?;
        let h = self.handle(FXP_OPEN, Pkt::new().str(remote).u32(FLAG_READ).attrs(&Attrs::default()))?;
        let res = (|| -> Result<u64, String> {
            let mut inflight: HashMap<u32, (u64, u32)> = HashMap::new();
            let mut pending: VecDeque<(u64, u32)> = VecDeque::new();
            let mut next = 0u64;
            let mut got = 0u64;
            let mut end: Option<u64> = None;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    while !inflight.is_empty() {
                        let (_, id, _) = self.recv()?;
                        inflight.remove(&id);
                    }
                    return Err(E_CANCEL.into());
                }
                let mut sent = false;
                while inflight.len() < WINDOW {
                    let req = if let Some(p) = pending.pop_front() {
                        p
                    } else if next < size && end.is_none() {
                        let len = (size - next).min(CHUNK as u64) as u32;
                        let r = (next, len);
                        next += len as u64;
                        r
                    } else {
                        break;
                    };
                    let id = self.send(FXP_READ, Pkt::new().bytes(&h).u64(req.0).u32(req.1))?;
                    inflight.insert(id, req);
                    sent = true;
                }
                if sent {
                    self.flush()?;
                }
                if inflight.is_empty() {
                    return Ok(got);
                }
                let (t, id, b) = self.recv()?;
                let (off, len) = inflight.remove(&id).ok_or("sftp: unexpected reply")?;
                if t == FXP_DATA {
                    let data = Rd::new(&b).bytes()?;
                    let n = data.len().min(len as usize);
                    dst.seek(SeekFrom::Start(off)).map_err(io_err)?;
                    dst.write_all(&data[..n]).map_err(io_err)?;
                    got += n as u64;
                    tick(n as u64);
                    if n > 0 && (n as u32) < len {
                        pending.push_back((off + n as u64, len - n as u32));
                    }
                } else if t == FXP_STATUS {
                    let mut r = Rd::new(&b);
                    let code = r.u32()?;
                    if code == ST_EOF {
                        // El archivo encogió mientras se leía: lo que falta no existe.
                        end = Some(end.map_or(off, |e| e.min(off)));
                        pending.retain(|p| p.0 < off);
                    } else {
                        return Err(status_error(code, &r.string().unwrap_or_default()));
                    }
                } else {
                    return Err("sftp: unexpected reply".into());
                }
            }
        })();
        let _ = self.close(&h);
        res
    }
}

fn check_status(t: u8, b: &[u8]) -> Result<(), String> {
    if t != FXP_STATUS {
        return Err("sftp: unexpected reply".into());
    }
    let mut r = Rd::new(b);
    let code = r.u32()?;
    if code == ST_OK {
        return Ok(());
    }
    Err(status_error(code, &r.string().unwrap_or_default()))
}

fn status_of(t: u8, b: &[u8]) -> String {
    match check_status(t, b) {
        Err(e) => e,
        Ok(()) => "sftp: unexpected reply".into(),
    }
}

fn io_err(e: std::io::Error) -> String {
    format!("io: {e}")
}

/// `read` que llena el búfer salvo al final (archivos y tuberías devuelven trozos cortos).
fn read_full(src: &mut dyn Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match src.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

// ---------- rutas remotas (POSIX, puras) ----------

/// Une carpeta y nombre con una sola `/`.
pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Nombre válido para crear en el servidor: sin `/`, sin NUL, no `.` ni `..`, ≤ 255 bytes.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 255 && n != "." && n != ".." && !n.contains('/') && !n.contains('\0')
}

/// Ruta pedida -> ruta que entiende el servidor: vacío o `~` = home; `~/x` = home/x.
pub fn expand_home(p: &str, home: &str) -> String {
    let p = p.trim();
    if p.is_empty() || p == "~" {
        return home.to_string();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return join(home, rest);
    }
    p.to_string()
}

/// `nombre (1).ext`, `nombre (2).ext`… el primero que `exists` diga que no existe (para descargas locales).
pub fn unique_local(dir: &Path, name: &str, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for k in 1..10_000 {
        let p = dir.join(format!("{stem} ({k}){ext}"));
        if !exists(&p) {
            return p;
        }
    }
    dir.join(format!("{stem} ({}){ext}", crate::history::now_secs()))
}

/// Nombre local seguro de un archivo remoto (Windows no admite `<>:"/\|?*` ni nombres reservados).
pub fn local_name(remote_name: &str) -> String {
    let mut s: String = remote_name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    s = s.trim_end_matches([' ', '.']).to_string();
    if s.is_empty() {
        s = "download".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"];
    if reserved.contains(&stem.as_str()) {
        s = format!("_{s}");
    }
    s
}

// ---------- conexión (ssh -s sftp) ----------

/// Argumentos de `ssh` para el subsistema: los de `base_args` con `-s` antes de `--` y `sftp` tras el destino.
pub fn sftp_args(d: &Dest) -> Vec<String> {
    let mut a = base_args(d);
    let pos = a.iter().position(|x| x == "--").unwrap_or(a.len());
    a.insert(pos, "-s".into());
    a.push("sftp".into());
    a
}

/// Error de ssh (stderr + código) -> error con prefijo estable.
pub fn ssh_error(stderr: &str, code: Option<i32>) -> String {
    let (k, msg) = classify(stderr, code, false);
    match k {
        Kind::HostKey => format!("{E_HOSTKEY}: {msg}"),
        Kind::Auth => format!("{E_AUTH}: {msg}"),
        Kind::Network => format!("{E_NET}: {msg}"),
        _ => {
            let low = stderr.to_ascii_lowercase();
            if low.contains("subsystem request failed") {
                "SFTP is not enabled on this server".into()
            } else {
                msg
            }
        }
    }
}

pub type SshClient = Client<Box<dyn Read + Send>, Box<dyn Write + Send>>;

/// Un proceso `ssh` con su cliente. Matar el hijo corta cualquier operación en curso.
pub struct Conn {
    pub cli: SshClient,
    child: Arc<Mutex<Child>>,
    stderr: Arc<Mutex<String>>,
    err_done: Arc<AtomicBool>,
    pub home: String,
    pub last: Instant,
}

impl Conn {
    pub fn open(d: &Dest) -> Result<Conn, String> {
        d.validate()?;
        let mut c = Command::new("ssh");
        for (k, v) in build_env(d) {
            c.env(k, v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        c.args(sftp_args(d)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = c.spawn().map_err(|e| format!("could not run ssh: {e}"))?;
        let stdin: Box<dyn Write + Send> = Box::new(child.stdin.take().ok_or("no stdin")?);
        let stdout: Box<dyn Read + Send> = Box::new(child.stdout.take().ok_or("no stdout")?);
        let err_buf = Arc::new(Mutex::new(String::new()));
        // Se marca al cerrarse stderr (ssh terminó): hasta entonces lo leído puede estar a medias.
        let err_done = Arc::new(AtomicBool::new(false));
        if let Some(mut se) = child.stderr.take() {
            let (eb, ed) = (err_buf.clone(), err_done.clone());
            std::thread::spawn(move || {
                let mut b = [0u8; 1024];
                while let Ok(n) = se.read(&mut b) {
                    if n == 0 {
                        break;
                    }
                    let mut g = eb.lock();
                    if g.len() < 8192 {
                        g.push_str(&String::from_utf8_lossy(&b[..n]));
                    }
                }
                ed.store(true, Ordering::Relaxed);
            });
        } else {
            err_done.store(true, Ordering::Relaxed);
        }
        let child = Arc::new(Mutex::new(child));
        // Vigilante: si en 40 s no hay sesión (login colgado), se mata el hijo.
        let ready = Arc::new(AtomicBool::new(false));
        {
            let (ch, rd) = (child.clone(), ready.clone());
            std::thread::spawn(move || {
                let end = Instant::now() + Duration::from_secs(40);
                while Instant::now() < end {
                    if rd.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                let _ = ch.lock().kill();
            });
        }
        let mut cli = Client::new(stdout, stdin);
        let started = cli.init().and_then(|_| cli.realpath("."));
        ready.store(true, Ordering::Relaxed);
        match started {
            Ok(home) => Ok(Conn { cli, child, stderr: err_buf, err_done, home, last: Instant::now() }),
            Err(e) => Err(why_failed(&child, &err_buf, &err_done, e)),
        }
    }

    pub fn killer(&self) -> Arc<Mutex<Child>> {
        self.child.clone()
    }

    /// Error de una operación: si fue la tubería (ssh murió), lo que dijo ssh explica mejor por qué.
    pub fn explain(&self, e: String) -> String {
        why_failed(&self.child, &self.stderr, &self.err_done, e)
    }
}

/// Un error de tubería (`io:`) dice poco: se espera a que ssh acabe y a leer todo su stderr, que explica el porqué.
fn why_failed(child: &Arc<Mutex<Child>>, stderr: &Mutex<String>, done: &AtomicBool, e: String) -> String {
    if !e.starts_with("io:") {
        return e;
    }
    let code = wait_code(child);
    let end = Instant::now() + Duration::from_secs(1);
    while !done.load(Ordering::Relaxed) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    let se = stderr.lock().clone();
    if !se.trim().is_empty() {
        return ssh_error(&se, code);
    }
    match code {
        Some(c) => format!("{E_NET}: ssh exited with code {c}"),
        None => format!("{E_NET}: connection lost"),
    }
}

fn wait_code(child: &Arc<Mutex<Child>>) -> Option<i32> {
    let end = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(Some(st)) = child.lock().try_wait() {
            return st.code();
        }
        if Instant::now() >= end {
            let _ = child.lock().kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        let mut c = self.child.lock();
        let _ = c.kill();
        let _ = c.wait();
    }
}

// ---------- gestor (estado de Tauri) ----------

struct Xfer {
    cancel: Arc<AtomicBool>,
    child: Mutex<Option<Arc<Mutex<Child>>>>,
}

#[derive(Default)]
pub struct Manager {
    conns: Mutex<HashMap<String, Arc<Mutex<Option<Conn>>>>>,
    xfers: Mutex<HashMap<String, Arc<Xfer>>>,
}

/// Una conexión sin uso más de esto se cierra.
const IDLE: Duration = Duration::from_secs(300);

impl Manager {
    /// Ejecuta `f` con la conexión viva del destino (la abre si hace falta; si murió, reintenta una vez).
    pub fn with<T>(&self, d: &Dest, f: impl Fn(&mut Conn) -> Result<T, String>) -> Result<T, String> {
        d.validate()?;
        self.reap();
        let slot = self.conns.lock().entry(d.key()).or_default().clone();
        let mut g = slot.lock();
        for attempt in 0..2 {
            if g.is_none() {
                *g = Some(Conn::open(d)?);
            }
            let c = g.as_mut().unwrap();
            c.last = Instant::now();
            match f(c) {
                Ok(v) => return Ok(v),
                Err(e) if e.starts_with("io:") => {
                    let e = c.explain(e);
                    *g = None;
                    if attempt == 1 || !e.starts_with(E_NET) {
                        return Err(e);
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Err(format!("{E_NET}: connection lost"))
    }

    fn reap(&self) {
        let now = Instant::now();
        let m = self.conns.lock();
        for slot in m.values() {
            if let Some(mut g) = slot.try_lock() {
                if g.as_ref().is_some_and(|c| now.duration_since(c.last) > IDLE) {
                    *g = None;
                }
            }
        }
    }

    pub fn shutdown(&self) {
        for x in self.xfers.lock().values() {
            x.cancel.store(true, Ordering::Relaxed);
            if let Some(c) = x.child.lock().as_ref() {
                let _ = c.lock().kill();
            }
        }
        self.conns.lock().clear();
    }

    fn register(&self, id: &str) -> Arc<Xfer> {
        let x = Arc::new(Xfer { cancel: Arc::new(AtomicBool::new(false)), child: Mutex::new(None) });
        self.xfers.lock().insert(id.to_string(), x.clone());
        x
    }

    pub fn cancel(&self, id: &str) {
        let x = self.xfers.lock().get(id).cloned();
        if let Some(x) = x {
            x.cancel.store(true, Ordering::Relaxed);
            // Si en 3 s no se ha cerrado sola (red parada), se mata su ssh.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                if let Some(c) = x.child.lock().as_ref() {
                    let _ = c.lock().kill();
                }
            });
        }
    }
}

// ---------- transferencias ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub done: u64,
    pub total: u64,
    /// `run` | `done` | `error` | `cancelled`
    pub state: String,
    pub error: Option<String>,
    /// Al acabar una descarga: ruta local final.
    pub path: Option<String>,
}

/// Lista de archivos de una carpeta local (recursiva): (ruta local, ruta relativa con `/`, tamaño) y carpetas relativas.
pub fn walk_local(root: &Path) -> Result<(Vec<(PathBuf, String, u64)>, Vec<String>), String> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((p, rel)) = stack.pop() {
        let rd = std::fs::read_dir(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        for ent in rd.flatten() {
            if files.len() + dirs.len() > MAX_TREE {
                return Err("too many files".into());
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(ft) = ent.file_type() else { continue };
            if ft.is_symlink() {
                continue; // no se siguen enlaces locales
            }
            if ft.is_dir() {
                dirs.push(r.clone());
                stack.push((ent.path(), r));
            } else if ft.is_file() {
                let len = ent.metadata().map(|m| m.len()).unwrap_or(0);
                files.push((ent.path(), r, len));
            }
        }
    }
    dirs.sort();
    Ok((files, dirs))
}

/// Emisor con freno: como mucho un aviso de progreso cada 120 ms (el último siempre sale).
struct Ticker<'a> {
    p: Progress,
    last: Instant,
    emit: &'a mut dyn FnMut(&Progress),
}
impl<'a> Ticker<'a> {
    fn add(&mut self, n: u64) {
        self.p.done += n;
        if self.last.elapsed() >= Duration::from_millis(120) {
            self.last = Instant::now();
            (self.emit)(&self.p);
        }
    }
}

/// Sube `local` (archivo o carpeta) a `remote_dir/name` por una conexión propia. Bloquea hasta acabar.
pub fn run_upload(conn: &mut Conn, local: &Path, remote_dir: &str, name: &str, overwrite: bool, cancel: &AtomicBool, emit: &mut dyn FnMut(&Progress), id: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("invalid name".into());
    }
    let target = join(remote_dir, name);
    let md = std::fs::metadata(local).map_err(|e| format!("{}: {e}", local.display()))?;
    if md.is_dir() {
        let (files, dirs) = walk_local(local)?;
        let total: u64 = files.iter().map(|f| f.2).sum();
        let mut tk = Ticker { p: Progress { id: id.into(), total, state: "run".into(), ..Default::default() }, last: Instant::now(), emit };
        (tk.emit)(&tk.p);
        match conn.cli.stat(&target)? {
            Some(a) if a.is_dir() => {}
            Some(_) => return Err(format!("{E_EXISTS}: {target}")),
            None => conn.cli.mkdir(&target)?,
        }
        for d in &dirs {
            let p = join(&target, d);
            if conn.cli.stat(&p)?.is_none() {
                conn.cli.mkdir(&p)?;
            }
        }
        for (lp, rel, _) in &files {
            let mut f = std::fs::File::open(lp).map_err(|e| format!("{}: {e}", lp.display()))?;
            conn.cli.upload(&mut f, &join(&target, rel), true, cancel, &mut |n| tk.add(n))?;
        }
        return Ok(());
    }
    let mut f = std::fs::File::open(local).map_err(|e| format!("{}: {e}", local.display()))?;
    let mut tk = Ticker { p: Progress { id: id.into(), total: md.len(), state: "run".into(), ..Default::default() }, last: Instant::now(), emit };
    (tk.emit)(&tk.p);
    conn.cli.upload(&mut f, &target, overwrite, cancel, &mut |n| tk.add(n))
}

/// Descarga `remote` a `local_dir` con nombre único. Devuelve la ruta local. Si falla o se cancela, borra lo parcial.
pub fn run_download(conn: &mut Conn, remote: &str, local_dir: &Path, cancel: &AtomicBool, emit: &mut dyn FnMut(&Progress), id: &str) -> Result<PathBuf, String> {
    let a = conn.cli.stat(remote)?.ok_or_else(|| format!("{E_NOFILE}: {remote}"))?;
    if a.is_dir() {
        return Err("folders can't be downloaded yet".into());
    }
    let base = remote.rsplit('/').next().unwrap_or(remote);
    std::fs::create_dir_all(local_dir).map_err(|e| e.to_string())?;
    let path = unique_local(local_dir, &local_name(base), &|p| p.exists());
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut tk = Ticker { p: Progress { id: id.into(), total: a.size.unwrap_or(0), state: "run".into(), ..Default::default() }, last: Instant::now(), emit };
    (tk.emit)(&tk.p);
    let r = conn.cli.download(remote, &mut f, cancel, &mut |n| tk.add(n)).and_then(|_| f.flush().map_err(io_err));
    drop(f);
    match r {
        Ok(()) => Ok(path),
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

// ---------- comandos de Tauri ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub home: String,
    pub entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatInfo {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command(async)]
pub fn sftp_list(m: tauri::State<'_, Arc<Manager>>, dest: Dest, path: String) -> Result<Listing, String> {
    m.with(&dest, |c| {
        let p = expand_home(&path, &c.home);
        let real = c.cli.realpath(&p)?;
        let entries = c.cli.readdir(&real)?;
        Ok(Listing { path: real, home: c.home.clone(), entries })
    })
}

#[tauri::command(async)]
pub fn sftp_stat(m: tauri::State<'_, Arc<Manager>>, dest: Dest, path: String) -> Result<StatInfo, String> {
    m.with(&dest, |c| {
        Ok(match c.cli.stat(&path)? {
            Some(a) => StatInfo { exists: true, is_dir: a.is_dir(), size: a.size.unwrap_or(0) },
            None => StatInfo { exists: false, is_dir: false, size: 0 },
        })
    })
}

#[tauri::command(async)]
pub fn sftp_mkdir(m: tauri::State<'_, Arc<Manager>>, dest: Dest, dir: String, name: String) -> Result<String, String> {
    if !valid_name(&name) {
        return Err("invalid name".into());
    }
    m.with(&dest, |c| {
        let p = join(&dir, &name);
        if c.cli.lstat(&p)?.is_some() {
            return Err(format!("{E_EXISTS}: {p}"));
        }
        c.cli.mkdir(&p)?;
        Ok(p)
    })
}

#[tauri::command(async)]
pub fn sftp_rename(m: tauri::State<'_, Arc<Manager>>, dest: Dest, dir: String, from: String, to: String) -> Result<(), String> {
    if !valid_name(&from) || !valid_name(&to) {
        return Err("invalid name".into());
    }
    m.with(&dest, |c| {
        let target = join(&dir, &to);
        if c.cli.lstat(&target)?.is_some() {
            return Err(format!("{E_EXISTS}: {target}"));
        }
        c.cli.rename(&join(&dir, &from), &target)
    })
}

#[tauri::command(async)]
pub fn sftp_remove(m: tauri::State<'_, Arc<Manager>>, dest: Dest, dir: String, names: Vec<String>) -> Result<(), String> {
    if names.is_empty() || names.iter().any(|n| !valid_name(n)) {
        return Err("invalid name".into());
    }
    m.with(&dest, |c| {
        let mut count = 0usize;
        for n in &names {
            c.cli.remove_tree(&join(&dir, n), &mut count)?;
        }
        Ok(())
    })
}

/// Lanza una transferencia en su hilo y conexión. El progreso llega por el evento `sftp-progress`.
/// Una transferencia completa en el hilo que llama: conexión propia, trabajo, estado final. `emit` recibe todos los avisos.
pub type Job = Box<dyn FnOnce(&mut Conn, &AtomicBool, &mut dyn FnMut(&Progress)) -> Result<Option<String>, String> + Send>;

pub fn run_xfer(m: &Manager, id: &str, dest: &Dest, job: Job, emit: &dyn Fn(&Progress)) -> Progress {
    let x = m.register(id);
    let mut last = Progress { id: id.to_string(), state: "run".into(), ..Default::default() };
    let res = match Conn::open(dest) {
        Err(e) => Err(e),
        Ok(mut conn) => {
            *x.child.lock() = Some(conn.killer());
            let mut track = |p: &Progress| {
                last = p.clone();
                emit(p);
            };
            let r = job(&mut conn, &x.cancel, &mut track).map_err(|e| conn.explain(e));
            r
        }
    };
    let cancelled = x.cancel.load(Ordering::Relaxed);
    let mut fin = last;
    match res {
        Ok(path) => {
            fin.state = "done".into();
            fin.done = fin.done.max(fin.total);
            fin.path = path;
        }
        Err(_) if cancelled => fin.state = "cancelled".into(),
        Err(e) => {
            fin.state = "error".into();
            fin.error = Some(e);
        }
    }
    emit(&fin);
    m.xfers.lock().remove(id);
    fin
}

/// Lanza una transferencia en su hilo y conexión. El progreso llega por el evento `sftp-progress`.
fn spawn_xfer(app: tauri::AppHandle, m: Arc<Manager>, id: String, dest: Dest, job: Job) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        run_xfer(&m, &id, &dest, job, &|p: &Progress| {
            let _ = app.emit("sftp-progress", p.clone());
        });
    });
}

fn xfer_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub fn sftp_upload(app: tauri::AppHandle, m: tauri::State<'_, Arc<Manager>>, id: String, dest: Dest, local: String, dir: String, name: String, overwrite: bool) -> Result<(), String> {
    dest.validate()?;
    if !xfer_id_ok(&id) || !valid_name(&name) {
        return Err("invalid request".into());
    }
    let id2 = id.clone();
    spawn_xfer(app, m.inner().clone(), id, dest, Box::new(move |c, cancel, emit| {
        run_upload(c, Path::new(&local), &dir, &name, overwrite, cancel, emit, &id2).map(|_| None)
    }));
    Ok(())
}

/// Carpeta de descargas por defecto.
fn downloads(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager as _;
    app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir())
}

#[tauri::command]
pub fn sftp_download(app: tauri::AppHandle, m: tauri::State<'_, Arc<Manager>>, id: String, dest: Dest, remote: String, local_dir: Option<String>) -> Result<(), String> {
    dest.validate()?;
    if !xfer_id_ok(&id) || remote.is_empty() {
        return Err("invalid request".into());
    }
    let dir = match local_dir.filter(|s| !s.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => downloads(&app),
    };
    let id2 = id.clone();
    spawn_xfer(app, m.inner().clone(), id, dest, Box::new(move |c, cancel, emit| {
        run_download(c, &remote, &dir, cancel, emit, &id2).map(|p| Some(p.to_string_lossy().into_owned()))
    }));
    Ok(())
}

#[tauri::command]
pub fn sftp_cancel(m: tauri::State<'_, Arc<Manager>>, id: String) {
    m.cancel(&id);
}

#[tauri::command]
pub fn sftp_downloads_dir(app: tauri::AppHandle) -> String {
    downloads(&app).to_string_lossy().into_owned()
}

/// Diálogo nativo para elegir archivos que subir (o una carpeta de descargas con `folder`). Se llama desde Rust: la
/// página no necesita permisos del plugin.
#[tauri::command(async)]
pub fn sftp_pick(app: tauri::AppHandle, folder: bool) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let d = app.dialog().file();
    if folder {
        d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| vec![p.to_string_lossy().into_owned()]).unwrap_or_default()
    } else {
        d.blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }
}

/// Abre el Explorador con el archivo descargado seleccionado (o la carpeta).
#[tauri::command]
pub fn sftp_reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.exists() {
        return Err("not found".into());
    }
    let mut c = Command::new("explorer.exe");
    if p.is_file() {
        c.arg(format!("/select,{}", p.display()));
    } else {
        c.arg(&p);
    }
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "sftp_tests.rs"]
mod tests;
