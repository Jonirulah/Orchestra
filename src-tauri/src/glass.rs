//! Transparencia de la ventana (Ajustes → General → Opacidad / Efecto), como en Windows Terminal.
//!
//! Por defecto la ventana es opaca y no se toca nada: la ventana se crea SIN `transparent` en
//! tauri.conf.json. Al pedir cristal (opacidad < 100 %) se hace en vivo lo mismo que hace tao con
//! `transparent: true` al crear la ventana:
//!   1. DWM con «blur behind» y una región vacía: la ventana pasa a componerse con alfa por píxel
//!      (lo que la página pinte con alfa deja ver el escritorio).
//!   2. Fondo por defecto del WebView2 a (0,0,0,0): lo que la página no pinta queda transparente.
//!   3. Opcional: fondo del sistema (Acrílico o Mica) con window-vibrancy. Mica solo existe en
//!      Windows 11: si falla se prueba Acrílico y, si tampoco, se queda sin efecto.
//! Al volver a opaco se deshace todo y el fondo vuelve al color de tauri.conf.json.
//! La opacidad en sí la pone la página (variables CSS en store.applyAppearance): aquí solo el cristal.

/// Efecto pedido por la interfaz (el valor del ajuste `windowEffect`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    None,
    Acrylic,
    Mica,
}

impl Effect {
    pub fn parse(s: &str) -> Effect {
        match s {
            "acrylic" => Effect::Acrylic,
            "mica" => Effect::Mica,
            _ => Effect::None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Effect::None => "none",
            Effect::Acrylic => "acrylic",
            Effect::Mica => "mica",
        }
    }
}

/// Lo que se intenta, en orden, para un efecto pedido (el primero que funcione se queda).
pub fn fallback_chain(e: Effect) -> &'static [Effect] {
    match e {
        Effect::Mica => &[Effect::Mica, Effect::Acrylic],
        Effect::Acrylic => &[Effect::Acrylic],
        Effect::None => &[],
    }
}

/// Fondo de la ventana opaca (el `backgroundColor` de tauri.conf.json).
#[cfg(windows)]
const OPAQUE_BG: tauri::window::Color = tauri::window::Color(0x0d, 0x0f, 0x12, 255);

/// Pone o quita el cristal. Devuelve el efecto que ha quedado puesto ("none" | "acrylic" | "mica").
#[tauri::command]
pub fn set_window_glass(window: tauri::WebviewWindow, glass: bool, effect: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        apply(&window, glass, Effect::parse(&effect)).map(|e| e.as_str().to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, glass, effect);
        Ok("none".into())
    }
}

#[cfg(windows)]
fn apply(window: &tauri::WebviewWindow, glass: bool, effect: Effect) -> Result<Effect, String> {
    use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_mica};

    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd = windows::Win32::Foundation::HWND(hwnd.0 as _);
    // Quitar siempre el efecto anterior (en Windows 11 22H2+ los dos son el mismo atributo de DWM).
    let _ = clear_mica(window);
    let _ = clear_acrylic(window);
    if !glass {
        blur_behind(hwnd, false);
        window.set_background_color(Some(OPAQUE_BG)).map_err(|e| e.to_string())?;
        return Ok(Effect::None);
    }
    // Alfa 0: la capa del WebView2 queda transparente; la de la ventana ignora el alfa y pinta negro,
    // que con «blur behind» DWM toma como transparente.
    window
        .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
        .map_err(|e| e.to_string())?;
    blur_behind(hwnd, true);
    for &e in fallback_chain(effect) {
        let ok = match e {
            Effect::Mica => apply_mica(window, Some(true)).is_ok(),
            // El color solo cuenta en Windows 10 (en 11 lo ignora el fondo del sistema): un tinte suave del fondo.
            Effect::Acrylic => apply_acrylic(window, Some((13, 15, 18, 40))).is_ok(),
            Effect::None => true,
        };
        if ok {
            return Ok(e);
        }
    }
    Ok(Effect::None)
}

/// DwmEnableBlurBehindWindow con región vacía: activa (o quita) la composición con alfa por píxel sin desenfoque.
#[cfg(windows)]
fn blur_behind(hwnd: windows::Win32::Foundation::HWND, on: bool) {
    use windows::Win32::Graphics::Dwm::{DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND};
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject};
    unsafe {
        let region = if on { CreateRectRgn(0, 0, -1, -1) } else { Default::default() };
        let bb = DWM_BLURBEHIND {
            dwFlags: if on { DWM_BB_ENABLE | DWM_BB_BLURREGION } else { DWM_BB_ENABLE },
            fEnable: on.into(),
            hRgnBlur: region,
            fTransitionOnMaximized: false.into(),
        };
        let _ = DwmEnableBlurBehindWindow(hwnd, &bb);
        if on {
            let _ = DeleteObject(region.into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ida_y_vuelta() {
        for e in [Effect::None, Effect::Acrylic, Effect::Mica] {
            assert_eq!(Effect::parse(e.as_str()), e);
        }
        assert_eq!(Effect::parse("blur"), Effect::None);
        assert_eq!(Effect::parse(""), Effect::None);
    }

    #[test]
    fn mica_cae_a_acrilico() {
        assert_eq!(fallback_chain(Effect::Mica), &[Effect::Mica, Effect::Acrylic]);
        assert_eq!(fallback_chain(Effect::Acrylic), &[Effect::Acrylic]);
        assert!(fallback_chain(Effect::None).is_empty());
    }
}
