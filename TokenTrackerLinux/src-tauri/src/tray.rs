use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager};

const OPEN_ID: &str = "open-dashboard";
const SILENT_ID: &str = "silent-start";
const QUIT_ID: &str = "quit";
const FALLBACK_TRAY_ICON: &[u8] = include_bytes!("../icons/icon.png");

fn fallback_tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(FALLBACK_TRAY_ICON)
}

/// Install the tray icon.
///
/// **Menu-only by design.** There is deliberately no `on_tray_icon_event`
/// click handler: on Linux `tray-icon`'s GTK/libappindicator backend never
/// calls `TrayIconEvent::send` (its `platform_impl/gtk/mod.rs` contains no
/// event code at all), so `TrayIconEvent::Click` is never emitted. Both Tauri
/// and `tray-icon` document this as "**Linux**: Unsupported. The event is not
/// emitted even though the icon is shown". A left-click handler here would
/// compile and look functional while never running.
///
/// The upside is that libappindicator opens the context menu on *left* click
/// too, so "Open Dashboard" as the first item is the primary entry point.
pub fn install(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Dashboard", true, None::<&str>)?;
    let silent_start = crate::settings::silent_start();
    let silent = CheckMenuItem::with_id(
        app,
        SILENT_ID,
        "Silent Start",
        true,
        silent_start,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &silent, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or(fallback_tray_icon()?);

    let silent_handle = silent.clone();
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("TokenTracker")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            OPEN_ID => show_main_window(app),
            SILENT_ID => {
                // Derive the new value from the persisted state (not from the
                // item's checked state) so AppIndicator's auto-toggle timing
                // can't desync us; set_checked re-asserts the target state.
                let value = !crate::settings::silent_start();
                crate::settings::set_silent_start(value);
                let _ = silent_handle.set_checked(value);
            }
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::fallback_tray_icon;

    #[test]
    fn embedded_fallback_icon_has_non_zero_dimensions() {
        let icon = fallback_tray_icon().expect("embedded fallback icon must decode");

        assert!(icon.width() > 0);
        assert!(icon.height() > 0);
    }
}
