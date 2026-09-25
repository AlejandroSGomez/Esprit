# Validación de la edición compartible 0.1.0

Comprobada el 25 de septiembre de 2026 en macOS, Apple Silicon.

- Rust: 140 pruebas superadas, incluidas configuración, rutas confinadas,
  contratos de Login/Logout/Radar y Viajes opcional.
- Python: 105 pruebas de los puentes superadas con datos ficticios.
- Node: 23 pruebas de interfaz superadas; escenarios simulados de Mail.app
  también superados.
- ESLint, TypeScript, exportación estática Next.js y compilación Tauri de macOS:
  correctos. Rust conserva dos avisos de parámetros sin usar en el radar.
- Bundle `es.asgomez.esprit`, versión 0.1.0, firma local ad hoc verificada.
- Arranque nativo sin configuración: muestra «Configuración pendiente».
- Prueba aislada con configuración temporal: acepta todos los módulos apagados
  y Viajes opcional; rechaza rutas que salen del workspace y config ausente.
- Revisión visual del modo de demostración, incluido Viajes vacío en tema oscuro.
- Enlaces de documentación comprobados y revisión del contenido distribuible
  para excluir datos, proyectos y credenciales personales.

No se han consultado cuentas reales ni ejecutado un Login/Logout, envíos, SSH o
escrituras de calendario como prueba. Falta la primera instalación acompañada
en el Mac de otra persona y validar sus integraciones con su consentimiento.
Esta versión es una beta para los primeros usuarios; esas comprobaciones locales
no garantizan compatibilidad con todos los entornos y permisos de macOS.

Para repetir la prueba aislada después de compilar:

```sh
python3 scripts/smoke_config.py src-tauri/target/release/bundle/macos/Esprit.app/Contents/MacOS/esprit
```

Los comandos de pruebas están en [NATIVE_APP.md](NATIVE_APP.md).
