//! AppKit's Dock Quit calls `terminate:` directly, bypassing Tauri's cancellable
//! ExitRequested event. Add the missing delegate decision, preserving Tao's
//! delegate and its other methods. Only the existing close/flush handshake may
//! authorize destruction; no history is written from Objective-C callbacks.

use objc2::{
    class, ffi, msg_send,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "C-unwind" fn should_terminate(
    _delegate: *mut AnyObject,
    _selector: Sel,
    _application: *mut AnyObject,
) -> usize {
    // Never let a Rust panic unwind through AppKit or accidentally permit quit.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(app) = APP.get() else { return 0 };
        let approved = app
            .state::<super::NativeCloseGuard>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .approved;
        if approved || app.webview_windows().is_empty() {
            return 1;
        }
        for label in app.webview_windows().keys() {
            if let Err(error) = super::request_esprit_close(app, label) {
                eprintln!("{error}");
            }
        }
        // NSTerminateCancel returns to the normal event loop. NSTerminateLater
        // enters NSModalPanelRunLoopMode and can starve our WebView IPC. The
        // completed handshake destroys the window and exits through Tauri.
        0
    }))
    .unwrap_or(0)
}

/// Call once on the main thread during Tauri setup, after Tao sets its delegate.
pub fn install(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    unsafe {
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![application, delegate];
        let delegate = delegate
            .as_ref()
            .ok_or("Falta el delegado de la aplicación macOS")?;
        install_on_class(delegate.class())?;
        APP.set(app)
            .map_err(|_| "El cierre macOS ya estaba instalado")?;
    }
    Ok(())
}

unsafe fn install_on_class(class: &AnyClass) -> Result<(), &'static str> {
    let selector = sel!(applicationShouldTerminate:);
    // A dependency change must be reviewed instead of overwriting a new native
    // delegate policy. Current Tao has no implementation of this selector.
    if class.instance_method(selector).is_some() {
        return Err("El delegado ya tiene una política de cierre; revisa la integración de macOS");
    }
    let implementation: Imp = std::mem::transmute(
        should_terminate
            as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
    );
    if !ffi::class_addMethod(
        class as *const AnyClass as *mut AnyClass,
        selector,
        implementation,
        c"Q@:@".as_ptr(), // NSUInteger, self, selector, NSApplication* (64-bit macOS)
    )
    .as_bool()
    {
        return Err("No se pudo instalar el guardado antes de salir desde macOS");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::ClassBuilder;

    #[test]
    fn appkit_delegate_gate_installs_without_replacing_other_methods() {
        let builder = ClassBuilder::new(c"EspritTerminationGuardTest", class!(NSObject)).unwrap();
        let class = builder.register();
        unsafe {
            install_on_class(class).unwrap();
            let object: *mut AnyObject = msg_send![class, new];
            let reply: usize =
                msg_send![object, applicationShouldTerminate: std::ptr::null_mut::<AnyObject>()];
            assert_eq!(
                reply, 0,
                "without an armed app, termination must be cancelled"
            );
            assert!(class.instance_method(sel!(description)).is_some());
            assert!(
                install_on_class(class).is_err(),
                "never overwrite a delegate policy"
            );
            let _: () = msg_send![object, release];
        }
    }
}
