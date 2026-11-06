//! Lector mínimo de `~/.ssh/config`: devuelve los alias concretos (sin comodines)
//! con los campos que la interfaz necesita para mostrarlos. La conexión real la hace
//! siempre `ssh` del sistema, que ya sabe leer su propia configuración.

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    /// ProxyCommand (se conserva solo para saber que el host no es alcanzable directamente: la insignia de latencia no lo mide).
    pub proxy_command: Option<String>,
}

fn split_kv(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let idx = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..idx].to_ascii_lowercase();
    let rest = line[idx..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    let val = rest.trim().trim_matches('"').to_string();
    if val.is_empty() {
        return None;
    }
    Some((key, val))
}

pub fn parse(text: &str) -> Vec<SshHost> {
    let mut hosts: Vec<SshHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let Some((key, val)) = split_kv(raw) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in val.split_whitespace() {
                    if alias.contains(['*', '?', '!']) {
                        continue;
                    }
                    hosts.push(SshHost {
                        alias: alias.to_string(),
                        ..Default::default()
                    });
                    current.push(hosts.len() - 1);
                }
            }
            "match" => current.clear(),
            "hostname" | "user" | "port" | "identityfile" | "proxyjump" | "proxycommand" => {
                for &i in &current {
                    let h = &mut hosts[i];
                    match key.as_str() {
                        "hostname" => h.hostname.get_or_insert_with(|| val.clone()),
                        "user" => h.user.get_or_insert_with(|| val.clone()),
                        "identityfile" => h.identity_file.get_or_insert_with(|| val.clone()),
                        "proxyjump" => h.proxy_jump.get_or_insert_with(|| val.clone()),
                        "proxycommand" => h.proxy_command.get_or_insert_with(|| val.clone()),
                        _ => {
                            if h.port.is_none() {
                                h.port = val.parse().ok();
                            }
                            continue;
                        }
                    };
                }
            }
            _ => {}
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsea_alias_y_campos() {
        let cfg = r#"
# comentario
Host *
    ServerAliveInterval 30

Host prod web1 web2
    HostName 10.0.0.5
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_prod
    ProxyJump bastion

Host bastion
    HostName=bastion.example.com
    User ops

Host *.interno !secreto
    User nadie

Match host algo
    User ignorado
"#;
        let h = parse(cfg);
        let nombres: Vec<_> = h.iter().map(|x| x.alias.as_str()).collect();
        assert_eq!(nombres, ["prod", "web1", "web2", "bastion"]);
        assert_eq!(h[0].hostname.as_deref(), Some("10.0.0.5"));
        assert_eq!(h[0].port, Some(2222));
        assert_eq!(h[0].proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(h[1].user.as_deref(), Some("deploy"));
        assert_eq!(h[3].hostname.as_deref(), Some("bastion.example.com"));
        assert_eq!(h[3].user.as_deref(), Some("ops"));
    }

    #[test]
    fn proxycommand_se_conserva() {
        let h = parse("Host viaprox\n    HostName 10.1.1.1\n    ProxyCommand nc -X 5 -x proxy:1080 %h %p\nHost directo\n    HostName 10.1.1.2\n");
        assert_eq!(h[0].proxy_command.as_deref(), Some("nc -X 5 -x proxy:1080 %h %p"));
        assert_eq!(h[1].proxy_command, None);
    }

    #[test]
    fn vacio() {
        assert!(parse("").is_empty());
        assert!(parse("# solo comentarios\n\n").is_empty());
    }
}
