#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod agents;
mod commands;
mod git;
mod history;
mod hostkey;
mod idle;
mod mcp;
mod mcp_exec;
mod metrics;
mod net;
mod providers;
mod pty;
mod quota;
mod remote_metrics;
mod shells;
mod sshcfg;
mod store;
mod subtranscript;
mod tokens;
mod usage_query;
mod vault;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

pub struct Prefs {
    pub close_to_tray: AtomicBool,
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Textos por defecto (inglés) del menú de la bandeja; el frontend los cambia con `set_tray_labels`.
const TRAY_SHOW: &str = "Show Orchestra";
const TRAY_QUIT: &str = "Quit (closes all terminals)";

fn tray_menu(app: &AppHandle, show: &str, quit: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", show, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

/// Cambia los textos del menú de la bandeja (idioma de la interfaz). Los ids de los items no cambian.
#[tauri::command]
fn set_tray_labels(app: AppHandle, show: String, quit: String) -> Result<(), String> {
    let menu = tray_menu(&app, &show, &quit).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    // ssh invoca este exe como SSH_ASKPASS: imprime el secreto y sale, sin abrir ventana.
    {
        let args: Vec<String> = std::env::args().collect();
        if vault::is_askpass_invocation(&args) {
            std::process::exit(vault::run_askpass(&args));
        }
    }
    tauri::Builder::default()
        .manage(pty::PtyManager::default())
        .manage(Prefs {
            close_to_tray: AtomicBool::new(true),
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_attach,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_close,
            commands::pty_list,
            commands::detect_shells,
            commands::ssh_config_hosts,
            commands::home_dir,
            commands::open_url,
            net::net_ping,
            git::git_info,
            git::git_available,
            commands::set_close_to_tray,
            set_tray_labels,
            vault::secret_set,
            vault::secret_exists,
            vault::secret_delete,
            vault::secret_copy,
            vault::ssh_keys_list,
            vault::ssh_keygen,
            vault::ssh_key_reveal,
            vault::ssh_key_forget_passphrase,
            hostkey::hostkey_probe,
            hostkey::hostkey_trust,
            agents::agent_scan,
            agents::claude_session_exists,
            subtranscript::agent_transcript,
            idle::system_idle_seconds,
            accounts::claude_profiles,
            accounts::prepare_claude_dir,
            providers::provider_detect,
            providers::provider_prepare,
            providers::provider_status,
            quota::quota_prepare,
            quota::quota_read,
            usage_query::usage_fetch,
            store::load_state,
            store::save_state,
            store::data_dir,
            store::open_data_dir,
            store::open_account_dir,
            mcp::mcp_configure,
            mcp::mcp_info,
            mcp::mcp_token,
            mcp::mcp_regenerate_token,
            mcp::mcp_sync,
            mcp::mcp_audit,
            mcp::mcp_approval_answer,
            metrics::metrics_sample,
            metrics::metrics_reset,
            metrics::metrics_history,
            remote_metrics::rmetrics_start,
            remote_metrics::rmetrics_stop,
            remote_metrics::rmetrics_sample,
            remote_metrics::rmetrics_hidden,
            remote_metrics::rmetrics_history,
        ])
        .setup(|app| {
            app.manage(mcp::McpManager::new(app.handle()));
            let rm = remote_metrics::Manager::new(std::sync::Arc::new(remote_metrics::SshLauncher), Default::default());
            remote_metrics::spawn_reaper(&rm);
            app.manage(rm);
            let menu = tray_menu(app.handle(), TRAY_SHOW, TRAY_QUIT)?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Orchestra")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cerrar con la X no mata las sesiones: la ventana se oculta a la bandeja.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let prefs = window.state::<Prefs>();
                let ptys = window.state::<pty::PtyManager>();
                if prefs.close_to_tray.load(Ordering::Relaxed) && ptys.has_live() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error building Orchestra")
        .run(|app, event| {
            // Al salir, el servidor MCP se para y claude-mcp.json deja de apuntar a un puerto muerto.
            if let tauri::RunEvent::Exit = event {
                if let Some(m) = app.try_state::<mcp::McpManager>() {
                    m.shutdown();
                }
                if let Some(m) = app.try_state::<std::sync::Arc<remote_metrics::Manager>>() {
                    m.shutdown();
                }
            }
        });
}
