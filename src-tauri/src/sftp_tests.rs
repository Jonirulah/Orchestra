// Pruebas del cliente SFTP contra un servidor FALSO en memoria (mismo protocolo v3 que OpenSSH sftp-server):
// respuestas fuera de orden, lecturas cortas, directorios por páginas, errores de estado y cancelación.
// La prueba contra un servidor REAL (`ssh` + sshd) está en `real_server` (ignorada: necesita ORCH_SFTP_TEST).
use super::*;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};

struct PipeR {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}
impl PipeR {
    /// ¿Hay datos ya listos sin bloquear?
    fn ready(&mut self) -> bool {
        if self.pos < self.buf.len() {
            return true;
        }
        match self.rx.try_recv() {
            Ok(b) => {
                self.buf = b;
                self.pos = 0;
                true
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => false,
        }
    }
}
impl Read for PipeR {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(b) => {
                    self.buf = b;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}
struct PipeW(Sender<Vec<u8>>);
impl Write for PipeW {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.send(b.to_vec()).map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
enum Node {
    Dir,
    File(Vec<u8>),
}

/// Servidor falso. `short` = tope de bytes por DATA (lecturas cortas). Las respuestas de cada ráfaga salen AL REVÉS.
fn fake_server(mut fs: HashMap<String, Node>, short: usize, page: usize) -> (Client<PipeR, PipeW>, std::thread::JoinHandle<HashMap<String, Node>>) {
    let (ctx, srx) = channel::<Vec<u8>>();
    let (stx, crx) = channel::<Vec<u8>>();
    let h = std::thread::spawn(move || {
        let mut r = PipeR { rx: srx, buf: vec![], pos: 0 };
        let mut w = PipeW(stx);
        let mut handles: HashMap<Vec<u8>, (String, usize)> = HashMap::new(); // ruta, posición de readdir
        let mut nh = 0u32;
        let mut queued: Vec<Vec<u8>> = vec![];
        let send = |q: &mut Vec<Vec<u8>>, t: u8, body: Vec<u8>| {
            let mut b = ((body.len() + 1) as u32).to_be_bytes().to_vec();
            b.push(t);
            b.extend(body);
            q.push(b);
        };
        let status = |id: u32, code: u32, msg: &str| -> Vec<u8> {
            let mut b = id.to_be_bytes().to_vec();
            b.extend(code.to_be_bytes());
            b.extend((msg.len() as u32).to_be_bytes());
            b.extend(msg.as_bytes());
            b.extend(0u32.to_be_bytes());
            b
        };
        let attrs = |n: &Node| -> Vec<u8> {
            let mut b = (ATTR_SIZE | ATTR_PERM | ATTR_TIME).to_be_bytes().to_vec();
            let (size, perm) = match n {
                Node::Dir => (4096u64, S_IFDIR | 0o755),
                Node::File(d) => (d.len() as u64, 0o100644),
            };
            b.extend(size.to_be_bytes());
            b.extend(perm.to_be_bytes());
            b.extend(1_700_000_000u32.to_be_bytes());
            b.extend(1_700_000_000u32.to_be_bytes());
            b
        };
        let s = |x: &str| -> Vec<u8> {
            let mut b = (x.len() as u32).to_be_bytes().to_vec();
            b.extend(x.as_bytes());
            b
        };
        loop {
            let mut hdr = [0u8; 4];
            if r.read_exact(&mut hdr).is_err() {
                break;
            }
            let n = u32::from_be_bytes(hdr) as usize;
            let mut p = vec![0u8; n];
            if r.read_exact(&mut p).is_err() {
                break;
            }
            let t = p[0];
            if t == FXP_INIT {
                send(&mut queued, FXP_VERSION, 3u32.to_be_bytes().to_vec());
            } else {
                let mut rd = Rd::new(&p[1..]);
                let id = rd.u32().unwrap();
                let idb = id.to_be_bytes().to_vec();
                match t {
                    FXP_REALPATH => {
                        let path = rd.string().unwrap();
                        let real = if path == "." { "/home/u".to_string() } else { path.trim_end_matches('/').to_string() };
                        if fs.contains_key(&real) {
                            let mut b = idb.clone();
                            b.extend(1u32.to_be_bytes());
                            b.extend(s(&real));
                            b.extend(s(&real));
                            b.extend(0u32.to_be_bytes());
                            send(&mut queued, FXP_NAME, b);
                        } else {
                            send(&mut queued, FXP_STATUS, status(id, ST_NO_SUCH_FILE, "No such file"));
                        }
                    }
                    FXP_STAT | FXP_LSTAT => {
                        let path = rd.string().unwrap();
                        match fs.get(&path) {
                            Some(nd) => {
                                let mut b = idb.clone();
                                b.extend(attrs(nd));
                                send(&mut queued, FXP_ATTRS, b);
                            }
                            None => send(&mut queued, FXP_STATUS, status(id, ST_NO_SUCH_FILE, "No such file")),
                        }
                    }
                    FXP_OPENDIR | FXP_OPEN => {
                        let path = rd.string().unwrap();
                        let ok = if t == FXP_OPENDIR {
                            matches!(fs.get(&path), Some(Node::Dir))
                        } else {
                            let fl = rd.u32().unwrap();
                            if fl & FLAG_WRITE != 0 {
                                if fl & FLAG_EXCL != 0 && fs.contains_key(&path) {
                                    false
                                } else {
                                    if fl & FLAG_TRUNC != 0 || !fs.contains_key(&path) {
                                        fs.insert(path.clone(), Node::File(vec![]));
                                    }
                                    true
                                }
                            } else {
                                matches!(fs.get(&path), Some(Node::File(_)))
                            }
                        };
                        if ok {
                            nh += 1;
                            let hd = format!("h{nh}").into_bytes();
                            handles.insert(hd.clone(), (path, 0));
                            let mut b = idb.clone();
                            b.extend((hd.len() as u32).to_be_bytes());
                            b.extend(hd);
                            send(&mut queued, FXP_HANDLE, b);
                        } else {
                            send(&mut queued, FXP_STATUS, status(id, ST_NO_SUCH_FILE, "No such file"));
                        }
                    }
                    FXP_READDIR => {
                        let hd = rd.bytes().unwrap().to_vec();
                        let (dir, pos) = handles.get(&hd).cloned().unwrap();
                        let mut kids: Vec<(String, Node)> = fs
                            .iter()
                            .filter(|(k, _)| k.starts_with(&format!("{dir}/")) && !k[dir.len() + 1..].contains('/'))
                            .map(|(k, v)| (k[dir.len() + 1..].to_string(), v.clone()))
                            .collect();
                        kids.sort_by(|a, b| a.0.cmp(&b.0));
                        if pos == 0 {
                            kids.insert(0, (".".into(), Node::Dir));
                            kids.insert(1, ("..".into(), Node::Dir));
                        } else {
                            kids.insert(0, (".".into(), Node::Dir));
                            kids.insert(1, ("..".into(), Node::Dir));
                        }
                        let slice: Vec<_> = kids.iter().skip(pos).take(page).cloned().collect();
                        if slice.is_empty() {
                            send(&mut queued, FXP_STATUS, status(id, ST_EOF, "EOF"));
                        } else {
                            handles.get_mut(&hd).unwrap().1 = pos + slice.len();
                            let mut b = idb.clone();
                            b.extend((slice.len() as u32).to_be_bytes());
                            for (name, nd) in &slice {
                                b.extend(s(name));
                                b.extend(s(&format!("-rw-r--r-- 1 u u 0 Jan 1 00:00 {name}")));
                                b.extend(attrs(nd));
                            }
                            send(&mut queued, FXP_NAME, b);
                        }
                    }
                    FXP_READ => {
                        let hd = rd.bytes().unwrap().to_vec();
                        let off = rd.u64().unwrap() as usize;
                        let len = rd.u32().unwrap() as usize;
                        let path = handles[&hd].0.clone();
                        let Some(Node::File(d)) = fs.get(&path) else { panic!() };
                        if off >= d.len() {
                            send(&mut queued, FXP_STATUS, status(id, ST_EOF, "EOF"));
                        } else {
                            let end = d.len().min(off + len.min(short));
                            let mut b = idb.clone();
                            b.extend(((end - off) as u32).to_be_bytes());
                            b.extend(&d[off..end]);
                            send(&mut queued, FXP_DATA, b);
                        }
                    }
                    FXP_WRITE => {
                        let hd = rd.bytes().unwrap().to_vec();
                        let off = rd.u64().unwrap() as usize;
                        let data = rd.bytes().unwrap().to_vec();
                        let path = handles[&hd].0.clone();
                        if let Some(Node::File(d)) = fs.get_mut(&path) {
                            if d.len() < off + data.len() {
                                d.resize(off + data.len(), 0);
                            }
                            d[off..off + data.len()].copy_from_slice(&data);
                        }
                        send(&mut queued, FXP_STATUS, status(id, ST_OK, ""));
                    }
                    FXP_CLOSE => {
                        let hd = rd.bytes().unwrap().to_vec();
                        handles.remove(&hd);
                        send(&mut queued, FXP_STATUS, status(id, ST_OK, ""));
                    }
                    FXP_MKDIR => {
                        let path = rd.string().unwrap();
                        if fs.contains_key(&path) {
                            send(&mut queued, FXP_STATUS, status(id, 4, "Failure"));
                        } else {
                            fs.insert(path, Node::Dir);
                            send(&mut queued, FXP_STATUS, status(id, ST_OK, ""));
                        }
                    }
                    FXP_REMOVE | FXP_RMDIR => {
                        let path = rd.string().unwrap();
                        let has_kids = fs.keys().any(|k| k.starts_with(&format!("{path}/")));
                        let ok = match fs.get(&path) {
                            Some(Node::Dir) => t == FXP_RMDIR && !has_kids,
                            Some(Node::File(_)) => t == FXP_REMOVE,
                            None => false,
                        };
                        if ok {
                            fs.remove(&path);
                            send(&mut queued, FXP_STATUS, status(id, ST_OK, ""));
                        } else if path.contains("locked") {
                            send(&mut queued, FXP_STATUS, status(id, ST_PERMISSION_DENIED, "Permission denied"));
                        } else {
                            send(&mut queued, FXP_STATUS, status(id, 4, "Failure"));
                        }
                    }
                    FXP_RENAME => {
                        let a = rd.string().unwrap();
                        let b2 = rd.string().unwrap();
                        match fs.remove(&a) {
                            Some(nd) => {
                                fs.insert(b2, nd);
                                send(&mut queued, FXP_STATUS, status(id, ST_OK, ""));
                            }
                            None => send(&mut queued, FXP_STATUS, status(id, ST_NO_SUCH_FILE, "No such file")),
                        }
                    }
                    _ => send(&mut queued, FXP_STATUS, status(id, 8, "Unsupported")),
                }
            }
            if !r.ready() {
                for b in queued.drain(..).rev() {
                    if w.write_all(&b).is_err() {
                        return fs;
                    }
                }
            }
        }
        fs
    });
    (Client::new(PipeR { rx: crx, buf: vec![], pos: 0 }, PipeW(ctx)), h)
}

fn base_fs() -> HashMap<String, Node> {
    let mut fs = HashMap::new();
    fs.insert("/home/u".into(), Node::Dir);
    fs.insert("/home/u/docs".into(), Node::Dir);
    fs.insert("/home/u/docs/a b.txt".into(), Node::File(b"hola".to_vec()));
    fs.insert("/home/u/z.bin".into(), Node::File(vec![7; 100]));
    fs.insert("/home/u/.hidden".into(), Node::File(vec![]));
    fs
}

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 31 % 251) as u8).collect()
}

#[test]
fn init_realpath_and_readdir_in_pages() {
    let (mut c, _h) = fake_server(base_fs(), usize::MAX, 2);
    assert_eq!(c.init().unwrap(), 3);
    assert_eq!(c.realpath(".").unwrap(), "/home/u");
    let mut e = c.readdir("/home/u").unwrap();
    e.sort_by(|a, b| a.name.cmp(&b.name));
    let names: Vec<_> = e.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, [".hidden", "docs", "z.bin"]);
    assert!(e[1].is_dir);
    assert_eq!(e[2].size, 100);
    assert_eq!(e[2].perm & 0o777, 0o644);
    assert_eq!(e[2].mtime, 1_700_000_000);
}

#[test]
fn stat_missing_is_none_and_errors_are_prefixed() {
    let (mut c, _h) = fake_server(base_fs(), usize::MAX, 50);
    c.init().unwrap();
    assert!(c.stat("/nope").unwrap().is_none());
    assert!(c.stat("/home/u/docs").unwrap().unwrap().is_dir());
    let e = c.readdir("/nope").unwrap_err();
    assert!(e.starts_with(E_NOFILE), "{e}");
    let mut fs = base_fs();
    fs.insert("/home/u/locked".into(), Node::Dir);
    fs.insert("/home/u/locked/x".into(), Node::File(vec![]));
    let (mut c, _h) = fake_server(fs, usize::MAX, 50);
    c.init().unwrap();
    let e = c.rmdir("/home/u/locked").unwrap_err();
    assert!(e.starts_with(E_DENIED), "{e}");
}

#[test]
fn upload_pipelined_roundtrip_out_of_order() {
    let (mut c, h) = fake_server(base_fs(), usize::MAX, 50);
    c.init().unwrap();
    let data = pattern(CHUNK as usize * 70 + 123); // más que la ventana: varias ráfagas
    let mut acked = 0u64;
    let cancel = AtomicBool::new(false);
    c.upload(&mut &data[..], "/home/u/up.bin", false, &cancel, &mut |n| acked += n).unwrap();
    assert_eq!(acked, data.len() as u64);
    // Sin sobrescribir: ya existe.
    let e = c.upload(&mut &b"x"[..], "/home/u/up.bin", false, &cancel, &mut |_| {}).unwrap_err();
    assert!(e.starts_with(E_EXISTS), "{e}");
    // Sobrescribir trunca.
    c.upload(&mut &b"corto"[..], "/home/u/z.bin", true, &cancel, &mut |_| {}).unwrap();
    drop(c);
    let fs = h.join().unwrap();
    match &fs["/home/u/up.bin"] {
        Node::File(d) => assert!(d == &data),
        _ => panic!(),
    }
    match &fs["/home/u/z.bin"] {
        Node::File(d) => assert_eq!(d, b"corto"),
        _ => panic!(),
    }
}

#[test]
fn download_with_short_reads_and_reordering() {
    let mut fs = base_fs();
    let data = pattern(CHUNK as usize * 3 + 999);
    fs.insert("/home/u/big".into(), Node::File(data.clone()));
    // Cada DATA trae como mucho 10 000 bytes: el cliente tiene que pedir el resto.
    let (mut c, _h) = fake_server(fs, 10_000, 50);
    c.init().unwrap();
    let mut out = std::io::Cursor::new(Vec::new());
    let mut ticks = 0u64;
    let cancel = AtomicBool::new(false);
    let n = c.download("/home/u/big", &mut out, &cancel, &mut |k| ticks += k).unwrap();
    assert_eq!(n, data.len() as u64);
    assert_eq!(ticks, n);
    assert!(out.into_inner() == data);
    // Archivo vacío.
    let mut out = std::io::Cursor::new(Vec::new());
    assert_eq!(c.download("/home/u/.hidden", &mut out, &cancel, &mut |_| {}).unwrap(), 0);
}

#[test]
fn cancelled_upload_removes_partial_file() {
    let (mut c, h) = fake_server(base_fs(), usize::MAX, 50);
    c.init().unwrap();
    let data = pattern(CHUNK as usize * 200);
    let cancel = AtomicBool::new(false);
    let mut acked = 0u64;
    let e = c
        .upload(&mut &data[..], "/home/u/part.bin", true, &cancel, &mut |n| {
            acked += n;
            if acked > CHUNK as u64 * 10 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
    assert_eq!(e, E_CANCEL);
    // El canal sigue sano tras cancelar.
    assert!(c.stat("/home/u/part.bin").unwrap().is_none());
    drop(c);
    assert!(!h.join().unwrap().contains_key("/home/u/part.bin"));
}

#[test]
fn mkdir_rename_remove_tree() {
    let (mut c, h) = fake_server(base_fs(), usize::MAX, 1);
    c.init().unwrap();
    c.mkdir("/home/u/nueva carpeta").unwrap();
    c.upload(&mut &b"1"[..], "/home/u/nueva carpeta/año «1».txt", false, &AtomicBool::new(false), &mut |_| {}).unwrap();
    c.mkdir("/home/u/nueva carpeta/sub").unwrap();
    c.upload(&mut &b"2"[..], "/home/u/nueva carpeta/sub/x", false, &AtomicBool::new(false), &mut |_| {}).unwrap();
    c.rename("/home/u/docs/a b.txt", "/home/u/docs/c'd.txt").unwrap();
    let mut n = 0;
    c.remove_tree("/home/u/nueva carpeta", &mut n).unwrap();
    assert_eq!(n, 3);
    drop(c);
    let fs = h.join().unwrap();
    assert!(!fs.keys().any(|k| k.starts_with("/home/u/nueva")));
    assert!(fs.contains_key("/home/u/docs/c'd.txt"));
}

#[test]
fn pure_paths() {
    assert_eq!(join("/", "a"), "/a");
    assert_eq!(join("/home/u", "a b"), "/home/u/a b");
    assert_eq!(expand_home("", "/h"), "/h");
    assert_eq!(expand_home("~", "/h"), "/h");
    assert_eq!(expand_home("~/x y", "/h"), "/h/x y");
    assert_eq!(expand_home(" /etc ", "/h"), "/etc");
    assert!(valid_name("año «1».txt"));
    assert!(!valid_name("a/b") && !valid_name("..") && !valid_name("") && !valid_name("a\0"));
    assert_eq!(local_name("a:b?.txt"), "a_b_.txt");
    assert_eq!(local_name("con.txt"), "_con.txt");
    assert_eq!(local_name("x. "), "x");
    let taken = ["/d/f.txt", "/d/f (1).txt"];
    let p = unique_local(Path::new("/d"), "f.txt", &|p| taken.iter().any(|t| Path::new(t) == p));
    assert_eq!(p, Path::new("/d").join("f (2).txt"));
    let p = unique_local(Path::new("/d"), ".bashrc", &|p| p == Path::new("/d").join(".bashrc"));
    assert_eq!(p, Path::new("/d").join(".bashrc (1)"));
}

#[test]
fn ssh_args_use_subsystem_and_keep_security_options() {
    let d = Dest { user: Some("u".into()), host: "h.example".into(), port: 2222, jump: Some("j@bastion".into()), secret_key: Some("host:1".into()), ..Default::default() };
    let a = sftp_args(&d);
    let dd = a.iter().position(|x| x == "--").unwrap();
    assert_eq!(a[dd - 1], "-s");
    assert_eq!(&a[dd + 1..], ["u@h.example", "sftp"]);
    assert!(a.windows(2).any(|w| w[0] == "-o" && w[1] == "StrictHostKeyChecking=yes"));
    assert!(a.windows(2).any(|w| w[0] == "-J" && w[1] == "j@bastion"));
    assert!(a.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"));
    // El secreto nunca va en los argumentos.
    assert!(!a.iter().any(|x| x.contains("host:1")));
    assert!(ssh_error("Host key verification failed.", Some(255)).starts_with(E_HOSTKEY));
    assert!(ssh_error("u@h: Permission denied (publickey).", Some(255)).starts_with(E_AUTH));
    assert!(ssh_error("ssh: connect to host h port 22: Connection refused", Some(255)).starts_with(E_NET));
    assert_eq!(ssh_error("subsystem request failed on channel 0", Some(1)), "SFTP is not enabled on this server");
}

#[test]
fn walk_local_tree() {
    let root = std::env::temp_dir().join(format!("orch-sftp-walk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("a/b")).unwrap();
    std::fs::write(root.join("x.txt"), b"12").unwrap();
    std::fs::write(root.join("a/b/y"), b"345").unwrap();
    let (mut files, dirs) = walk_local(&root).unwrap();
    files.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(dirs, ["a", "a/b"]);
    assert_eq!(files.iter().map(|f| (f.1.as_str(), f.2)).collect::<Vec<_>>(), [("a/b/y", 3), ("x.txt", 2)]);
    let _ = std::fs::remove_dir_all(&root);
}

/// Prueba contra un servidor REAL con el `ssh` del sistema. `ORCH_SFTP_TEST=usuario@host:puerto:ruta_clave`.
/// Lista, sube 50 MB con progreso, cancela una subida, descarga y compara bytes, renombra, borra, carpeta nueva y
/// nombres con espacios y acentos.
#[test]
#[ignore]
fn real_server() {
    let spec = std::env::var("ORCH_SFTP_TEST").expect("ORCH_SFTP_TEST");
    let mut it = spec.splitn(4, ':');
    let (uh, port, key) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap().to_string() + &it.next().map(|r| format!(":{r}")).unwrap_or_default());
    let (user, host) = uh.split_once('@').unwrap();
    let d = Dest { user: Some(user.into()), host: host.into(), port: port.parse().unwrap(), identity: Some(key), identities_only: true, ..Default::default() };
    let t0 = Instant::now();
    let mut c = Conn::open(&d).expect("open");
    eprintln!("conectado en {:?}; home={}", t0.elapsed(), c.home);
    let root = join(&c.home, "orch test ñandú");
    let mut n = 0;
    let _ = c.cli.remove_tree(&root, &mut n);
    c.cli.mkdir(&root).unwrap();
    let local = std::env::temp_dir().join("orch-sftp-50m.bin");
    let data = pattern(50 * 1024 * 1024 + 17);
    std::fs::write(&local, &data).unwrap();
    let cancel = AtomicBool::new(false);
    let mut events = 0;
    let t = Instant::now();
    run_upload(&mut c, &local, &root, "grande año.bin", false, &cancel, &mut |_| events += 1, "t1").unwrap();
    let up = t.elapsed();
    eprintln!("subida 50 MB en {:?} ({:.1} MB/s), {events} avisos de progreso", up, 50.0 / up.as_secs_f64());
    assert!(events > 3);
    // Cancelar a mitad.
    let cancel2 = AtomicBool::new(false);
    let mut seen = 0u64;
    let e = {
        let mut f = std::fs::File::open(&local).unwrap();
        c.cli.upload(&mut f, &join(&root, "cancelada.bin"), true, &cancel2, &mut |k| {
            seen += k;
            if seen > 5 * 1024 * 1024 {
                cancel2.store(true, Ordering::Relaxed);
            }
        })
    };
    assert_eq!(e.unwrap_err(), E_CANCEL);
    assert!(c.cli.stat(&join(&root, "cancelada.bin")).unwrap().is_none(), "lo parcial se borra");
    // Descargar y comparar.
    let ddir = std::env::temp_dir().join("orch-sftp-dl");
    let _ = std::fs::remove_dir_all(&ddir);
    let t = Instant::now();
    let p = run_download(&mut c, &join(&root, "grande año.bin"), &ddir, &cancel, &mut |_| {}, "t2").unwrap();
    eprintln!("bajada 50 MB en {:?}", t.elapsed());
    assert!(std::fs::read(&p).unwrap() == data);
    // Operaciones.
    c.cli.mkdir(&join(&root, "carpeta nueva")).unwrap();
    c.cli.rename(&join(&root, "grande año.bin"), &join(&root, "carpeta nueva/renombrado 'con' comillas.bin")).unwrap();
    let ls = c.cli.readdir(&join(&root, "carpeta nueva")).unwrap();
    assert_eq!(ls.len(), 1);
    assert_eq!(ls[0].name, "renombrado 'con' comillas.bin");
    assert_eq!(ls[0].size, data.len() as u64);
    let mut n = 0;
    c.cli.remove_tree(&root, &mut n).unwrap();
    assert!(c.cli.stat(&root).unwrap().is_none());
    // Lo mismo que hacen los comandos de Tauri (gestor + hilo + cancelar desde otro hilo), sin AppHandle.
    let m = Arc::new(Manager::default());
    let events = Arc::new(Mutex::new(Vec::<Progress>::new()));
    let (ev2, local2, root2) = (events.clone(), local.clone(), root.clone());
    let fin = run_xfer(&m, "x1", &d, Box::new(move |c, cancel, emit| {
        c.cli.mkdir(&root2)?;
        run_upload(c, &local2, &root2, "por gestor.bin", false, cancel, emit, "x1").map(|_| None)
    }), &|p| ev2.lock().push(p.clone()));
    assert_eq!(fin.state, "done", "{:?}", fin.error);
    assert_eq!(fin.done, data.len() as u64);
    assert!(events.lock().len() > 3);
    let m2 = m.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        m2.cancel("x2");
    });
    let local3 = local.clone();
    let root3 = root.clone();
    let fin = run_xfer(&m, "x2", &d, Box::new(move |c, cancel, emit| run_upload(c, &local3, &root3, "cancelada2.bin", false, cancel, emit, "x2").map(|_| None)), &|_| {});
    canceller.join().unwrap();
    assert_eq!(fin.state, "cancelled");
    assert!(m.xfers.lock().is_empty());
    let mut c = Conn::open(&d).unwrap();
    assert!(c.cli.stat(&join(&root, "cancelada2.bin")).unwrap().is_none());
    let mut n = 0;
    c.cli.remove_tree(&root, &mut n).unwrap();
    // Negativo: un destino sin servidor da error legible (no cuelga).
    let bad = Dest { port: 1, ..d.clone() };
    let fin = run_xfer(&m, "x3", &bad, Box::new(|_, _, _| Ok(None)), &|_| {});
    assert_eq!(fin.state, "error");
    assert!(fin.error.as_deref().unwrap_or("").starts_with(E_NET), "{:?}", fin.error);
    let _ = std::fs::remove_file(&local);
    let _ = std::fs::remove_dir_all(&ddir);
}
